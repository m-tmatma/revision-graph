// d3-dag (a Sugiyama-style layered layout, conceptually the same ranking ->
// ordering -> coordinate-assignment pipeline as TortoiseGit's OGDF/Sugiyama
// layout) is MIT licensed -- see CLAUDE.md's license policy. Pulled out of
// layoutWorker.ts so main.ts can also call it directly as a fallback for
// the (now rare) case where the worker itself fails to start.
//
// Replaces an earlier `dagre`-based implementation: dagre's ranking pass
// used plain recursion whose depth tracked the graph's longest chain, which
// overflowed the call stack on a large real-world repository (tens of
// thousands of commits) even on the main thread's larger stack -- the same
// repo renders fine in TortoiseGit itself and in another VSCode extension
// that also happens to be named "Git Revision Graph" (which uses d3-dag).
// `layeringLongestPath` + `decrossDfs` + `coordGreedy` were picked over
// d3-dag's LP-solver based defaults (`layeringSimplex` + `coordSimplex`,
// and the default decross `decrossTwoLayer`) specifically for scalability:
// all three are simple, fast heuristics with no recursion whose depth
// tracks the graph's shape, trading a bit of layout tidiness (wider
// graphs, less centered edges, more crossings) for guaranteed speed and
// stack safety even on tens-of-thousands-of-node graphs. `decrossTwoLayer`
// (the default) was tried first and looked fine on every synthetic shape
// except one: a very wide layer (thousands of nodes sharing a rank, e.g.
// many long-lived branches all forking from early history) made it
// catastrophically slow -- 9+ seconds at just 5,000 nodes in one layer,
// scaling worse than quadratically -- which is exactly the shape a real
// "Scope: All branches" repository with many active branches produces, so
// it silently hung the UI on "Computing layout…" with no error to trigger
// the fallback. `decrossDfs` (a single DFS pass, no per-layer
// optimization) handles the identical case in ~120ms. Confirmed all three
// operators together stay fast (low hundreds of ms) on a 20,000-commit
// linear chain, a realistic chain-with-periodic-merges mix, and a
// synthetic "10,000-commit trunk + 50 long-lived 500-commit branches"
// shape meant to approximate a real large, actively-developed repository.
//
// `nodes` is always the *reduced* graph (dagReducer.ts's always-on
// elision -- a straight run is never shown expanded, matching real
// TortoiseGit), so its longest chain -- and this layout's cost -- is
// bounded regardless of how large the underlying repo's full history is.

import { coordGreedy, decrossDfs, graphConnect, layeringLongestPath, sugiyama } from 'd3-dag';
import type { GraphNode as D3DagNode } from 'd3-dag';
import type { GraphNode, LaidOutEdge, LaidOutGraph, LaidOutNode } from '../shared/types';

/** Our own link datum: a `graphConnect` edge tuple of [child, parent] commit ids. */
type LinkDatum = [string, string];

const NODE_GAP_X = 24;
const NODE_GAP_Y = 48;

export function computeLayout(nodes: GraphNode[]): LaidOutGraph {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Edges point from a commit to each of its parents, so newer commits end
  // up ranked above their ancestors (matching `layeringLongestPath`'s
  // top-down default). `graphConnect` only learns about a node from an
  // edge referencing it, so a node with no in-graph parent and that isn't
  // any other node's parent either (only possible for a single-commit
  // repo, or an isolated node from a scope/range filter) needs an explicit
  // self-link -- `.single(true)` treats `[id, id]` as "register this node
  // alone" rather than a real (invalid) self-loop.
  const edges: [string, string][] = [];
  const connected = new Set<string>();
  for (const node of nodes) {
    for (const parent of node.parents) {
      if (nodeById.has(parent)) {
        edges.push([node.id, parent]);
        connected.add(node.id);
        connected.add(parent);
      }
    }
  }
  for (const node of nodes) {
    if (!connected.has(node.id)) {
      edges.push([node.id, node.id]);
    }
  }

  const graph = graphConnect().single(true)(edges);

  const layout = sugiyama()
    .layering(layeringLongestPath())
    .decross(decrossDfs())
    .coord(coordGreedy())
    .nodeSize((node: D3DagNode<string, LinkDatum>): readonly [number, number] => {
      const original = nodeById.get(node.data)!;
      return [original.width, original.height];
    })
    .gap([NODE_GAP_X, NODE_GAP_Y]);

  layout(graph);

  // d3-dag positions nodes by center; LaidOutNode.x/y is top-left.
  const laidOutNodes: LaidOutNode[] = [...graph.nodes()].map((node) => {
    const original = nodeById.get(node.data)!;
    return { ...original, x: node.x - original.width / 2, y: node.y - original.height / 2 };
  });

  const laidOutEdges: LaidOutEdge[] = [...graph.links()].map((link) => ({
    source: link.source.data,
    target: link.target.data,
    bendPoints: link.points.map(([x, y]) => ({ x, y })),
  }));

  // Don't trust the layout's own width/height: they're not guaranteed to
  // account for edge control points extending past node extents (this bit
  // dagre before it), so recompute from the actual laid-out geometry.
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
