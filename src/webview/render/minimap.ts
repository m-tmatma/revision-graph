// A small overlay showing the whole graph scaled down, with a rectangle
// tracking the main view's currently visible region — dragging anywhere on
// it pans the main view there. Follows DESIGN.md's "描画 (SVG)" minimap
// note. Nodes are drawn as plain unlabeled rects (no refs/text/tooltips):
// at minimap scale they'd be illegible, and skipping them keeps rebuilding
// the minimap on every graph re-render cheap even for a large history.

import type { LaidOutGraph } from '../../shared/types';
import type { PanZoomController } from './panZoom';

const SVG_NS = 'http://www.w3.org/2000/svg';

// The container is fit to the graph's aspect ratio within these bounds
// (which themselves scale with the panel's own size, up to a hard cap) —
// stretching it to a fixed box regardless of the graph's shape
// (`preserveAspectRatio="none"`) was tried and made an ordinary,
// moderately-tall repo's minimap needlessly wide. But a real repo's
// history can be *dramatically* taller than wide (commits flow
// top-to-bottom), and strictly preserving that exact ratio squeezed the
// content into a sliver only a few pixels wide for one — indistinguishable
// from the minimap not having rendered at all. MIN_WIDTH is the
// compromise: proportions hold everywhere except that extreme, where the
// box is widened past its "true" scaled width just enough to stay usable
// (letterboxing the now-too-narrow content within it).
const MAX_WIDTH_FRACTION = 0.18;
const MAX_HEIGHT_FRACTION = 0.65;
const MAX_WIDTH_CAP = 220;
const MAX_HEIGHT_CAP = 650;
const MIN_WIDTH = 70;

export class Minimap {
  private readonly svg: SVGSVGElement;
  private readonly viewportRect: SVGRectElement;
  private readonly unsubscribe: () => void;
  private dragging = false;

  constructor(
    private readonly container: HTMLElement,
    graph: LaidOutGraph,
    private readonly panZoom: PanZoomController,
  ) {
    container.replaceChildren();

    const parent = container.parentElement;
    const maxWidth = Math.min(MAX_WIDTH_CAP, (parent?.clientWidth ?? MAX_WIDTH_CAP) * MAX_WIDTH_FRACTION);
    const maxHeight = Math.min(MAX_HEIGHT_CAP, (parent?.clientHeight ?? MAX_HEIGHT_CAP) * MAX_HEIGHT_FRACTION);
    const fitScale = Math.min(maxWidth / graph.width, maxHeight / graph.height);
    container.style.width = `${Math.min(maxWidth, Math.max(MIN_WIDTH, graph.width * fitScale))}px`;
    container.style.height = `${Math.min(maxHeight, graph.height * fitScale)}px`;

    this.svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    this.svg.setAttribute('viewBox', `0 0 ${graph.width} ${graph.height}`);
    this.svg.setAttribute('width', '100%');
    this.svg.setAttribute('height', '100%');
    this.svg.style.display = 'block';

    const nodesGroup = document.createElementNS(SVG_NS, 'g');
    for (const node of graph.nodes) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(node.x));
      rect.setAttribute('y', String(node.y));
      rect.setAttribute('width', String(node.width));
      rect.setAttribute('height', String(node.height));
      rect.setAttribute('rx', '2');
      rect.setAttribute('fill', 'var(--vscode-editorLineNumber-foreground, #888888)');
      nodesGroup.appendChild(rect);
    }
    this.svg.appendChild(nodesGroup);

    // Line width scales with the graph so it stays visible (roughly
    // constant on-screen thickness) regardless of a repo's overall size.
    const strokeWidth = Math.max(1, graph.width / 300);
    const viewportRect = document.createElementNS(SVG_NS, 'rect');
    viewportRect.setAttribute('fill', 'var(--vscode-focusBorder, #007acc)');
    viewportRect.setAttribute('fill-opacity', '0.15');
    viewportRect.setAttribute('stroke', 'var(--vscode-focusBorder, #007acc)');
    viewportRect.setAttribute('stroke-width', String(strokeWidth));
    this.svg.appendChild(viewportRect);
    this.viewportRect = viewportRect;

    container.appendChild(this.svg);

    this.svg.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);

    this.unsubscribe = panZoom.onChange(() => this.updateViewportRect());
    this.updateViewportRect();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    this.dragging = true;
    this.navigateTo(event);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.navigateTo(event);
  };

  private readonly onPointerUp = (): void => {
    this.dragging = false;
  };

  // Converts the pointer's screen position into the minimap SVG's own
  // logical coordinate space (same units as the main graph) via its CTM,
  // rather than hand-computing the fit-to-box scale/letterboxing that
  // `preserveAspectRatio="xMidYMid meet"` (the SVG default, back in play
  // whenever the MIN_WIDTH clamp above kicks in) applies.
  private navigateTo(event: PointerEvent): void {
    const ctm = this.svg.getScreenCTM();
    if (!ctm) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
    this.panZoom.panTo(point.x, point.y);
  }

  private updateViewportRect(): void {
    const box = this.panZoom.getViewBox();
    this.viewportRect.setAttribute('x', String(box.x));
    this.viewportRect.setAttribute('y', String(box.y));
    this.viewportRect.setAttribute('width', String(box.width));
    this.viewportRect.setAttribute('height', String(box.height));
  }

  destroy(): void {
    this.svg.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    this.unsubscribe();
    this.container.replaceChildren();
  }
}
