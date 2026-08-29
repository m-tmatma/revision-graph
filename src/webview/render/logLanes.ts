// Assigns each commit in a linear `git log` listing (newest first, in
// topological order — see gitActions.ts's getLogEntries) to a vertical
// "lane" column, git-graph-style (à la `git log --graph`, gitk, or Azure
// DevOps' commit history view): a straight line down a lane for an
// ordinary parent/child link, a diagonal where a merge commit's non-first
// parent opens a new lane ("fork", drawn in this row's lower half), and a
// diagonal where two lanes happen to expect the same commit and converge
// ("merge-in", drawn in this row's upper half).
//
// Requires topological order (parents always listed after every commit
// that reaches them): a commit's hash is only ever looked up because an
// earlier row already registered it as `active[lane]`, except row 0 (the
// starting tip), which is exactly what makes the single "matches.length
// === 0 only at row 0" assumption below safe.

import type { LogEntry } from '../../shared/types';

export interface LaneRow {
  hash: string;
  lane: number;
  isMerge: boolean;
  /** Lanes with a plain straight line through this row's top half. */
  upperStems: number[];
  /** Lanes with a plain straight line through this row's bottom half. */
  lowerStems: number[];
  /** Extra lanes (besides `lane`) that were expecting this same commit, converging into `lane`'s dot via a diagonal in the top half. */
  mergeIns: number[];
  /** New lanes opened for this merge commit's non-first parents, diverging from `lane`'s dot via a diagonal in the bottom half. */
  forkOuts: number[];
}

export function computeLanes(entries: LogEntry[]): { rows: LaneRow[]; laneCount: number } {
  const active: (string | null)[] = [];
  const rows: LaneRow[] = [];

  const allocateLane = (): number => {
    const free = active.indexOf(null);
    if (free !== -1) return free;
    active.push(null);
    return active.length - 1;
  };

  for (const entry of entries) {
    const matches: number[] = [];
    active.forEach((hash, i) => {
      if (hash === entry.hash) matches.push(i);
    });

    const lane = matches.length > 0 ? matches[0] : allocateLane();
    const mergeIns = matches.slice(1);

    const upperStems = active
      .map((hash, i) => (hash !== null && !mergeIns.includes(i) ? i : -1))
      .filter((i) => i !== -1);

    for (const extraLane of mergeIns) active[extraLane] = null;

    const [firstParent, ...restParents] = entry.parents;
    active[lane] = firstParent ?? null;

    const forkOuts: number[] = [];
    for (const parent of restParents) {
      const newLane = allocateLane();
      active[newLane] = parent;
      forkOuts.push(newLane);
    }

    const lowerStems = active
      .map((hash, i) => (hash !== null && !forkOuts.includes(i) ? i : -1))
      .filter((i) => i !== -1);

    rows.push({
      hash: entry.hash,
      lane,
      isMerge: entry.parents.length > 1,
      upperStems,
      lowerStems,
      mergeIns,
      forkOuts,
    });
  }

  return { rows, laneCount: active.length };
}
