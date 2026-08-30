import { describe, expect, it } from 'vitest';
import { buildLogArgs, classifyRef, displayRefName, filterRefsForScope, parseLogRecord } from '../src/git/logReader';
import type { RefInfo } from '../src/shared/types';

const FIELD_SEP = '\x1f';

describe('buildLogArgs', () => {
  it('uses --all for the all-branches scope', () => {
    expect(buildLogArgs({ scope: 'all-branches' }, false)).toContain('--all');
  });

  it('targets HEAD for the current-branch scope', () => {
    expect(buildLogArgs({ scope: 'current-branch' }, false)).toContain('HEAD');
  });

  it('uses --branches for the local-branches scope', () => {
    expect(buildLogArgs({ scope: 'local-branches' }, false)).toContain('--branches');
  });

  it('uses --remotes for the remote-branches scope', () => {
    expect(buildLogArgs({ scope: 'remote-branches' }, false)).toContain('--remotes');
  });

  it('builds a `to ^from` range', () => {
    const args = buildLogArgs({ scope: 'range', fromRef: 'v1.0', toRef: 'main' }, false);
    expect(args).toEqual(expect.arrayContaining(['main', '^v1.0']));
  });

  it('omits the exclusion when fromRef is absent', () => {
    const args = buildLogArgs({ scope: 'range', toRef: 'main' }, false);
    expect(args).toContain('main');
    expect(args.some((a) => a.startsWith('^'))).toBe(false);
  });

  it('throws when range scope is missing toRef', () => {
    expect(() => buildLogArgs({ scope: 'range' }, false)).toThrow();
  });

  it('always includes --simplify-by-decoration, matching TortoiseGit', () => {
    expect(buildLogArgs({ scope: 'all-branches' }, true)).toContain('--simplify-by-decoration');
    expect(buildLogArgs({ scope: 'all-branches' }, false)).toContain('--simplify-by-decoration');
  });

  it('adds --sparse only when requested (checked "Show branches and merges")', () => {
    expect(buildLogArgs({ scope: 'all-branches' }, true)).toContain('--sparse');
    expect(buildLogArgs({ scope: 'all-branches' }, false)).not.toContain('--sparse');
  });
});

describe('filterRefsForScope', () => {
  const refs: RefInfo[] = [
    { name: 'main', type: 'local-branch' },
    { name: 'origin/main', type: 'remote-branch' },
    { name: 'v1.0', type: 'tag' },
  ];

  it('drops remote-branch refs for the local-branches scope', () => {
    expect(filterRefsForScope(refs, 'local-branches')).toEqual([refs[0], refs[2]]);
  });

  it('drops local-branch refs for the remote-branches scope', () => {
    expect(filterRefsForScope(refs, 'remote-branches')).toEqual([refs[1], refs[2]]);
  });

  it('also drops the checked-out current-branch ref for the remote-branches scope', () => {
    const withCurrent: RefInfo[] = [{ name: 'main', type: 'current-branch' }, ...refs.slice(1)];
    expect(filterRefsForScope(withCurrent, 'remote-branches')).toEqual([refs[1], refs[2]]);
  });

  it('also drops a detached-HEAD head ref for the remote-branches scope', () => {
    const withHead: RefInfo[] = [{ name: 'HEAD', type: 'head' }, ...refs.slice(1)];
    expect(filterRefsForScope(withHead, 'remote-branches')).toEqual([refs[1], refs[2]]);
  });

  it('keeps every ref for other scopes', () => {
    expect(filterRefsForScope(refs, 'all-branches')).toEqual(refs);
    expect(filterRefsForScope(refs, 'current-branch')).toEqual(refs);
    expect(filterRefsForScope(refs, 'range')).toEqual(refs);
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

describe('parseLogRecord', () => {
  const record = [
    'abc123',
    'parent1 parent2',
    'Fix the thing',
    'Jane Doe',
    'jane@example.com',
    '1700000000',
    'Fix the thing\n',
  ].join(FIELD_SEP);

  it('parses fields and merges in refs by hash', () => {
    const refs: RefInfo[] = [{ name: 'main', type: 'local-branch' }];
    const refsByHash = new Map([['abc123', refs]]);

    const commit = parseLogRecord(record, refsByHash);

    expect(commit).toEqual({
      hash: 'abc123',
      parents: ['parent1', 'parent2'],
      subject: 'Fix the thing',
      body: 'Fix the thing',
      authorName: 'Jane Doe',
      authorEmail: 'jane@example.com',
      authorDate: 1700000000,
      refs,
      isCurrentBranch: false,
    });
  });

  it('defaults to an empty refs array when the hash has no refs', () => {
    const commit = parseLogRecord(record, new Map());
    expect(commit?.refs).toEqual([]);
  });

  it.each([
    ['current-branch', true],
    ['head', true],
    ['local-branch', false],
    ['remote-branch', false],
    ['tag', false],
  ] as const)('sets isCurrentBranch from a raw %s ref, independent of later scope filtering', (type, expected) => {
    const refsByHash = new Map([['abc123', [{ name: 'main', type }]]]);
    const commit = parseLogRecord(record, refsByHash);
    expect(commit?.isCurrentBranch).toBe(expected);
  });

  it('returns undefined for an empty record', () => {
    expect(parseLogRecord('', new Map())).toBeUndefined();
  });

  it('parses a root commit with no parents', () => {
    const rootRecord = ['root1', '', 'Initial commit', 'Jane Doe', 'jane@example.com', '1700000000', 'Initial commit\n'].join(
      FIELD_SEP,
    );
    const commit = parseLogRecord(rootRecord, new Map());
    expect(commit?.parents).toEqual([]);
  });

  it('keeps a multi-line body intact, trimming only the trailing newline(s)', () => {
    const body = 'Merge pull request #1 from feature/x\n\nDetailed description here.\n';
    const multilineRecord = [
      'def456',
      'parent1',
      'Merge pull request #1 from feature/x',
      'Jane Doe',
      'jane@example.com',
      '1700000000',
      body,
    ].join(FIELD_SEP);

    const commit = parseLogRecord(multilineRecord, new Map());

    expect(commit?.body).toBe('Merge pull request #1 from feature/x\n\nDetailed description here.');
  });
});
