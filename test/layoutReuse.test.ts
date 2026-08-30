import { describe, expect, it } from 'vitest';
import { commitLabels, isLayoutEquivalent, nodeIdentities, patchGraphRefs } from '../src/webview/render/layoutReuse';
import type { GraphCommit, LaidOutGraph, RefInfo } from '../src/shared/types';

function commit(hash: string, overrides: Partial<GraphCommit> = {}): GraphCommit {
  return {
    hash,
    parents: [],
    subject: `subject-${hash}`,
    body: `subject-${hash}\n`,
    authorName: 'Jane Doe',
    authorEmail: 'jane@example.com',
    authorDate: 1700000000,
    refs: [],
    isCurrentBranch: false,
    ...overrides,
  };
}

describe('commitLabels', () => {
  it('uses ref names when the commit has refs', () => {
    const refs: RefInfo[] = [
      { name: 'main', type: 'current-branch' },
      { name: 'origin/main', type: 'remote-branch' },
    ];
    expect(commitLabels(commit('abc1234567', { refs }))).toEqual(['main', 'origin/main']);
  });

  it('falls back to the short hash when the commit has no refs', () => {
    expect(commitLabels(commit('abc1234567'))).toEqual(['abc1234']);
  });
});

describe('isLayoutEquivalent', () => {
  it('is true for identical hash/parents/labels, even if ref types differ', () => {
    const a = nodeIdentities([
      commit('a', { parents: ['b'], refs: [{ name: 'main', type: 'current-branch' }] }),
      commit('b', { refs: [{ name: 'feature', type: 'local-branch' }] }),
    ]);
    const b = nodeIdentities([
      commit('a', { parents: ['b'], refs: [{ name: 'main', type: 'local-branch' }] }),
      commit('b', { refs: [{ name: 'feature', type: 'current-branch' }] }),
    ]);

    expect(isLayoutEquivalent(a, b)).toBe(true);
  });

  it('is false when the commit count differs', () => {
    const a = nodeIdentities([commit('a')]);
    const b = nodeIdentities([commit('a'), commit('b')]);
    expect(isLayoutEquivalent(a, b)).toBe(false);
  });

  it('is false when a hash differs', () => {
    const a = nodeIdentities([commit('a')]);
    const b = nodeIdentities([commit('b')]);
    expect(isLayoutEquivalent(a, b)).toBe(false);
  });

  it('is false when parents differ', () => {
    const a = nodeIdentities([commit('a', { parents: ['x'] })]);
    const b = nodeIdentities([commit('a', { parents: ['y'] })]);
    expect(isLayoutEquivalent(a, b)).toBe(false);
  });

  it('is false when a node gains a new ref chip (label set changes)', () => {
    const a = nodeIdentities([commit('a', { refs: [{ name: 'main', type: 'current-branch' }] })]);
    const b = nodeIdentities([
      commit('a', {
        refs: [
          { name: 'main', type: 'current-branch' },
          { name: 'feature', type: 'local-branch' },
        ],
      }),
    ]);
    expect(isLayoutEquivalent(a, b)).toBe(false);
  });
});

describe('patchGraphRefs', () => {
  function laidOutGraph(): LaidOutGraph {
    return {
      nodes: [
        { id: 'a', parents: [], refs: [{ name: 'main', type: 'current-branch' }], width: 80, height: 40, isCurrentBranch: true, x: 0, y: 0 },
        { id: 'b', parents: [], refs: [{ name: 'feature', type: 'local-branch' }], width: 80, height: 40, isCurrentBranch: false, x: 0, y: 60 },
      ],
      edges: [{ source: 'a', target: 'b', bendPoints: [{ x: 0, y: 0 }, { x: 0, y: 60 }] }],
      width: 80,
      height: 100,
    };
  }

  it('moves refs/isCurrentBranch onto the matching nodes by hash, keeping positions and edges', () => {
    const graph = laidOutGraph();
    const commits = [
      commit('a', { refs: [{ name: 'main', type: 'local-branch' }], isCurrentBranch: false }),
      commit('b', { refs: [{ name: 'feature', type: 'current-branch' }], isCurrentBranch: true }),
    ];

    const patched = patchGraphRefs(graph, commits);

    const byId = new Map(patched.nodes.map((n) => [n.id, n]));
    expect(byId.get('a')).toMatchObject({ x: 0, y: 0, width: 80, height: 40, isCurrentBranch: false });
    expect(byId.get('b')).toMatchObject({ x: 0, y: 60, width: 80, height: 40, isCurrentBranch: true });
    expect(patched.edges).toBe(graph.edges);
    expect(patched.width).toBe(graph.width);
    expect(patched.height).toBe(graph.height);
  });

  it('leaves a node untouched if no matching commit is found', () => {
    const graph = laidOutGraph();
    const patched = patchGraphRefs(graph, [commit('a')]);
    expect(patched.nodes.find((n) => n.id === 'b')).toEqual(graph.nodes.find((n) => n.id === 'b'));
  });
});
