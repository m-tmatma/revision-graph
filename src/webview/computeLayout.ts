// dagre (a Sugiyama-style layered layout, conceptually the same ranking ->
// ordering -> coordinate-assignment pipeline as TortoiseGit's OGDF/Sugiyama
// layout) is MIT licensed — see CLAUDE.md's license policy for why elkjs
// (EPL-2.0) was dropped in favor of it. Pulled out of layoutWorker.ts so
// main.ts can also call it directly as a fallback: dagre's ranking pass
// uses plain recursion whose depth tracks the graph's longest chain, and a
// dedicated Worker's stack is smaller than the main thread's, so a very
// deep history (e.g. TortoiseGit's own 12k+ commit, 15-year history) can
// overflow the worker even though the same graph lays out fine elsewhere.
//
// `nodes` is always the *reduced* graph (dagReducer.ts's always-on
// elision — a straight run is never shown expanded, matching real
// TortoiseGit), so its longest chain — and this recursion — is bounded
// regardless of how large the underlying repo's full history is.

import dagre from '@dagrejs/dagre';
import type { GraphNode, LaidOutEdge, LaidOutGraph, LaidOutNode } from '../shared/types';

export function computeLayout(nodes: GraphNode[]): LaidOutGraph {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 24, ranksep: 48 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    g.setNode(node.id, { width: node.width, height: node.height });
  }
  // Edges point from a commit to each of its parents, so with `rankdir:
  // 'TB'` newer commits are ranked above their ancestors.
  for (const node of nodes) {
    for (const parent of node.parents) {
      if (nodeById.has(parent)) {
        g.setEdge(node.id, parent);
      }
    }
  }

  dagre.layout(g);

  const laidOutNodes: LaidOutNode[] = g.nodes().map((id) => {
    const original = nodeById.get(id)!;
    const { x = 0, y = 0 } = g.node(id);
    // dagre positions nodes by center; LaidOutNode.x/y is top-left.
    return { ...original, x: x - original.width / 2, y: y - original.height / 2 };
  });

  const laidOutEdges: LaidOutEdge[] = g.edges().map((edge) => {
    const label = g.edge(edge);
    return {
      source: edge.v,
      target: edge.w,
      bendPoints: label.points ?? [],
    };
  });

  // dagre's own graph.width/height only account for node extents; edges
  // routed around other nodes to avoid crossings can extend past that,
  // which would otherwise get clipped by the SVG viewBox (see graphRenderer.ts).
  let maxX = 0;
  let maxY = 0;
  for (const node of laidOutNodes) {
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  for (const edge of laidOutEdges) {
    for (const point of edge.bendPoints) {
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }

  // A little extra margin so the arrowhead marker at an edge's endpoint
  // (drawn a few px past the point itself) never gets clipped either.
  const margin = 8;
  return {
    nodes: laidOutNodes,
    edges: laidOutEdges,
    width: maxX + margin,
    height: maxY + margin,
  };
}
