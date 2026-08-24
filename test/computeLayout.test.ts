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
});
