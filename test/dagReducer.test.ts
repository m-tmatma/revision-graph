import { describe, expect, it } from 'vitest';
import { reduceDag } from '../src/git/dagReducer';
import type { GraphCommit, RefInfo } from '../src/shared/types';

function commit(hash: string, parents: string[], refs: RefInfo[] = []): GraphCommit {
  return {
    hash,
    parents,
    subject: hash,
    body: hash,
    authorName: 'Test Author',
    authorEmail: 'test@example.com',
    authorDate: 0,
    refs,
    isCurrentBranch: false,
  };
}

describe('reduceDag', () => {
  it('splices out a straight run of unreffed single-parent/single-child commits, always', () => {
    // a -> b -> c -> d, only a and d have refs. b and c should be elided,
    // with a's parent rewritten straight to d — this always happens now
    // (dagReducer no longer has a "leave everything as-is" mode; a
    // straight run is never shown expanded, matching real TortoiseGit).
    const commits = [
      commit('a', ['b'], [{ name: 'main', type: 'local-branch' }]),
      commit('b', ['c']),
      commit('c', ['d']),
      commit('d', [], [{ name: 'v1', type: 'tag' }]),
    ];

    const reduced = reduceDag(commits, { showAllTags: true });

    expect(reduced.map((c) => c.hash)).toEqual(['a', 'd']);
    expect(reduced.find((c) => c.hash === 'a')!.parents).toEqual(['d']);
  });

  it('keeps a commit that has two children (a branch point)', () => {
    // b branches into c and d, both merge back is not required here.
    const commits = [
      commit('c', ['b']),
      commit('d', ['b']),
      commit('b', ['a']),
      commit('a', [], [{ name: 'main', type: 'local-branch' }]),
    ];

    const reduced = reduceDag(commits, { showAllTags: true });

    expect(reduced.map((c) => c.hash).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps a merge commit itself, but elides single-parent/single-child commits feeding into it', () => {
    // x and y are themselves plain pass-throughs (1 parent, 1 child), so
    // they get spliced even though the commit they feed is a merge.
    const commits = [
      commit('m', ['x', 'y']),
      commit('x', ['base']),
      commit('y', ['base']),
      commit('base', [], [{ name: 'main', type: 'local-branch' }]),
    ];

    const reduced = reduceDag(commits, { showAllTags: true });

    expect(reduced.map((c) => c.hash).sort()).toEqual(['base', 'm']);
    expect(reduced.find((c) => c.hash === 'm')!.parents).toEqual(['base', 'base']);
  });

  it('keeps a merge commit and its parents when a parent is itself a branch point', () => {
    const commits = [
      commit('m', ['x', 'y']),
      commit('x', ['base']),
      commit('y', ['base']),
      commit('other', ['base']),
      commit('base', [], [{ name: 'main', type: 'local-branch' }]),
    ];

    const reduced = reduceDag(commits, { showAllTags: true });

    expect(reduced.map((c) => c.hash).sort()).toEqual(['base', 'm', 'other']);
    expect(reduced.find((c) => c.hash === 'm')!.parents).toEqual(['base', 'base']);
  });

  it('keeps a commit protected only by a ref', () => {
    const commits = [
      commit('a', ['b'], [{ name: 'main', type: 'local-branch' }]),
      commit('b', ['c'], [{ name: 'v1', type: 'tag' }]),
      commit('c', [], [{ name: 'base', type: 'local-branch' }]),
    ];

    const reduced = reduceDag(commits, { showAllTags: true });

    expect(reduced.map((c) => c.hash)).toEqual(['a', 'b', 'c']);
  });

  it('treats tag refs as non-protecting when showAllTags is false', () => {
    const commits = [
      commit('a', ['b'], [{ name: 'main', type: 'local-branch' }]),
      commit('b', ['c'], [{ name: 'v1', type: 'tag' }]),
      commit('c', [], [{ name: 'base', type: 'local-branch' }]),
    ];

    const reduced = reduceDag(commits, { showAllTags: false });

    expect(reduced.map((c) => c.hash)).toEqual(['a', 'c']);
    expect(reduced.find((c) => c.hash === 'a')!.parents).toEqual(['c']);
  });

  it('resolves a long chain without recursing per commit', () => {
    // Regression coverage for the incident this module exists to prevent:
    // resolving a long straight run must not recurse to a depth tracking
    // the chain length. 5000 is comfortably past a stack overflow if this
    // regressed back to a recursive implementation.
    const chainLength = 5000;
    const commits: GraphCommit[] = [commit('head', ['mid-0'], [{ name: 'main', type: 'local-branch' }])];
    for (let i = 0; i < chainLength; i++) {
      commits.push(commit(`mid-${i}`, [i === chainLength - 1 ? 'base' : `mid-${i + 1}`]));
    }
    commits.push(commit('base', [], [{ name: 'base', type: 'local-branch' }]));

    const reduced = reduceDag(commits, { showAllTags: true });

    expect(reduced.map((c) => c.hash)).toEqual(['head', 'base']);
  });
});
