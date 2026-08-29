// Custom SVG viewBox-based pan/zoom (no external dependency, per DESIGN.md).
// Ctrl/Cmd+wheel zooms centered on the cursor; plain wheel pans; drag pans.

export interface ViewState {
  /** Logical x/y of the viewBox's top-left corner. */
  x: number;
  y: number;
  /** 1 = one logical unit per CSS pixel. */
  scale: number;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;

export class PanZoomController {
  private view: ViewState = { x: 0, y: 0, scale: 1 };
  private dragging = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  // pointermove can fire far more often than the browser can repaint the
  // SVG (especially a large graph, or a high-poll-rate mouse/trackpad), so
  // writing the viewBox synchronously on every event makes dragging janky.
  // Coalesce moves into at most one viewBox update per animation frame.
  private pendingPointerX: number | null = null;
  private pendingPointerY: number | null = null;
  private dragRafHandle: number | null = null;
  // Lets the minimap keep its viewport rectangle in sync without polling —
  // notified on every `apply()`, which every pan/zoom/centerOn goes through.
  private changeListeners: Array<() => void> = [];
  // Retries a `whenSized` call once the container has a real (non-zero)
  // size. Needed because `centerOn` can run right after a re-render before
  // the container has been laid out yet -- normally fast enough to not
  // matter, but a slow extension-host round trip (e.g. filter changes over
  // Remote-SSH) makes the race far more likely to lose.
  private sizeRetryRafHandle: number | null = null;
  // Without this, resizing the container (e.g. the panel's split changing
  // width) left the SVG's viewBox holding the old clientWidth/clientHeight
  // until the next pan/zoom/centerOn recomputed it -- the graph would look
  // wrongly cropped or zoomed in the meantime.
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly container: HTMLElement,
    private readonly svg: SVGSVGElement,
  ) {
    container.style.cursor = 'grab';
    container.style.touchAction = 'none';
    container.addEventListener('wheel', this.onWheel, { passive: false });
    container.addEventListener('pointerdown', this.onPointerDown);
    // Listen on window, not the container, and skip setPointerCapture:
    // capture proved unreliable in VSCode's webview (drag would stop
    // responding after the first gesture). window-level listeners still
    // track the drag correctly even if the cursor leaves the container.
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);

    this.resizeObserver = new ResizeObserver(() => this.apply());
    this.resizeObserver.observe(container);
  }

  /** Resets zoom to 1:1 and centers the viewport on a logical point. */
  centerOn(logicalX: number, logicalY: number): void {
    this.whenSized(() => {
      this.view = {
        scale: 1,
        x: logicalX - this.container.clientWidth / 2,
        y: logicalY - this.container.clientHeight / 2,
      };
      this.apply();
    });
  }

  /**
   * Runs `fn` once the container has a real size, retrying on the next
   * animation frame otherwise. Without this, reading a zero clientWidth/
   * clientHeight (container not laid out yet) bakes a wrong, off-center
   * view into `this.view` that a later resize never corrects on its own.
   */
  private whenSized(fn: () => void): void {
    if (this.sizeRetryRafHandle !== null) {
      cancelAnimationFrame(this.sizeRetryRafHandle);
      this.sizeRetryRafHandle = null;
    }
    if (this.container.clientWidth > 0 && this.container.clientHeight > 0) {
      fn();
      return;
    }
    this.sizeRetryRafHandle = requestAnimationFrame(() => {
      this.sizeRetryRafHandle = null;
      this.whenSized(fn);
    });
  }

  /**
   * Resets zoom to 1:1, horizontally centers on a logical point, and aligns
   * the viewport's top edge with `topY` instead of vertically centering.
   * Used when the focused node has no history above it (e.g. the current
   * branch is already up to date) — vertically centering it would leave a
   * band of empty space above the top of the graph, which looks broken.
   */
  centerOnTop(logicalX: number, topY: number): void {
    this.whenSized(() => {
      this.view = { scale: 1, x: logicalX - this.container.clientWidth / 2, y: topY };
      this.apply();
    });
  }

  /** Centers the viewport on a logical point without changing zoom — used by the minimap. */
  panTo(logicalX: number, logicalY: number): void {
    const width = this.container.clientWidth / this.view.scale;
    const height = this.container.clientHeight / this.view.scale;
    this.view = { ...this.view, x: logicalX - width / 2, y: logicalY - height / 2 };
    this.apply();
  }

  /** The currently visible region, in the graph's logical coordinate space. */
  getViewBox(): { x: number; y: number; width: number; height: number } {
    return {
      x: this.view.x,
      y: this.view.y,
      width: this.container.clientWidth / this.view.scale,
      height: this.container.clientHeight / this.view.scale,
    };
  }

  /** The raw pan/zoom state, for carrying it over to a new controller (e.g. across a re-render) via `setView`. */
  getView(): ViewState {
    return { ...this.view };
  }

  /** Restores a previously-saved view exactly, no clamping/recentering. */
  setView(view: ViewState): void {
    this.view = { ...view };
    this.apply();
  }

  /** Fires after every pan/zoom change. Returns a function to unsubscribe. */
  onChange(listener: () => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== listener);
    };
  }

  private apply(): void {
    const { clientWidth, clientHeight } = this.container;
    // A zero-size container (not laid out yet) would otherwise bake a
    // degenerate 0x0 viewBox into the SVG, rendering nothing at all.
    if (clientWidth === 0 || clientHeight === 0) return;
    const width = clientWidth / this.view.scale;
    const height = clientHeight / this.view.scale;
    this.svg.setAttribute('viewBox', `${this.view.x} ${this.view.y} ${width} ${height}`);
    for (const listener of this.changeListeners) listener();
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();

    if (!event.ctrlKey && !event.metaKey) {
      this.view = {
        ...this.view,
        x: this.view.x + event.deltaX / this.view.scale,
        y: this.view.y + event.deltaY / this.view.scale,
      };
      this.apply();
      return;
    }

    const rect = this.container.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;

    // Logical coordinate under the cursor, kept fixed across the zoom.
    const beforeX = this.view.x + pointerX / this.view.scale;
    const beforeY = this.view.y + pointerY / this.view.scale;

    const zoomFactor = Math.exp(-event.deltaY * 0.001);
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.view.scale * zoomFactor));

    this.view = {
      scale: newScale,
      x: beforeX - pointerX / newScale,
      y: beforeY - pointerY / newScale,
    };
    this.apply();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    this.dragging = true;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.container.style.cursor = 'grabbing';
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.pendingPointerX = event.clientX;
    this.pendingPointerY = event.clientY;
    if (this.dragRafHandle === null) {
      this.dragRafHandle = requestAnimationFrame(this.applyPendingDrag);
    }
  };

  private readonly applyPendingDrag = (): void => {
    this.dragRafHandle = null;
    if (this.pendingPointerX === null || this.pendingPointerY === null) return;

    const dx = this.pendingPointerX - this.lastPointerX;
    const dy = this.pendingPointerY - this.lastPointerY;
    this.lastPointerX = this.pendingPointerX;
    this.lastPointerY = this.pendingPointerY;

    this.view = {
      ...this.view,
      x: this.view.x - dx / this.view.scale,
      y: this.view.y - dy / this.view.scale,
    };
    this.apply();
  };

  private readonly onPointerUp = (): void => {
    this.dragging = false;
    this.container.style.cursor = 'grab';
    if (this.dragRafHandle !== null) {
      cancelAnimationFrame(this.dragRafHandle);
      this.dragRafHandle = null;
    }
    this.pendingPointerX = null;
    this.pendingPointerY = null;
  };

  /**
   * Removes all listeners. Each render creates a new controller for the new
   * SVG element, so the caller must destroy the previous one — otherwise
   * the window-level listeners pile up across re-renders and keep fighting
   * over (and repainting) an SVG that's no longer even in the DOM.
   */
  destroy(): void {
    this.resizeObserver.disconnect();
    this.container.removeEventListener('wheel', this.onWheel);
    this.container.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    if (this.dragRafHandle !== null) {
      cancelAnimationFrame(this.dragRafHandle);
    }
    if (this.sizeRetryRafHandle !== null) {
      cancelAnimationFrame(this.sizeRetryRafHandle);
    }
    this.changeListeners = [];
  }
}
