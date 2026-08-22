// SVG rendering for a laid-out graph: rounded-rect nodes with stacked,
// ref-type-colored labels, and polyline edges with arrowheads. Follows
// DESIGN.md's "描画 (SVG)" section. No pan/zoom or interaction yet (M3).

import type { LaidOutEdge, LaidOutGraph, LaidOutNode, RefInfo } from '../../shared/types';
import { contrastTextColor, REF_COLORS } from './colors';
import { NODE_PADDING_Y, NODE_ROW_HEIGHT } from './layoutConstants';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ARROW_SIZE = 6;

function createSvgElement<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

export function renderGraph(container: HTMLElement, graph: LaidOutGraph): void {
  container.replaceChildren();

  const svg = createSvgElement('svg');
  svg.setAttribute('width', String(graph.width));
  svg.setAttribute('height', String(graph.height));
  svg.setAttribute('viewBox', `0 0 ${graph.width} ${graph.height}`);
  // Defense in depth: computeLayout's width/height already cover every node
  // and edge point, but SVG clips overflow by default, and a clipped edge
  // silently looks like a rendering bug rather than an error.
  svg.style.overflow = 'visible';

  const defs = createSvgElement('defs');
  defs.appendChild(buildArrowMarker());
  svg.appendChild(defs);

  const edgesGroup = createSvgElement('g');
  edgesGroup.setAttribute('fill', 'none');
  for (const edge of graph.edges) {
    edgesGroup.appendChild(buildEdge(edge));
  }
  svg.appendChild(edgesGroup);

  const nodesGroup = createSvgElement('g');
  for (const node of graph.nodes) {
    nodesGroup.appendChild(buildNode(node));
  }
  svg.appendChild(nodesGroup);

  container.appendChild(svg);
}

function buildArrowMarker(): SVGMarkerElement {
  const marker = createSvgElement('marker');
  marker.setAttribute('id', 'revision-graph-arrowhead');
  marker.setAttribute('markerWidth', String(ARROW_SIZE));
  marker.setAttribute('markerHeight', String(ARROW_SIZE));
  marker.setAttribute('refX', String(ARROW_SIZE - 1));
  marker.setAttribute('refY', String(ARROW_SIZE / 2));
  marker.setAttribute('orient', 'auto');
  marker.setAttribute('markerUnits', 'userSpaceOnUse');

  const path = createSvgElement('path');
  path.setAttribute('d', `M0,0 L${ARROW_SIZE},${ARROW_SIZE / 2} L0,${ARROW_SIZE} Z`);
  path.setAttribute('fill', 'var(--vscode-editorLineNumber-foreground, #888888)');
  marker.appendChild(path);
  return marker;
}

function buildEdge(edge: LaidOutEdge): SVGPolylineElement {
  const points = edge.bendPoints.map((p) => `${p.x},${p.y}`).join(' ');
  const polyline = createSvgElement('polyline');
  polyline.setAttribute('points', points);
  polyline.setAttribute('stroke', 'var(--vscode-editorLineNumber-foreground, #888888)');
  polyline.setAttribute('stroke-width', '1.5');
  polyline.setAttribute('marker-end', 'url(#revision-graph-arrowhead)');
  return polyline;
}

function buildNode(node: LaidOutNode): SVGGElement {
  const group = createSvgElement('g');
  group.setAttribute('transform', `translate(${node.x}, ${node.y})`);

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

function buildRefRow(ref: RefInfo, nodeWidth: number, index: number): SVGGElement {
  const rowGroup = createSvgElement('g');
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
