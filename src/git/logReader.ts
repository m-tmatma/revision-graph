// Fetches commit + ref data for a repository by shelling out to the `git` CLI.
// Runs in the extension host (node), never in the webview.

import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import type { GraphCommit, LogScopeOptions, RefInfo, RefType } from '../shared/types';

// Unit Separator: safe to use as a field delimiter since it cannot appear in
// commit subjects/author names in practice.
const FIELD_SEP = '\x1f';
// Record Separator: marks the end of each commit's formatted output. Needed
// because the last field (the full commit message, %B) can itself contain
// newlines, so records can no longer be split one-per-line.
const RECORD_SEP = '\x1e';

function runGitLines(cwd: string, args: string[], onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', onLine);

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`));
      }
    });
  });
}

// Unlike runGitLines, buffers the whole output before returning it — needed
// for `git log` once the format includes the full (possibly multi-line)
// commit message, since that can no longer be parsed one line at a time.
function runGitBuffered(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    const stdoutChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString('utf-8'));
      } else {
        reject(new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`));
      }
    });
  });
}

export function buildLogArgs(options: LogScopeOptions, sparse: boolean): string[] {
  const format = ['%H', '%P', '%s', '%an', '%ae', '%at', '%B'].join(FIELD_SEP) + RECORD_SEP;
  const args = ['log', `--pretty=format:${format}`, '--no-color'];

  // Matches TortoiseGit's own "Show branches and merges" toggle exactly,
  // confirmed by reading TortoiseGit's own source (RevisionGraphDlgFunc.cpp,
  // Git.cpp): it unconditionally applies `--simplify-by-decoration` (which
  // lets git prune commits — including whole merges — that aren't reachable
  // from a ref and aren't needed to preserve ancestry between commits that
  // are), and *additionally* passes `--sparse` only when the toggle is
  // checked (the default), which tells git not to skip over merges that
  // simplification would otherwise treat as pass-throughs. An earlier
  // version of this code treated the toggle as a plain on/off switch for
  // `--simplify-by-decoration` itself, which meant "checked" (the default)
  // sent no simplification flags at all — a much larger, unpruned history
  // than either of TortoiseGit's two actual modes, and the direct cause of
  // a real large repository rendering a visibly noisier graph than
  // TortoiseGit's own (see docs/HANDOFF.md's "Post-M4" entry on this).
  // dagReducer.ts's own straight-run elision still runs afterwards
  // regardless, on whatever git returns.
  args.push('--simplify-by-decoration');
  if (sparse) {
    args.push('--sparse');
  }

  switch (options.scope) {
    case 'current-branch':
      args.push('HEAD');
      break;
    case 'local-branches':
      args.push('--branches');
      break;
    case 'remote-branches':
      args.push('--remotes');
      break;
    case 'range':
      if (!options.toRef) {
        throw new Error('range scope requires toRef');
      }
      // toRef/fromRef come straight from the toolbar's free-text range
      // inputs -- --end-of-options stops git from treating a ref name that
      // happens to start with "-" as a flag instead of a revision.
      args.push('--end-of-options', options.toRef);
      if (options.fromRef) {
        args.push(`^${options.fromRef}`);
      }
      break;
    case 'all-branches':
    default:
      args.push('--all');
      break;
  }

  return args;
}

export function classifyRef(refname: string): RefType {
  if (refname === 'HEAD') return 'head';
  if (refname.startsWith('refs/heads/')) return 'local-branch';
  if (refname.startsWith('refs/remotes/')) return 'remote-branch';
  if (refname.startsWith('refs/tags/')) return 'tag';
  if (refname.startsWith('refs/stash')) return 'stash';
  return 'other';
}

export function displayRefName(refname: string): string {
  return refname
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^refs\/tags\//, '')
    .replace(/^refs\/stash$/, 'stash');
}

/** The branch HEAD currently points to, or null if HEAD is detached. */
async function getCurrentBranchName(cwd: string): Promise<string | null> {
  let output = '';
  try {
    await runGitLines(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], (line) => {
      output += line;
    });
  } catch {
    return null;
  }
  return output.trim() || null;
}

export async function fetchRefs(cwd: string): Promise<Map<string, RefInfo[]>> {
  const refsByHash = new Map<string, RefInfo[]>();

  const addRef = (hash: string, refname: string, typeOverride?: RefType) => {
    const info: RefInfo = { name: displayRefName(refname), type: typeOverride ?? classifyRef(refname) };
    const existing = refsByHash.get(hash);
    if (existing) {
      existing.push(info);
    } else {
      refsByHash.set(hash, [info]);
    }
  };

  const currentBranchName = await getCurrentBranchName(cwd);

  await runGitLines(
    cwd,
    ['for-each-ref', '--format=%(objectname)%1f%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags', 'refs/stash'],
    (line) => {
      if (!line) return;
      const [hash, refname] = line.split('\x1f');
      if (!hash || !refname) return;
      // <remote>/HEAD is a symbolic ref to the remote's default branch, not
      // a branch itself -- same exclusion as listCheckoutCandidates, so a
      // node doesn't get a redundant "origin/HEAD" chip alongside the real
      // branch it points at (e.g. "origin/main").
      if (refname.startsWith('refs/remotes/') && refname.endsWith('/HEAD')) return;
      // Highlight the checked-out branch itself, rather than a separate
      // "HEAD" label alongside it (matches TortoiseGit's own convention).
      const isCurrentBranch = currentBranchName !== null && refname === `refs/heads/${currentBranchName}`;
      addRef(hash, refname, isCurrentBranch ? 'current-branch' : undefined);
    },
  );

  if (currentBranchName === null) {
    // Detached HEAD: there's no branch ref to highlight, so fall back to
    // labeling the commit "HEAD" directly.
    await runGitLines(cwd, ['rev-parse', 'HEAD'], (line) => {
      const hash = line.trim();
      if (hash) addRef(hash, 'HEAD', 'head');
    });
  }

  return refsByHash;
}

/** Parses one `git log` record (see FIELD_SEP/RECORD_SEP layout above). */
export function parseLogRecord(record: string, refsByHash: Map<string, RefInfo[]>): GraphCommit | undefined {
  if (!record) return undefined;
  const [hash, parentsRaw, subject, authorName, authorEmail, authorDateRaw, ...bodyParts] = record.split(FIELD_SEP);
  if (!hash) return undefined;

  // %B ends with its own trailing newline; the body field is everything
  // after the 6th separator, rejoined in case the message itself contains
  // the field separator character (vanishingly unlikely, but cheap to handle).
  const body = bodyParts.join(FIELD_SEP).replace(/\n+$/, '');
  const refs = refsByHash.get(hash) ?? [];

  return {
    hash,
    parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [],
    subject: subject ?? '',
    authorName: authorName ?? '',
    authorEmail: authorEmail ?? '',
    authorDate: Number(authorDateRaw) || 0,
    body,
    refs,
    // Computed from the unfiltered refs above -- filterRefsForScope (below)
    // can later hide this commit's 'current-branch'/'head' ref from `refs`
    // for display purposes (e.g. the "Remote branches" scope hides the
    // checked-out branch's local chip), but the main graph's own
    // current-branch centering must keep working regardless of scope.
    isCurrentBranch: refs.some((ref) => ref.type === 'head' || ref.type === 'current-branch'),
  };
}

// A commit's refs always include every ref pointing at it (branches, tags,
// stash) regardless of which scope was used to decide which commits to
// walk, matching git's own --decorate semantics -- but that can look
// inconsistent when the user deliberately scoped to one branch kind and
// still sees a chip for the other (e.g. selecting "Remote branches" but
// still seeing a local branch's chip on a commit that also happens to be
// its tip). Drop the "other kind" of branch chip for the two scopes that
// are specifically about one branch kind or the other; every other scope
// (all branches, current branch, range) is unaffected.
export function filterRefsForScope(refs: RefInfo[], scope: LogScopeOptions['scope']): RefInfo[] {
  if (scope === 'local-branches') return refs.filter((ref) => ref.type !== 'remote-branch');
  if (scope === 'remote-branches') {
    // 'head' (a detached-HEAD commit) is just as much a local marker as
    // 'current-branch' -- both mean "this is the checked-out commit" (see
    // isCurrentBranch above) and should disappear from the local-only
    // scope's chips the same way.
    return refs.filter(
      (ref) => ref.type !== 'local-branch' && ref.type !== 'current-branch' && ref.type !== 'head',
    );
  }
  return refs;
}

export async function fetchCommits(cwd: string, options: LogScopeOptions, sparse: boolean): Promise<GraphCommit[]> {
  const refsByHash = await fetchRefs(cwd);
  const output = await runGitBuffered(cwd, buildLogArgs(options, sparse));

  const commits: GraphCommit[] = [];
  for (const record of output.split(RECORD_SEP)) {
    const commit = parseLogRecord(record.replace(/^\n/, ''), refsByHash);
    if (commit) {
      commit.refs = filterRefsForScope(commit.refs, options.scope);
      commits.push(commit);
    }
  }
  return commits;
}
