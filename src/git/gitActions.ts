// Git mutation/inspection commands triggered from the webview's context
// menu (checkout, delete ref, compare, ...). Runs in the extension host —
// the webview can't shell out to git itself.

import { spawn } from 'node:child_process';
import type { CheckoutOptions, FileChange } from '../shared/types';

function runGitCapture(cwd: string, args: string[]): Promise<string> {
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

export interface CommitSummary {
  hash: string;
  subject: string;
}

export async function getCommitSummary(cwd: string, rev: string): Promise<CommitSummary> {
  const output = await runGitCapture(cwd, ['log', '-1', '--format=%H\x1f%s', rev]);
  const [hash, subject] = output.trim().split('\x1f');
  return { hash: hash ?? rev, subject: subject ?? '' };
}

function statusFromLetter(letter: string): FileChange['status'] {
  switch (letter[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'M':
      return 'modified';
    default:
      return 'other';
  }
}

/**
 * File-level changes between two revisions, with per-file added/deleted
 * line counts. Uses `--no-renames` so both `--numstat` and `--name-status`
 * report a single unambiguous path per file (a rename shows as a delete +
 * an add instead) — simpler and more robust to parse than reconstructing
 * git's `old => new` rename notation.
 */
export async function diffFileChanges(cwd: string, from: string, to: string): Promise<FileChange[]> {
  const [numstatOutput, nameStatusOutput] = await Promise.all([
    runGitCapture(cwd, ['diff', '--no-renames', '--numstat', from, to]),
    runGitCapture(cwd, ['diff', '--no-renames', '--name-status', from, to]),
  ]);

  const statusByPath = new Map<string, FileChange['status']>();
  for (const line of nameStatusOutput.split('\n')) {
    if (!line.trim()) continue;
    const [letter, path] = line.split('\t');
    if (letter && path) statusByPath.set(path, statusFromLetter(letter));
  }

  const changes: FileChange[] = [];
  for (const line of numstatOutput.split('\n')) {
    if (!line.trim()) continue;
    const [addedRaw, deletedRaw, path] = line.split('\t');
    if (!path) continue;
    changes.push({
      path,
      status: statusByPath.get(path) ?? 'other',
      // Binary files report `-` instead of a line count.
      added: addedRaw === '-' ? undefined : Number(addedRaw),
      deleted: deletedRaw === '-' ? undefined : Number(deletedRaw),
    });
  }
  return changes;
}

/** A file's content at a given revision, or '' if it doesn't exist there
 * (expected for a file that was added or deleted by the diff being viewed). */
export async function readFileAtRevision(cwd: string, rev: string, path: string): Promise<string> {
  try {
    return await runGitCapture(cwd, ['show', `${rev}:${path}`]);
  } catch {
    return '';
  }
}

export async function checkoutRef(cwd: string, ref: string, options: CheckoutOptions): Promise<void> {
  const args = ['checkout'];
  if (options.force) args.push('--force');
  if (options.merge) args.push('--merge');
  if (options.createBranch) {
    args.push(options.overwriteExisting ? '-B' : '-b', options.newBranchName);
    if (options.track) args.push('--track');
  }
  args.push(ref);
  await runGitCapture(cwd, args);
}

export async function updateSubmodules(cwd: string): Promise<void> {
  await runGitCapture(cwd, ['submodule', 'update', '--init', '--recursive']);
}
