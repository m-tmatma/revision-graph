// Fetches commit + ref data for a repository by shelling out to the `git` CLI.
// Runs in the extension host (node), never in the webview.

import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import type { GraphCommit, LogScopeOptions, RefInfo, RefType } from '../shared/types';

// Unit Separator: safe to use as a field delimiter since it cannot appear in
// commit subjects/author names in practice.
const FIELD_SEP = '\x1f';

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

export function buildLogArgs(options: LogScopeOptions): string[] {
  const format = ['%H', '%P', '%s', '%an', '%ae', '%at'].join(FIELD_SEP);
  const args = ['log', `--pretty=format:${format}`, '--no-color'];

  switch (options.scope) {
    case 'current-branch':
      args.push('HEAD');
      break;
    case 'local-branches':
      args.push('--branches');
      break;
    case 'range':
      if (!options.toRef) {
        throw new Error('range scope requires toRef');
      }
      args.push(options.toRef);
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

async function fetchRefs(cwd: string): Promise<Map<string, RefInfo[]>> {
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

/** Parses one `git log --pretty=format:...` line (see FIELD_SEP layout above). */
export function parseLogLine(line: string, refsByHash: Map<string, RefInfo[]>): GraphCommit | undefined {
  if (!line) return undefined;
  const [hash, parentsRaw, subject, authorName, authorEmail, authorDateRaw] = line.split(FIELD_SEP);
  if (!hash) return undefined;

  return {
    hash,
    parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [],
    subject: subject ?? '',
    authorName: authorName ?? '',
    authorEmail: authorEmail ?? '',
    authorDate: Number(authorDateRaw) || 0,
    refs: refsByHash.get(hash) ?? [],
  };
}

export async function fetchCommits(cwd: string, options: LogScopeOptions): Promise<GraphCommit[]> {
  const refsByHash = await fetchRefs(cwd);
  const commits: GraphCommit[] = [];

  await runGitLines(cwd, buildLogArgs(options), (line) => {
    const commit = parseLogLine(line, refsByHash);
    if (commit) commits.push(commit);
  });

  return commits;
}
