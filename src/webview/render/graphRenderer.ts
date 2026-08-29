// SVG rendering for a laid-out graph: rounded-rect nodes with stacked,
// ref-type-colored labels, and polyline edges with arrowheads. Follows
// DESIGN.md's "描画 (SVG)" section. The SVG fills its container and is sized
// to 100%; panZoom.ts owns the viewBox (which portion of the graph's logical
// coordinate space is currently visible), not this module.

import type { LaidOutEdge, LaidOutGraph, LaidOutNode, RefInfo } from '../../shared/types';
import { contrastTextColor, REF_COLORS } from './colors';
import { NODE_PADDING_Y, NODE_ROW_HEIGHT } from './layoutConstants';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ARROW_SIZE = 6;

export function createSvgElement<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

export function renderGraph(container: HTMLElement, graph: LaidOutGraph): SVGSVGElement {
  container.replaceChildren();

  const svg = createSvgElement('svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  // panZoom.ts sets the viewBox once it attaches to this element.

  const edgesGroup = createSvgElement('g');
  edgesGroup.setAttribute('fill', 'none');
  for (const edge of graph.edges) {
    edgesGroup.appendChild(buildEdge(edge));
    const arrowhead = buildArrowhead(edge);
    if (arrowhead) edgesGroup.appendChild(arrowhead);
  }
  svg.appendChild(edgesGroup);

  const nodesGroup = createSvgElement('g');
  for (const node of graph.nodes) {
    nodesGroup.appendChild(buildNode(node));
  }
  svg.appendChild(nodesGroup);

  container.appendChild(svg);
  return svg;
}

function buildEdge(edge: LaidOutEdge): SVGPolylineElement {
  const points = edge.bendPoints.map((p) => `${p.x},${p.y}`).join(' ');
  const polyline = createSvgElement('polyline');
  polyline.setAttribute('points', points);
  polyline.setAttribute('stroke', 'var(--vscode-editorLineNumber-foreground, #888888)');
  polyline.setAttribute('stroke-width', '1.5');
  return polyline;
}

// Drawn as a plain triangle rather than an SVG <marker> referenced via
// marker-end="url(#...)": Chromium taints an <img>-rasterized SVG's canvas
// readback (canvas.toDataURL() silently returns "data:," instead of real
// pixel data) when the SVG uses a <marker>, even one referencing a purely
// local same-document fragment id — this broke PNG export.
function buildArrowhead(edge: LaidOutEdge): SVGPolygonElement | null {
  const points = edge.bendPoints;
  if (points.length < 2) return null;
  const tip = points[points.length - 1];
  const prev = points[points.length - 2];
  const dx = tip.x - prev.x;
  const dy = tip.y - prev.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  const backX = tip.x - ux * ARROW_SIZE;
  const backY = tip.y - uy * ARROW_SIZE;
  const halfWidth = ARROW_SIZE / 2;

  const polygon = createSvgElement('polygon');
  polygon.setAttribute(
    'points',
    [
      `${tip.x},${tip.y}`,
      `${backX + px * halfWidth},${backY + py * halfWidth}`,
      `${backX - px * halfWidth},${backY - py * halfWidth}`,
    ].join(' '),
  );
  polygon.setAttribute('fill', 'var(--vscode-editorLineNumber-foreground, #888888)');
  return polygon;
}

function buildNode(node: LaidOutNode): SVGGElement {
  const group = createSvgElement('g');
  group.setAttribute('transform', `translate(${node.x}, ${node.y})`);
  // Lets selection.ts find which node a click landed on.
  group.setAttribute('data-commit-id', node.id);
  group.style.cursor = 'pointer';
  // A <title> as the first child gives every part of the node group a
  // native browser tooltip on hover, with no extra JS/CSS needed.
  group.appendChild(buildTooltip(node));

  const rect = createSvgElement('rect');
  rect.setAttribute('width', String(node.width));
  rect.setAttribute('height', String(node.height));
  rect.setAttribute('rx', '6');
  rect.setAttribute('fill', 'var(--vscode-editorWidget-background, #252526)');
  rect.setAttribute('stroke', 'var(--vscode-panel-border, #454545)');
  group.appendChild(rect);

  if (node.refs.length > 0) {
    node.refs.forEach((ref, index) => group.appendChild(buildRefRow(ref, node.width, index)));
  } else {
    group.appendChild(buildHashLabel(node.id, node.width, node.height));
  }

  return group;
}

function buildTooltip(node: LaidOutNode): SVGTitleElement {
  const title = createSvgElement('title');
  const dateLine = `${node.authorName} <${node.authorEmail}> ${formatDate(node.authorDate)}`;
  title.textContent = `${node.id}\n${dateLine}\n\n${node.body}`;
  return title;
}

export function formatDate(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildRefRow(ref: RefInfo, nodeWidth: number, index: number): SVGGElement {
  const rowGroup = createSvgElement('g');
  // Lets a right-click on this specific ref (rather than elsewhere in the
  // node) offer a ref-specific "Delete" action — a node can carry several
  // refs, and deleting one shouldn't require deleting all of them.
  rowGroup.setAttribute('data-ref-name', ref.name);
  rowGroup.setAttribute('data-ref-type', ref.type);
  const y = NODE_PADDING_Y + index * NODE_ROW_HEIGHT;
  const chipHeight = NODE_ROW_HEIGHT - 2;
  const color = REF_COLORS[ref.type];

  const chip = createSvgElement('rect');
  chip.setAttribute('x', '2');
  chip.setAttribute('y', String(y));
  chip.setAttribute('width', String(nodeWidth - 4));
  chip.setAttribute('height', String(chipHeight));
  chip.setAttribute('rx', '3');
  chip.setAttribute('fill', color);
  rowGroup.appendChild(chip);

  const text = createSvgElement('text');
  text.setAttribute('x', String(nodeWidth / 2));
  text.setAttribute('y', String(y + chipHeight / 2));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.setAttribute('font-size', '11');
  text.setAttribute('fill', contrastTextColor(color));
  text.textContent = ref.name;
  rowGroup.appendChild(text);

  return rowGroup;
}

function buildHashLabel(hash: string, nodeWidth: number, nodeHeight: number): SVGTextElement {
  const text = createSvgElement('text');
  text.setAttribute('x', String(nodeWidth / 2));
  text.setAttribute('y', String(nodeHeight / 2));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.setAttribute('font-size', '11');
  text.setAttribute('font-family', 'var(--vscode-editor-font-family, monospace)');
  text.setAttribute('fill', 'var(--vscode-editor-foreground, #cccccc)');
  text.textContent = hash.slice(0, 7);
  return text;
}
