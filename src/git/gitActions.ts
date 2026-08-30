// Git mutation/inspection commands triggered from the webview's context
// menu (checkout, delete ref, compare, ...). Runs in the extension host —
// the webview can't shell out to git itself.

import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { fetchRefs } from './logReader';
import type { CheckoutOptions, FileChange, LogEntry } from '../shared/types';

function runGitCapture(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // No terminal is attached to this process -- an interactive credential
    // prompt (e.g. fetchAll's `git fetch` against a remote with no
    // credential helper configured) would otherwise block forever instead
    // of failing, leaving fetchInProgress stuck true in showRevisionGraph.
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
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
 * `git show --no-patch` (i.e. `git show -s`) output for a commit — the
 * commit hash and ref decorations, author, date, and full message, exactly
 * as git itself formats them. `--no-color` overrides any `color.ui=always`
 * in the user's git config, since this is meant for the clipboard, not a
 * terminal. `--decorate` is likewise explicit rather than relying on git's
 * own "auto" default, which shows decorations only when stdout is a
 * terminal — our own stdout here is a pipe, not a tty, so without this
 * flag the ref decorations (branch/tag names) silently disappear.
 *
 * Trimmed to exactly one trailing newline (git itself emits several
 * blank lines after a merge commit's "Merge:" line) so pasting it
 * elsewhere leaves the cursor on a fresh line, same as the hash-only
 * copy actions.
 */
export async function getCommitShowSummary(cwd: string, rev: string): Promise<string> {
  return (await runGitCapture(cwd, ['show', '--no-color', '--no-patch', '--decorate', rev])).trimEnd() + '\n';
}

/**
 * `git log <rev>` — `rev` and its ancestors, most recent first, for the
 * "Show Log" panel's commit list. Capped at `maxCount` so an enormous
 * history doesn't get loaded into the webview all at once.
 *
 * `--topo-order` guarantees every commit is listed after all of its
 * children — the lane-assignment algorithm in logLanes.ts relies on that
 * to know a commit's hash was already registered as some lane's "expected
 * next" value by an earlier row (true for every row except the very
 * first). Plain reverse-chronological order doesn't give that guarantee
 * (clock skew between branches can list a parent before its child).
 */
export async function getLogEntries(cwd: string, rev: string, maxCount = 300): Promise<LogEntry[]> {
  const [output, refsByHash] = await Promise.all([
    runGitCapture(cwd, [
      'log',
      '--topo-order',
      `--max-count=${maxCount}`,
      '--format=%H\x1f%P\x1f%s\x1f%an\x1f%at',
      rev,
    ]),
    fetchRefs(cwd),
  ]);
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, parentsRaw, subject, authorName, authorDate] = line.split('\x1f');
      return {
        hash: hash ?? '',
        parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [],
        subject: subject ?? '',
        authorName: authorName ?? '',
        authorDate: Number(authorDate ?? 0),
        refs: refsByHash.get(hash ?? '') ?? [],
      };
    });
}

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * The first parent of `hash`, or git's canonical empty-tree object if
 * `hash` has no parent (a root commit) — a safe `diffFileChanges` base for
 * showing a single commit's own changes in the "Show Log" panel. A merge
 * commit's first parent is what git itself treats as "the branch it was
 * merged into", so this matches `git show`'s own default diff for a
 * non-merge commit without special-casing merges here.
 */
export async function getDiffBase(cwd: string, hash: string): Promise<string> {
  return runGitCapture(cwd, ['rev-parse', '--verify', '-q', `${hash}^`])
    .then((out) => out.trim())
    .catch(() => EMPTY_TREE_SHA);
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
  // core.quotePath=false: git's default quotes any path containing a
  // non-ASCII byte (e.g. Japanese filenames) as a C-style-escaped string
  // rather than raw UTF-8 -- without this, FileChange.path would carry that
  // escaped form straight through to the "Copy path" action and to opening
  // the file's diff, instead of the actual path.
  const [numstatOutput, nameStatusOutput] = await Promise.all([
    runGitCapture(cwd, ['-c', 'core.quotePath=false', 'diff', '--no-renames', '--numstat', from, to]),
    runGitCapture(cwd, ['-c', 'core.quotePath=false', 'diff', '--no-renames', '--name-status', from, to]),
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

/**
 * `git fetch --all --prune` — updates every remote's tracking branches and
 * removes local remote-tracking refs for branches deleted upstream.
 */
export async function fetchAll(cwd: string): Promise<void> {
  await runGitCapture(cwd, ['fetch', '--all', '--prune']);
}

/** `git branch -d` (safe delete), or `-D` (force) when `force` is true. */
export async function deleteLocalBranch(cwd: string, name: string, force = false): Promise<void> {
  await runGitCapture(cwd, ['branch', force ? '-D' : '-d', name]);
}

/**
 * `git branch -m <old> <new>` (or `-M` when `force` is true, to overwrite an
 * existing branch named `new`). Works on the current branch too — unlike
 * delete, git doesn't refuse to rename the branch you're on.
 */
export async function renameLocalBranch(cwd: string, oldName: string, newName: string, force = false): Promise<void> {
  await runGitCapture(cwd, ['branch', force ? '-M' : '-m', oldName, newName]);
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
    const child = spawn('git', ['merge-base', '--is-ancestor', ref, into], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
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

/**
 * Local branches (other than the current branch, which can't be deleted
 * anyway) that are fully merged into `into` (default `HEAD`) — i.e. every
 * branch `git branch -d` would succeed on. Backs the toolbar's "Delete
 * Merged Branches…" bulk-cleanup action.
 */
export async function listMergedLocalBranches(cwd: string, into = 'HEAD'): Promise<string[]> {
  // A single `--merged` query instead of one `git merge-base --is-ancestor`
  // process per local branch (a repo with hundreds of local branches would
  // otherwise start hundreds of concurrent git processes at once).
  const [mergedOutput, currentBranchOutput] = await Promise.all([
    runGitCapture(cwd, ['for-each-ref', '--format=%(refname:short)', `--merged=${into}`, 'refs/heads/']),
    // Empty (not an error) in detached HEAD — nothing then matches as current.
    runGitCapture(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => ''),
  ]);
  const currentBranch = currentBranchOutput.trim();

  return mergedOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name && name !== currentBranch);
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
