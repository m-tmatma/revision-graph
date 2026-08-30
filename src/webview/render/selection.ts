// Node selection: click selects a single node, Ctrl/Cmd+click adds a second
// (for the "Compare" context-menu action). Selected nodes are
// highlighted by restyling their <rect> directly, per DESIGN.md's "選択"
// section.

const CLICK_DRAG_THRESHOLD_PX = 4;

export interface SelectionState {
  first: string | null;
  second: string | null;
}

export class SelectionController {
  private state: SelectionState = { first: null, second: null };
  private downX = 0;
  private downY = 0;
  private downTarget: Element | null = null;

  constructor(private readonly svg: SVGSVGElement) {
    svg.addEventListener('pointerdown', this.onPointerDown);
    // Listen on window, not the SVG: matches panZoom.ts's approach, and
    // makes sure a pointerup that lands outside the SVG (e.g. the cursor
    // slipped off it mid-drag) still gets seen.
    window.addEventListener('pointerup', this.onPointerUp);
  }

  getState(): SelectionState {
    return this.state;
  }

  /** Restores a selection carried over from a previous render (see main.ts's renderAndFocus). */
  setState(state: SelectionState): void {
    this.state = state;
    this.applyHighlight();
  }

  destroy(): void {
    this.svg.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.downX = event.clientX;
    this.downY = event.clientY;
    this.downTarget = event.target as Element;
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.downTarget) return;
    const downTarget = this.downTarget;
    this.downTarget = null;

    const movedDistance = Math.hypot(event.clientX - this.downX, event.clientY - this.downY);
    if (movedDistance > CLICK_DRAG_THRESHOLD_PX) return; // a pan/drag, not a click

    const group = downTarget.closest?.('[data-commit-id]') as SVGGElement | null;
    const commitId = group?.getAttribute('data-commit-id') ?? null;

    if (event.ctrlKey || event.metaKey) {
      if (commitId === null || commitId === this.state.first) return;
      this.state = this.state.first === null ? { first: commitId, second: null } : { ...this.state, second: commitId };
    } else {
      this.state = { first: commitId, second: null };
    }
    this.applyHighlight();
  };

  private applyHighlight(): void {
    this.svg.querySelectorAll<SVGGElement>('[data-commit-id]').forEach((group) => {
      const rect = group.querySelector('rect');
      if (!rect) return;
      const id = group.getAttribute('data-commit-id');
      const selected = id === this.state.first || id === this.state.second;
      rect.setAttribute('stroke', selected ? 'var(--vscode-focusBorder, #007fd4)' : 'var(--vscode-panel-border, #454545)');
      rect.setAttribute('stroke-width', selected ? '3' : '1');
    });
  }
}
