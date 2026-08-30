// Decides whether a fresh graphData message needs a brand-new layout at all.
// Sugiyama layout (position/size of every node and edge, see computeLayout.ts)
// depends only on each commit's hash+parents (the DAG topology) and its label
// set (which determines its box size, see commitLabels below) -- never on a
// ref's *type* (e.g. 'current-branch' vs 'local-branch'), commit
// subject/author/date, or anything else. So when a new graphData message's
// commits are layout-equivalent to the last rendered ones, the (potentially
// expensive, Worker-hosted) layout computation can be skipped entirely and
// the previous layout's positions/edges reused verbatim -- most commonly true
// after a checkout, which only moves which ref points where.

import type { GraphCommit, LaidOutGraph } from '../../shared/types';

// A node's rendered label rows are its ref names, or its short hash if it has
// none -- shared with buildGraphNodes in main.ts, which needs the exact same
// derivation to size each node's box.
export function commitLabels(commit: GraphCommit): string[] {
  return commit.refs.length > 0 ? commit.refs.map((ref) => ref.name) : [commit.hash.slice(0, 7)];
}

/** Everything layout actually depends on for one commit -- see isLayoutEquivalent. */
export interface NodeIdentity {
  hash: string;
  parents: string[];
  labels: string[];
}

export function nodeIdentities(commits: GraphCommit[]): NodeIdentity[] {
  return commits.map((commit) => ({ hash: commit.hash, parents: commit.parents, labels: commitLabels(commit) }));
}

// Order-sensitive (deliberately conservative): if ref ordering somehow
// shifted between two otherwise-identical commit sets, falling back to a
// full layout is always safe, just not free.
export function isLayoutEquivalent(a: readonly NodeIdentity[], b: readonly NodeIdentity[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].hash !== b[i].hash) return false;
    if (a[i].parents.length !== b[i].parents.length) return false;
    for (let j = 0; j < a[i].parents.length; j++) {
      if (a[i].parents[j] !== b[i].parents[j]) return false;
    }
    if (a[i].labels.length !== b[i].labels.length) return false;
    for (let j = 0; j < a[i].labels.length; j++) {
      if (a[i].labels[j] !== b[i].labels[j]) return false;
    }
  }
  return true;
}

// Reuses a previous layout's node positions and edges verbatim (both are
// fully determined by topology+label sets, see isLayoutEquivalent), only
// overlaying each node's fresh refs/isCurrentBranch -- the parts a checkout
// can actually change.
export function patchGraphRefs(graph: LaidOutGraph, commits: GraphCommit[]): LaidOutGraph {
  const commitsByHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const nodes = graph.nodes.map((node) => {
    const commit = commitsByHash.get(node.id);
    return commit ? { ...node, refs: commit.refs, isCurrentBranch: commit.isCurrentBranch } : node;
  });
  return { ...graph, nodes };
}
