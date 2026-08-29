import { describe, expect, it } from 'vitest';
import { computeLanes } from '../src/webview/render/logLanes';
import type { LogEntry } from '../src/shared/types';

function entry(hash: string, parents: string[]): LogEntry {
  return { hash, parents, subject: hash, authorName: 'Test Author', authorDate: 0 };
}

describe('computeLanes', () => {
  it('keeps a plain linear chain in a single lane', () => {
    // a -> b -> c (root), newest first, as git log would list it.
    const { rows, laneCount } = computeLanes([entry('a', ['b']), entry('b', ['c']), entry('c', [])]);

    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(rows[0].upperStems).toEqual([]); // nothing above the very first row
    expect(rows[0].lowerStems).toEqual([0]);
    expect(rows[1].upperStems).toEqual([0]);
    expect(rows[1].lowerStems).toEqual([0]);
    expect(rows[2].upperStems).toEqual([0]);
    expect(rows[2].lowerStems).toEqual([]); // root commit, chain ends
    expect(laneCount).toBe(1);
  });

  it('opens a new lane for a merge commit\'s second parent', () => {
    // m merges p1 (first parent, stays in lane 0) and p2 (opens lane 1).
    const { rows, laneCount } = computeLanes([entry('m', ['p1', 'p2']), entry('p1', []), entry('p2', [])]);

    const [m, p1, p2] = rows;
    expect(m.lane).toBe(0);
    expect(m.isMerge).toBe(true);
    expect(m.forkOuts).toEqual([1]);
    expect(m.lowerStems).toEqual([0]); // lane 1 is drawn via the fork diagonal, not a plain stem

    expect(p1.lane).toBe(0);
    expect(p1.upperStems).toEqual([0, 1]); // both lanes were active entering this row
    expect(p1.lowerStems).toEqual([1]); // p1 is a root, lane 0 closes

    expect(p2.lane).toBe(1);
    expect(p2.upperStems).toEqual([1]); // lane 0 already closed by the p1 row above
    expect(p2.lowerStems).toEqual([]); // p2 is also a root

    expect(laneCount).toBe(2);
  });

  it('merges two lanes back together when they reach the same commit', () => {
    // start forks into x1 (lane 0) and x2 (lane 1); both independently lead
    // to the same `shared` ancestor, which should show as a lane 1 -> lane 0
    // convergence rather than a fresh lane.
    const { rows } = computeLanes([
      entry('start', ['x1', 'x2']),
      entry('x1', ['shared']),
      entry('x2', ['shared']),
      entry('shared', []),
    ]);
    const [, , , shared] = rows;

    expect(shared.lane).toBe(0);
    expect(shared.mergeIns).toEqual([1]);
    expect(shared.upperStems).toEqual([0]); // lane 1 is drawn via the merge-in diagonal, not a plain stem
    expect(shared.lowerStems).toEqual([]); // shared is a root, both lanes end here
  });

  it('reuses a closed lane\'s column instead of growing indefinitely', () => {
    // m1 forks b into lane 1; b (a root) closes lane 1 immediately after.
    // m2's own fork (for f) should then reuse lane 1 rather than opening lane 2.
    const { rows, laneCount } = computeLanes([
      entry('m1', ['c', 'b']),
      entry('c', ['m2']),
      entry('b', []),
      entry('m2', ['e', 'f']),
      entry('e', []),
      entry('f', []),
    ]);
    const m2 = rows.find((row) => row.hash === 'm2')!;

    expect(m2.lane).toBe(0);
    expect(m2.forkOuts).toEqual([1]); // reused, not [2]
    expect(laneCount).toBe(2);
  });
});
