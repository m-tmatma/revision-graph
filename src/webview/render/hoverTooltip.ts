// A debounced, on-demand hover tooltip: after a short hover delay, requests
// text for whatever commit is under the cursor (the caller decides how --
// see `requestText`) and shows it anchored to the hovered element once the
// response arrives. Shared by the main graph (event-delegated over the SVG
// root, since a per-node listener for every one of potentially thousands
// of nodes would be wasteful) and the log sidebar (attached directly per
// row, matching that file's existing per-row listener style) so both get
// identical debounce/caching/positioning behavior and styling.
//
// Anchored to the hovered element's own position rather than following the
// cursor -- once shown, it stays put through small mouse movements within
// that same element, only moving when the hover target itself changes,
// matching how a native hover card behaves rather than dragging along with
// the pointer.
//
// The request is async and can arrive after the user has already moved on
// to a different commit (or none) -- `handleResponse` only shows the
// result if it's still relevant to whatever's currently hovered, and
// caches every response so re-hovering the same commit is instant.

const HOVER_DELAY_MS = 300;
const GAP_PX = 8;

export class HoverTooltipController {
  private readonly tooltipEl: HTMLDivElement;
  private readonly cache = new Map<string, string>();
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private currentCommitId: string | undefined;
  private currentTargetEl: Element | undefined;

  constructor(private readonly requestText: (commitId: string) => void) {
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'hover-tooltip';
    this.tooltipEl.setAttribute('role', 'tooltip');
    this.tooltipEl.hidden = true;
    document.body.appendChild(this.tooltipEl);
  }

  /**
   * Call when the cursor enters a new commit's element -- also called
   * again for the *same* commit after a re-render replaces the graph's
   * DOM wholesale (a new element for the same commitId): without
   * refreshing `currentTargetEl` here, it would keep pointing at the old,
   * now-detached element, whose `getBoundingClientRect()` is all zeros --
   * any later reposition (a still-visible tooltip, or a response that
   * arrives after the re-render) would jump to the top-left corner.
   */
  enter(commitId: string, targetEl: Element): void {
    if (commitId === this.currentCommitId) {
      this.currentTargetEl = targetEl;
      if (!this.tooltipEl.hidden) this.reposition(targetEl);
      return;
    }
    this.currentCommitId = commitId;
    this.currentTargetEl = targetEl;
    this.hide();
    clearTimeout(this.hoverTimer);

    const cached = this.cache.get(commitId);
    if (cached !== undefined) {
      this.show(cached);
      return;
    }
    this.hoverTimer = setTimeout(() => {
      if (this.currentCommitId === commitId) this.requestText(commitId);
    }, HOVER_DELAY_MS);
  }

  /** Call when the cursor leaves every commit (or the whole container). */
  leave(): void {
    this.currentCommitId = undefined;
    this.currentTargetEl = undefined;
    clearTimeout(this.hoverTimer);
    this.hide();
  }

  /** Call from the page's message handler when the host's response arrives. */
  handleResponse(commitId: string, text: string): void {
    this.cache.set(commitId, text);
    if (this.currentCommitId === commitId) {
      this.show(text);
    }
  }

  /**
   * Call from the page's message handler when the host's request failed.
   * Shown the same way a successful response is, but deliberately never
   * cached -- a transient git failure shouldn't stick around forever with
   * no way to retry short of reloading the whole webview.
   */
  handleError(commitId: string, message: string): void {
    if (this.currentCommitId === commitId) {
      this.show(message);
    }
  }

  destroy(): void {
    clearTimeout(this.hoverTimer);
    this.tooltipEl.remove();
  }

  private show(text: string): void {
    if (!this.currentTargetEl) return;
    this.tooltipEl.textContent = text;
    this.tooltipEl.hidden = false;
    this.reposition(this.currentTargetEl);
  }

  private hide(): void {
    this.tooltipEl.hidden = true;
  }

  private reposition(targetEl: Element): void {
    const targetRect = targetEl.getBoundingClientRect();
    // Measured only after `hidden` is cleared and textContent is set, so
    // this reflects the tooltip's actual current size.
    const tooltipRect = this.tooltipEl.getBoundingClientRect();

    // Prefers just below the element, flipping above it if there isn't
    // room -- vertical space is the more plentiful direction in both a
    // scrollable commit list and a graph laid out top-to-bottom.
    let y = targetRect.bottom + GAP_PX;
    if (y + tooltipRect.height > window.innerHeight) {
      y = targetRect.top - tooltipRect.height - GAP_PX;
    }
    let x = targetRect.left;
    if (x + tooltipRect.width > window.innerWidth) {
      x = window.innerWidth - tooltipRect.width - GAP_PX;
    }
    this.tooltipEl.style.left = `${Math.max(0, x)}px`;
    this.tooltipEl.style.top = `${Math.max(0, y)}px`;
  }
}
