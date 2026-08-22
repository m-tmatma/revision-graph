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
  }

  /** Resets zoom to 1:1 and centers the viewport on a logical point. */
  centerOn(logicalX: number, logicalY: number): void {
    this.view = {
      scale: 1,
      x: logicalX - this.container.clientWidth / 2,
      y: logicalY - this.container.clientHeight / 2,
    };
    this.apply();
  }

  private apply(): void {
    const width = this.container.clientWidth / this.view.scale;
    const height = this.container.clientHeight / this.view.scale;
    this.svg.setAttribute('viewBox', `${this.view.x} ${this.view.y} ${width} ${height}`);
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
    this.container.removeEventListener('wheel', this.onWheel);
    this.container.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    if (this.dragRafHandle !== null) {
      cancelAnimationFrame(this.dragRafHandle);
    }
  }
}
