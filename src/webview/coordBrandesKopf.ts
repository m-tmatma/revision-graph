// A custom d3-dag `Coord` operator implementing Brandes & Köpf, "Fast and
// Simple Horizontal Coordinate Assignment" -- the same algorithm TortoiseGit
// itself uses (OGDF's FastHierarchyLayout) for this exact step. Ported from
// `@dagrejs/dagre`'s `lib/position/bk.ts` (MIT licensed, Copyright (c)
// 2012-2014 Chris Pettitt -- see that project's LICENSE; MIT is
// GPL-compatible per CLAUDE.md's license policy) and adapted to d3-dag's
// `Coord` interface instead of dagre's own `Graph` class.
//
// Why: d3-dag's own coord operators were the actual bottleneck for a real
// large repository -- `coordGreedy` took many seconds to minutes on certain
// wide/branchy shapes, `coordQuad` ran out of memory -- even though ranking
// (`layeringLongestPath`) and ordering (`decrossDfs`) were always fast. See
// docs/HANDOFF.md for the full investigation, including why dagre itself
// couldn't just be reconfigured: every one of its ranking strategies
// (including `longest-path`) uses a recursive DFS whose depth tracks the
// graph's longest chain, which is what forced the original move off dagre
// entirely. Only its *coordinate assignment* step -- unrelated to ranking --
// is being reused here, and only as a ported algorithm, not the library
// itself.
//
// Adaptation notes:
// - dagre's version builds its own "sugified" (dummy-node-expanded) graph
//   via a separate normalize step before calling this. d3-dag's sugiyama
//   pipeline already hands every `Coord` operator that representation
//   directly (`SugiNode[][]`), so no normalize step is needed here.
// - dagre's version computes node separation itself, accounting for label
//   positions and compound-graph subgraph borders. Neither applies to this
//   project (no edge labels, no compound graphs), so this uses d3-dag's own
//   provided `sep` function throughout instead of porting that math.
// - dagre's version also detects "type 2" conflicts, which only matter for
//   compound-graph subgraph border dummy nodes -- another feature this
//   project doesn't use, so only "type 1" conflicts (a non-inner segment
//   crossing an inner segment) are ported. This is a real, if minor, quality
//   difference from the full algorithm: some layouts may have a few more
//   avoidable crossings among dummy-node chains than dagre's or OGDF's own
//   output would. It does not affect correctness or performance.
// - Nodes are compared by object identity (`Map`/`Set` keyed on `SugiNode`
//   objects) rather than dagre's string ids, which also sidesteps the
//   `v > w` canonicalization dagre needed to keep its plain-object conflict
//   map consistent -- `addConflict` just records both directions.

import type { SugiNode, SugiSeparation } from 'd3-dag';

type Conflicts = Map<SugiNode, Set<SugiNode>>;
type PositionMap = Map<SugiNode, number>;
type Alignment = { root: Map<SugiNode, SugiNode>; align: Map<SugiNode, SugiNode> };

function getOrSet<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = make();
    map.set(key, value);
  }
  return value;
}

function isDummy(node: SugiNode): boolean {
  return node.data.role === 'link';
}

function addConflict(conflicts: Conflicts, v: SugiNode, w: SugiNode): void {
  getOrSet(conflicts, v, () => new Set()).add(w);
  getOrSet(conflicts, w, () => new Set()).add(v);
}

function hasConflict(conflicts: Conflicts, v: SugiNode, w: SugiNode): boolean {
  return conflicts.get(v)?.has(w) ?? false;
}

function findOtherInnerSegmentNode(v: SugiNode): SugiNode | undefined {
  if (!isDummy(v)) return undefined;
  for (const u of v.parents()) {
    if (isDummy(u)) return u;
  }
  return undefined;
}

/**
 * Marks type-1 conflicts: a non-inner segment (an edge touching a real
 * node) crossing an inner segment (an edge between two dummy nodes on the
 * same original edge). Scans each pair of adjacent layers once.
 */
function findType1Conflicts(layers: readonly SugiNode[][]): Conflicts {
  const conflicts: Conflicts = new Map();

  for (let li = 1; li < layers.length; li++) {
    const prevLayer = layers[li - 1];
    const layer = layers[li];
    const pos = new Map(prevLayer.map((u, i) => [u, i] as const));

    let k0 = 0;
    let scanPos = 0;
    const lastNode = layer[layer.length - 1];

    layer.forEach((v, i) => {
      const w = findOtherInnerSegmentNode(v);
      const k1 = w ? pos.get(w)! : prevLayer.length;

      if (w || v === lastNode) {
        for (let j = scanPos; j <= i; j++) {
          const scanNode = layer[j];
          for (const u of scanNode.parents()) {
            const uPos = pos.get(u);
            if (uPos === undefined) continue;
            if ((uPos < k0 || k1 < uPos) && !(isDummy(u) && isDummy(scanNode))) {
              addConflict(conflicts, u, scanNode);
            }
          }
        }
        scanPos = i + 1;
        k0 = k1;
      }
    });
  }

  return conflicts;
}

/**
 * Aligns nodes into vertical "blocks" where possible: each node tries to
 * align with one of its median neighbors (in `neighborFn`'s direction),
 * skipping conflicted or already-claimed neighbors.
 */
function verticalAlignment(
  layers: readonly SugiNode[][],
  conflicts: Conflicts,
  neighborFn: (v: SugiNode) => IterableIterator<SugiNode>,
): Alignment {
  const root = new Map<SugiNode, SugiNode>();
  const align = new Map<SugiNode, SugiNode>();
  const pos: PositionMap = new Map();

  for (const layer of layers) {
    layer.forEach((v, order) => {
      root.set(v, v);
      align.set(v, v);
      pos.set(v, order);
    });
  }

  for (const layer of layers) {
    let prevIdx = -1;
    for (const v of layer) {
      const ws = [...neighborFn(v)].sort((a, b) => pos.get(a)! - pos.get(b)!);
      if (ws.length === 0) continue;

      const mp = (ws.length - 1) / 2;
      for (let i = Math.floor(mp), il = Math.ceil(mp); i <= il; i++) {
        const w = ws[i];
        const wPos = pos.get(w)!;
        if (align.get(v) === v && prevIdx < wPos && !hasConflict(conflicts, v, w)) {
          align.set(w, v);
          const rootW = root.get(w)!;
          align.set(v, rootW);
          root.set(v, rootW);
          prevIdx = wPos;
        }
      }
    }
  }

  return { root, align };
}

/**
 * Builds a graph of aligned "blocks" (nodes sharing the same alignment
 * root), with an edge between two blocks wherever they have adjacent
 * members in some layer, weighted by the largest separation required
 * between any such adjacent pair.
 */
function buildBlockGraph(
  layers: readonly SugiNode[][],
  root: Map<SugiNode, SugiNode>,
  sep: SugiSeparation<unknown, unknown>,
): { pred: Map<SugiNode, Map<SugiNode, number>>; succ: Map<SugiNode, Map<SugiNode, number>> } {
  const pred = new Map<SugiNode, Map<SugiNode, number>>();
  const succ = new Map<SugiNode, Map<SugiNode, number>>();

  for (const layer of layers) {
    let u: SugiNode | undefined;
    for (const v of layer) {
      const vRoot = root.get(v)!;
      getOrSet(pred, vRoot, () => new Map());
      getOrSet(succ, vRoot, () => new Map());
      if (u !== undefined) {
        const uRoot = root.get(u)!;
        const gap = sep(u, v);
        const uSucc = succ.get(uRoot)!;
        uSucc.set(vRoot, Math.max(gap, uSucc.get(vRoot) ?? 0));
        const vPred = pred.get(vRoot)!;
        vPred.set(uRoot, Math.max(gap, vPred.get(uRoot) ?? 0));
      }
      u = v;
    }
  }

  return { pred, succ };
}

/** Iterative (stack-based, non-recursive) post-order traversal. */
function iteratePostOrder(nodes: Iterable<SugiNode>, next: (v: SugiNode) => Iterable<SugiNode>, visit: (v: SugiNode) => void): void {
  const stack = [...nodes];
  const visited = new Set<SugiNode>();
  let elem = stack.pop();
  while (elem !== undefined) {
    if (visited.has(elem)) {
      visit(elem);
    } else {
      visited.add(elem);
      stack.push(elem);
      for (const n of next(elem)) stack.push(n);
    }
    elem = stack.pop();
  }
}

/**
 * Assigns each block the smallest x consistent with its predecessors
 * (first pass), then widens blocks with slack towards their successors
 * (second pass) -- the same two-sweep compaction dagre's own port of BK
 * uses instead of the paper's original algorithm (see dagre's own comment
 * on this, which applies equally here).
 */
function horizontalCompaction(layers: readonly SugiNode[][], root: Map<SugiNode, SugiNode>, sep: SugiSeparation<unknown, unknown>): PositionMap {
  const { pred, succ } = buildBlockGraph(layers, root, sep);
  const blocks = new Set(pred.keys());
  const xs: PositionMap = new Map();

  iteratePostOrder(
    blocks,
    (elem) => pred.get(elem)?.keys() ?? [],
    (elem) => {
      let x = 0;
      for (const [u, gap] of pred.get(elem) ?? []) {
        x = Math.max(x, (xs.get(u) ?? 0) + gap);
      }
      xs.set(elem, x);
    },
  );

  iteratePostOrder(
    blocks,
    (elem) => succ.get(elem)?.keys() ?? [],
    (elem) => {
      let min = Number.POSITIVE_INFINITY;
      for (const [w, gap] of succ.get(elem) ?? []) {
        min = Math.min(min, (xs.get(w) ?? 0) - gap);
      }
      if (min !== Number.POSITIVE_INFINITY) {
        xs.set(elem, Math.max(xs.get(elem) ?? 0, min));
      }
    },
  );

  const result: PositionMap = new Map();
  for (const layer of layers) {
    for (const v of layer) {
      result.set(v, xs.get(root.get(v)!) ?? 0);
    }
  }
  return result;
}

/** The alignment (of the four computed below) with the smallest total width. */
function findSmallestWidthAlignment(xss: Record<string, PositionMap>, sep: SugiSeparation<unknown, unknown>): PositionMap {
  let best: PositionMap | undefined;
  let bestWidth = Number.POSITIVE_INFINITY;
  for (const xs of Object.values(xss)) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const [v, x] of xs) {
      min = Math.min(min, x - sep(undefined, v));
      max = Math.max(max, x + sep(v, undefined));
    }
    const width = max - min;
    if (width < bestWidth) {
      bestWidth = width;
      best = xs;
    }
  }
  return best!;
}

/** Shifts the other three alignments to share a boundary with the smallest-width one. */
function alignCoordinates(xss: Record<string, PositionMap>, alignTo: PositionMap): void {
  let alignToMin = Number.POSITIVE_INFINITY;
  let alignToMax = Number.NEGATIVE_INFINITY;
  for (const x of alignTo.values()) {
    alignToMin = Math.min(alignToMin, x);
    alignToMax = Math.max(alignToMax, x);
  }

  for (const [key, xs] of Object.entries(xss)) {
    if (xs === alignTo) continue;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const x of xs.values()) {
      min = Math.min(min, x);
      max = Math.max(max, x);
    }
    const horiz = key[1]; // 'l' or 'r'
    const delta = horiz === 'l' ? alignToMin - min : alignToMax - max;
    if (delta) {
      for (const [v, x] of xs) xs.set(v, x + delta);
    }
  }
}

/** Each node's final x is the median of its four (up/down x left/right) aligned positions. */
function balance(xss: Record<string, PositionMap>, allNodes: readonly SugiNode[]): PositionMap {
  const result: PositionMap = new Map();
  for (const v of allNodes) {
    const vals = (['ul', 'ur', 'dl', 'dr'] as const).map((k) => xss[k].get(v)!).sort((a, b) => a - b);
    result.set(v, (vals[1] + vals[2]) / 2);
  }
  return result;
}

export function coordBrandesKopf<N, L>(typedLayers: SugiNode<N, L>[][], sep: SugiSeparation<N, L>): number {
  // Cast once at the boundary: the algorithm below never touches the
  // wrapped node/link data (only `.data.role`, `.parents()`, `.children()`,
  // and the generic-free `x`/`y` fields), so working through the erased
  // `SugiNode` (= `SugiNode<unknown, unknown>`) alias avoids threading `N`/
  // `L` through every internal helper -- these are still the exact same
  // objects, so mutating `.x` through this view mutates what the caller
  // sees too.
  const layers = typedLayers as unknown as SugiNode[][];
  const untypedSep = sep as SugiSeparation<unknown, unknown>;

  const allNodes: SugiNode[] = [];
  for (const layer of layers) for (const v of layer) allNodes.push(v);
  if (allNodes.length === 0) return 0;

  const conflicts = findType1Conflicts(layers);

  const xss: Record<string, PositionMap> = {};
  for (const vert of ['u', 'd'] as const) {
    const vertLayers = vert === 'u' ? layers : [...layers].reverse();
    const neighborFn = (v: SugiNode) => (vert === 'u' ? v.parents() : v.children());

    for (const horiz of ['l', 'r'] as const) {
      const adjusted = horiz === 'l' ? vertLayers : vertLayers.map((layer) => [...layer].reverse());
      const { root } = verticalAlignment(adjusted, conflicts, neighborFn);
      const xs = horizontalCompaction(adjusted, root, untypedSep);
      if (horiz === 'r') {
        for (const [v, x] of xs) xs.set(v, -x);
      }
      xss[vert + horiz] = xs;
    }
  }

  const smallest = findSmallestWidthAlignment(xss, untypedSep);
  alignCoordinates(xss, smallest);
  const balanced = balance(xss, allNodes);

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const v of allNodes) {
    const x = balanced.get(v)!;
    v.x = x;
    minX = Math.min(minX, x - untypedSep(undefined, v));
    maxX = Math.max(maxX, x + untypedSep(v, undefined));
  }
  for (const v of allNodes) {
    v.x -= minX;
  }
  return maxX - minX;
}
