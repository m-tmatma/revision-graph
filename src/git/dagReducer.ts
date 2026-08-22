// Ports TortoiseGit's straight-line elision pass (see docs/DESIGN.md,
// "DAG構築と直線区間の間引き"): a commit that has no protecting ref and sits
// on a non-branching, non-merging run (exactly one parent, exactly one
// child) is spliced out, rewiring its child straight to its parent.
// Runs in the extension host, on the GraphCommit[] returned by logReader.
//
// This always runs, regardless of the "Show branches and merges" toggle —
// confirmed against real TortoiseGit that it behaves the same way: a
// straight run is never shown expanded there either, checkbox or not. What
// the toggle actually controls is a `--simplify-by-decoration` flag on the
// `git log` call itself (see logReader.ts's buildLogArgs) — whether git
// prunes commits, including whole merges, that aren't reachable from any
// ref and aren't needed to preserve ancestry between ones that are. This
// module's own elision runs on top of whatever that fetch already
// returned, and is unrelated to it.

import type { GraphCommit, ReduceOptions } from '../shared/types';

function hasProtectingRef(commit: GraphCommit, showAllTags: boolean): boolean {
  return commit.refs.some((ref) => showAllTags || ref.type !== 'tag');
}

export function reduceDag(commits: GraphCommit[], options: Pick<ReduceOptions, 'showAllTags'>): GraphCommit[] {
  const commitByHash = new Map(commits.map((commit) => [commit.hash, commit]));

  const childCount = new Map<string, number>();
  for (const commit of commits) {
    for (const parent of commit.parents) {
      childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
    }
  }

  const skipSet = new Set<string>();
  for (const commit of commits) {
    if (hasProtectingRef(commit, options.showAllTags)) continue;
    if (commit.parents.length !== 1) continue;
    if ((childCount.get(commit.hash) ?? 0) !== 1) continue;
    skipSet.add(commit.hash);
  }

  // Resolve a (possibly skipped) hash to the nearest kept ancestor by
  // walking the chain of single-parent/single-child skipped commits.
  // Iterative, not recursive: a skip chain can be as long as the repo's
  // history, and this is exactly the kind of unbounded recursion that
  // overflowed the layout engine when an earlier version of this feature
  // tried to preserve and re-display every individual elided commit.
  const resolveCache = new Map<string, string>();
  function resolveParent(hash: string): string {
    const cached = resolveCache.get(hash);
    if (cached) return cached;

    const path: string[] = [];
    let current = hash;
    while (skipSet.has(current)) {
      path.push(current);
      current = commitByHash.get(current)!.parents[0];
    }
    for (const skipped of path) {
      resolveCache.set(skipped, current);
    }
    return current;
  }

  const reduced: GraphCommit[] = [];
  for (const commit of commits) {
    if (skipSet.has(commit.hash)) continue;
    reduced.push({
      ...commit,
      parents: commit.parents.map(resolveParent),
    });
  }
  return reduced;
}
