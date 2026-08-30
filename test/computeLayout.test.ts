import { describe, expect, it } from 'vitest';
import { computeLayout } from '../src/webview/computeLayout';
import type { GraphNode } from '../src/shared/types';

function node(id: string, parents: string[]): GraphNode {
  return {
    id,
    parents,
    refs: [],
    width: 80,
    height: 40,
    body: id,
    authorName: 'Test Author',
    authorEmail: 'test@example.com',
    authorDate: 0,
    isCurrentBranch: false,
  };
}

describe('computeLayout', () => {
  it('positions a simple chain top to bottom', () => {
    const graph = computeLayout([node('a', ['b']), node('b', ['c']), node('c', [])]);

    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // a is newest (no parent points at it from within this set), c is oldest.
    expect(byId.get('a')!.y).toBeLessThan(byId.get('b')!.y);
    expect(byId.get('b')!.y).toBeLessThan(byId.get('c')!.y);

    expect(graph.edges).toHaveLength(2);
    for (const edge of graph.edges) {
      expect(edge.bendPoints.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('lays out a merge commit with two parents', () => {
    const graph = computeLayout([node('m', ['x', 'y']), node('x', ['base']), node('y', ['base']), node('base', [])]);

    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['base', 'm', 'x', 'y']);
    expect(graph.edges).toHaveLength(4);
  });

  it('places an isolated node (no parents, not anyone else\'s parent) without error', () => {
    const graph = computeLayout([node('solo', [])]);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
    expect(graph.nodes[0].id).toBe('solo');
  });

  it('lays out a very long chain without a stack overflow', () => {
    // Regression coverage for the incident this module exists to prevent
    // (see computeLayout.ts's own comment): dagre's recursive ranking pass
    // overflowed the call stack on a real repository's tens of thousands of
    // commits. 20,000 is comfortably past where that used to fail.
    const chainLength = 20000;
    const nodes: GraphNode[] = [node('head', ['mid-0'])];
    for (let i = 0; i < chainLength; i++) {
      nodes.push(node(`mid-${i}`, [i === chainLength - 1 ? 'base' : `mid-${i + 1}`]));
    }
    nodes.push(node('base', []));

    const graph = computeLayout(nodes);

    expect(graph.nodes).toHaveLength(chainLength + 2);
    expect(graph.edges).toHaveLength(chainLength + 1);
  });

  it('never overlaps two nodes horizontally within the same rank', () => {
    // Brandes-Köpf's whole job is respecting horizontal separation --
    // regression coverage for the coordinate-assignment algorithm itself,
    // not just "did it crash or finish in time" like the tests above.
    // Builds a moderately branchy graph (a trunk with several forks that
    // merge back at different points) to actually exercise alignment
    // across multiple ranks, not just a single simple shape.
    const nodes: GraphNode[] = [];
    const TRUNK = 40;
    for (let i = 0; i < TRUNK - 1; i++) nodes.push(node(`t${i}`, [`t${i + 1}`]));
    nodes.push(node(`t${TRUNK - 1}`, []));
    for (let b = 0; b < 8; b++) {
      const fork = 5 + b * 4;
      const mergeAt = Math.max(0, fork - 3);
      let prev = `b${b}-0`;
      nodes.push(node(prev, [`t${fork}`]));
      for (let i = 1; i < 5; i++) {
        nodes.push(node(`b${b}-${i}`, [prev]));
        prev = `b${b}-${i}`;
      }
      // merge the branch tip back into the trunk as a second parent
      const trunkNode = nodes.find((n) => n.id === `t${mergeAt}`)!;
      trunkNode.parents.push(prev);
    }

    const graph = computeLayout(nodes);

    // Group nodes by rank (same y) and check every same-rank pair for
    // horizontal overlap.
    const byY = new Map<number, typeof graph.nodes>();
    for (const n of graph.nodes) {
      const bucket = byY.get(n.y) ?? [];
      bucket.push(n);
      byY.set(n.y, bucket);
    }

    let checked = 0;
    for (const bucket of byY.values()) {
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const a = bucket[i];
          const b = bucket[j];
          const [left, right] = a.x <= b.x ? [a, b] : [b, a];
          expect(left.x + left.width).toBeLessThanOrEqual(right.x + 0.01);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it(
    'lays out a wide fan-out (many branches sharing a rank) quickly',
    () => {
      // Regression coverage for a second incident this module's operator
      // choices exist to prevent: d3-dag's default decross (decrossTwoLayer)
      // is a fine heuristic for a typical repo shape, but was catastrophically
      // slow -- 9+ seconds at this exact size -- for a single very wide layer,
      // the shape a real "Scope: All branches" repo with many active
      // branches produces. decrossDfs handles it in well under a second; the
      // test's own timeout below (generous, but nowhere near 9s) is what
      // would actually catch a regression back to the slow default.
      const width = 5000;
      const nodes: GraphNode[] = [node('root', [])];
      for (let i = 0; i < width; i++) {
        nodes.push(node(`b${i}`, ['root']));
      }

      const graph = computeLayout(nodes);

      expect(graph.nodes).toHaveLength(width + 1);
    },
    5000,
  );
});
