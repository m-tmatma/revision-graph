// Git mutation/inspection commands triggered from the webview's context
// menu (checkout, delete ref, compare, ...). Runs in the extension host —
// the webview can't shell out to git itself.

import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
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
        reject(new Error(vscode.l10n.t('git {0} failed (exit {1}): {2}', args.join(' '), String(code), stderr.trim())));
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

/**
 * The repo's default branch — what `origin/HEAD` points at (i.e. GitHub's
 * or another host's configured "Default branch" for the repo), or `main`/
 * `master` (whichever exists) if `origin/HEAD` isn't set, e.g. in a shallow
 * clone or a repo with no remote at all.
 */
export async function getDefaultBranchRef(cwd: string): Promise<string> {
  const originHead = await runGitCapture(cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']).catch(
    () => '',
  );
  if (originHead.trim()) return originHead.trim();

  for (const candidate of ['main', 'master']) {
    const exists = await runGitCapture(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`])
      .then(() => true)
      .catch(() => false);
    if (exists) return candidate;
  }

  throw new Error(vscode.l10n.t("couldn't determine the default branch (no origin/HEAD, and no local main or master)"));
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

export interface CheckoutCandidate {
  /** Shown in the QuickPick — the full `<remote>/...` name for a remote branch, so it's unambiguous. */
  label: string;
  /**
   * What to pass to `git checkout`. For a remote branch this is the
   * remote-prefix-stripped short name, not the full `<remote>/...` name —
   * checking out that directly would leave HEAD detached, whereas the
   * short name triggers git's own "DWIM" behavior (create/use a local
   * branch tracking it), matching what typing the name by hand would do.
   */
  target: string;
  isCurrent: boolean;
}

/** Local and remote-tracking branches, for the incremental-checkout picker. */
export async function listCheckoutCandidates(cwd: string): Promise<CheckoutCandidate[]> {
  const [localOutput, remoteOutput, currentBranchOutput] = await Promise.all([
    runGitCapture(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']),
    runGitCapture(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/']),
    // Empty (not an error) in detached HEAD — nothing then matches as current.
    runGitCapture(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => ''),
  ]);
  const currentBranch = currentBranchOutput.trim();

  const local = localOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((ref) => ({ label: ref, target: ref, isCurrent: ref === currentBranch }));

  const remote = remoteOutput
    .split('\n')
    .map((line) => line.trim())
    // <remote>/HEAD is a symbolic ref to the remote's default branch, not a branch itself.
    .filter((ref) => ref && !ref.endsWith('/HEAD'))
    .map((ref) => ({ label: ref, target: ref.slice(ref.indexOf('/') + 1), isCurrent: false }));

  return [...local, ...remote];
}

export async function updateSubmodules(cwd: string): Promise<void> {
  await runGitCapture(cwd, ['submodule', 'update', '--init', '--recursive']);
}

/** `git branch -d` (safe delete), or `-D` (force) when `force` is true. */
export async function deleteLocalBranch(cwd: string, name: string, force = false): Promise<void> {
  await runGitCapture(cwd, ['branch', force ? '-D' : '-d', name]);
}

/**
 * Whether `ref` is fully merged into `into` (default `HEAD`) — i.e.
 * whether `git branch -d` would succeed on it. Mirrors TortoiseGit's own
 * `CGit::IsFastForward` check ahead of its branch-delete confirmation:
 * rather than attempting a safe delete and reacting to git's refusal,
 * TortoiseGit checks first and folds an extra warning into the same
 * confirmation dialog when the branch isn't merged — this lets our own
 * delete flow do the same instead of a try/catch-and-retry.
 */
export async function isBranchMerged(cwd: string, ref: string, into = 'HEAD'): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['merge-base', '--is-ancestor', ref, into], { cwd });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // Exit code 1 is `--is-ancestor`'s normal, expected way of saying
      // "no" — not a failure. Anything else (e.g. an invalid ref) is.
      if (code === 0) resolve(true);
      else if (code === 1) resolve(false);
      else reject(new Error(vscode.l10n.t('git {0} failed (exit {1}): {2}', 'merge-base --is-ancestor', String(code), stderr.trim())));
    });
  });
}

export async function deleteTag(cwd: string, name: string): Promise<void> {
  await runGitCapture(cwd, ['tag', '-d', name]);
}

export async function branchExists(cwd: string, name: string): Promise<boolean> {
  return runGitCapture(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])
    .then(() => true)
    .catch(() => false);
}

export async function tagExists(cwd: string, name: string): Promise<boolean> {
  return runGitCapture(cwd, ['show-ref', '--verify', '--quiet', `refs/tags/${name}`])
    .then(() => true)
    .catch(() => false);
}

/** `git branch [-f] <name> <startPoint>` — `force` re-points an existing branch (like `-B` on checkout). */
export async function createBranch(cwd: string, name: string, startPoint: string, force = false): Promise<void> {
  const args = ['branch'];
  if (force) args.push('-f');
  args.push(name, startPoint);
  await runGitCapture(cwd, args);
}

/**
 * `git tag [-f] <name> <startPoint>`, or `-a -m <message>` for an annotated
 * tag when `message` is non-empty (a lightweight tag otherwise).
 */
export async function createTag(cwd: string, name: string, startPoint: string, message: string, force = false): Promise<void> {
  const args = ['tag'];
  if (force) args.push('-f');
  if (message) args.push('-a', '-m', message);
  args.push(name, startPoint);
  await runGitCapture(cwd, args);
}

/**
 * Deletes only the local remote-tracking ref (e.g. `refs/remotes/origin/foo`)
 * — does not touch the actual branch on the remote server.
 */
export async function deleteRemoteTrackingRef(cwd: string, fullRefPath: string): Promise<void> {
  await runGitCapture(cwd, ['update-ref', '-d', fullRefPath]);
}
