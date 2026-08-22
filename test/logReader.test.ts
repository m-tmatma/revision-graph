import { describe, expect, it } from 'vitest';
import { buildLogArgs, classifyRef, displayRefName, parseLogLine } from '../src/git/logReader';
import type { RefInfo } from '../src/shared/types';

const FIELD_SEP = '\x1f';

describe('buildLogArgs', () => {
  it('uses --all for the all-branches scope', () => {
    expect(buildLogArgs({ scope: 'all-branches' })).toContain('--all');
  });

  it('targets HEAD for the current-branch scope', () => {
    expect(buildLogArgs({ scope: 'current-branch' })).toContain('HEAD');
  });

  it('uses --branches for the local-branches scope', () => {
    expect(buildLogArgs({ scope: 'local-branches' })).toContain('--branches');
  });

  it('builds a `to ^from` range', () => {
    const args = buildLogArgs({ scope: 'range', fromRef: 'v1.0', toRef: 'main' });
    expect(args).toEqual(expect.arrayContaining(['main', '^v1.0']));
  });

  it('omits the exclusion when fromRef is absent', () => {
    const args = buildLogArgs({ scope: 'range', toRef: 'main' });
    expect(args).toContain('main');
    expect(args.some((a) => a.startsWith('^'))).toBe(false);
  });

  it('throws when range scope is missing toRef', () => {
    expect(() => buildLogArgs({ scope: 'range' })).toThrow();
  });
});

describe('classifyRef', () => {
  it.each([
    ['HEAD', 'head'],
    ['refs/heads/main', 'local-branch'],
    ['refs/remotes/origin/main', 'remote-branch'],
    ['refs/tags/v1.0', 'tag'],
    ['refs/stash', 'stash'],
    ['refs/notes/commits', 'other'],
  ] as const)('classifies %s as %s', (refname, expected) => {
    expect(classifyRef(refname)).toBe(expected);
  });
});

describe('displayRefName', () => {
  it.each([
    ['refs/heads/main', 'main'],
    ['refs/remotes/origin/main', 'origin/main'],
    ['refs/tags/v1.0', 'v1.0'],
    ['refs/stash', 'stash'],
  ])('strips the ref prefix from %s', (refname, expected) => {
    expect(displayRefName(refname)).toBe(expected);
  });
});

describe('parseLogLine', () => {
  const line = ['abc123', 'parent1 parent2', 'Fix the thing', 'Jane Doe', 'jane@example.com', '1700000000'].join(
    FIELD_SEP,
  );

  it('parses fields and merges in refs by hash', () => {
    const refs: RefInfo[] = [{ name: 'main', type: 'local-branch' }];
    const refsByHash = new Map([['abc123', refs]]);

    const commit = parseLogLine(line, refsByHash);

    expect(commit).toEqual({
      hash: 'abc123',
      parents: ['parent1', 'parent2'],
      subject: 'Fix the thing',
      authorName: 'Jane Doe',
      authorEmail: 'jane@example.com',
      authorDate: 1700000000,
      refs,
    });
  });

  it('defaults to an empty refs array when the hash has no refs', () => {
    const commit = parseLogLine(line, new Map());
    expect(commit?.refs).toEqual([]);
  });

  it('returns undefined for an empty line', () => {
    expect(parseLogLine('', new Map())).toBeUndefined();
  });

  it('parses a root commit with no parents', () => {
    const rootLine = ['root1', '', 'Initial commit', 'Jane Doe', 'jane@example.com', '1700000000'].join(FIELD_SEP);
    const commit = parseLogLine(rootLine, new Map());
    expect(commit?.parents).toEqual([]);
  });
});
