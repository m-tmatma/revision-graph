// Extension host entry point: registers `revisionGraph.show`, fetches the
// commit DAG via the git CLI, reduces it, and hosts the webview that lays it
// out (in a Web Worker) and renders it as SVG.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { reduceDag } from './git/dagReducer';
import {
  branchExists,
  checkoutRef,
  createBranch,
  createTag,
  deleteLocalBranch,
  deleteRemoteTrackingRef,
  deleteTag,
  diffFileChanges,
  fetchAll,
  getCommitShowSummary,
  getCommitSummary,
  getDefaultBranchRef,
  isBranchMerged,
  listCheckoutCandidates,
  readFileAtRevision,
  renameLocalBranch,
  tagExists,
  updateSubmodules,
} from './git/gitActions';
import { fetchCommits } from './git/logReader';
import { watchRepositoryChanges } from './git/repoWatcher';
import type {
  CheckoutHostToWebviewMessage,
  CheckoutOptions,
  CheckoutTarget,
  CheckoutWebviewToHostMessage,
  CompareData,
  CompareHostToWebviewMessage,
  CompareWebviewToHostMessage,
  HostToWebviewMessage,
  LogScopeOptions,
  RefType,
  ReduceOptions,
  WebviewToHostMessage,
  WelcomeWebviewToHostMessage,
} from './shared/types';

// Injected by esbuild.js's `define` at build time (`git rev-parse --short
// HEAD` at build time, not activation time — a packaged extension's
// installed files aren't a git checkout, so this can't be read at runtime).
declare const __BUILD_COMMIT__: string;
// Also injected by esbuild.js's `define` — GITHUB_RUN_NUMBER at build time,
// so only non-empty for a CI-built package (see .github/workflows/ci.yml).
declare const __BUILD_NUMBER__: string;

const INITIAL_SCOPE: LogScopeOptions = { scope: 'all-branches' };
const INITIAL_REDUCE_OPTIONS: ReduceOptions = { showAllTags: true, sparse: true };
// No force/merge/create-branch/submodule-update — the incremental-checkout
// picker is meant as a fast, no-questions-asked branch switch, same as
// typing `git checkout <name>` yourself. The right-click "Checkout" item
// on a specific node is where those options live.
const SIMPLE_CHECKOUT_OPTIONS: CheckoutOptions = {
  createBranch: false,
  newBranchName: '',
  track: false,
  overwriteExisting: false,
  force: false,
  merge: false,
  updateSubmodules: false,
};

// Custom scheme for reading a file's content as of a given revision, so the
// "Compare" panel can open a per-file diff via the native `vscode.diff`
// command. URI shape: `revision-graph-git://<rev>/<repo-relative-path>`.
const GIT_SHOW_SCHEME = 'revision-graph-git';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('revisionGraph.show', () => showRevisionGraph(context)),
    vscode.workspace.registerTextDocumentContentProvider(GIT_SHOW_SCHEME, {
      provideTextDocumentContent(uri) {
        const cwd = getWorkspaceRoot();
        if (!cwd) return '';
        const path = decodeURIComponent(uri.path.replace(/^\//, ''));
        return readFileAtRevision(cwd, uri.authority, path);
      },
    }),
    vscode.window.registerWebviewViewProvider('revisionGraph.welcomeView', createWelcomeViewProvider(context)),
  );
}

// The Activity Bar container's sole view: a "Show Revision Graph" button
// plus the running version/build commit hash (see __BUILD_COMMIT__ above),
// shown so a stale Extension Development Host or installed build is easy to
// tell apart from a fresh one at a glance.
function createWelcomeViewProvider(context: vscode.ExtensionContext): vscode.WebviewViewProvider {
  return {
    resolveWebviewView(webviewView) {
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      };

      const versionText = __BUILD_NUMBER__
        ? vscode.l10n.t(
            'Version {0} ({1}, build {2})',
            context.extension.packageJSON.version,
            __BUILD_COMMIT__,
            __BUILD_NUMBER__,
          )
        : vscode.l10n.t('Version {0} ({1})', context.extension.packageJSON.version, __BUILD_COMMIT__);
      void getWelcomeViewHtml(webviewView.webview, context.extensionUri, versionText).then((html) => {
        webviewView.webview.html = html;
      });

      webviewView.webview.onDidReceiveMessage((message: WelcomeWebviewToHostMessage) => {
        if (message.type === 'show') {
          void vscode.commands.executeCommand('revisionGraph.show');
        }
      });
    },
  };
}

export function deactivate(): void {}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function showRevisionGraph(context: vscode.ExtensionContext): Promise<void> {
  const cwd = getWorkspaceRoot();
  if (!cwd) {
    vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: open a folder first.'));
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'revisionGraph',
    vscode.l10n.t('Git Revision Graph'),
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    },
  );

  panel.webview.html = await getWebviewHtml(panel.webview, context.extensionUri);

  let scope: LogScopeOptions = INITIAL_SCOPE;
  let reduce: ReduceOptions = INITIAL_REDUCE_OPTIONS;
  // Filter changes can arrive faster than the git log they trigger resolves
  // (e.g. rapidly toggling checkboxes); only the latest request's result
  // should ever reach the webview.
  let requestGeneration = 0;
  // `git fetch` takes an exclusive lock on the repo's refs — running two at
  // once would have the second fail outright rather than queue, so a click
  // while one is already in flight is simply ignored.
  let fetchInProgress = false;

  const refresh = async (focusOnHead = false) => {
    const generation = ++requestGeneration;
    try {
      const commits = await fetchCommits(cwd, scope, reduce.sparse);
      const reduced = reduceDag(commits, reduce);
      if (generation !== requestGeneration) return;
      const message: HostToWebviewMessage = { type: 'graphData', commits: reduced, focusOnHead };
      await panel.webview.postMessage(message);
    } catch (err) {
      if (generation !== requestGeneration) return;
      const message: HostToWebviewMessage = { type: 'error', message: (err as Error).message };
      await panel.webview.postMessage(message);
    }
  };

  // Refreshes on external repo changes too (a checkout done outside this
  // extension, a commit, a pull, ...), not just after our own
  // checkout/delete-ref actions, which already refresh explicitly.
  const repoWatcher = watchRepositoryChanges(cwd, () => void refresh());
  panel.onDidDispose(() => repoWatcher.dispose());

  panel.webview.onDidReceiveMessage(async (message: WebviewToHostMessage) => {
    if (message.type === 'ready') {
      await refresh();
    } else if (message.type === 'setFilter') {
      scope = message.scope;
      reduce = message.reduce;
      await refresh();
    } else if (message.type === 'error') {
      vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: {0}', message.message));
    } else if (message.type === 'compare') {
      await showCompareChanges(context, cwd, message.from, message.to);
    } else if (message.type === 'compareWithDefaultBranch') {
      try {
        const defaultBranch = await getDefaultBranchRef(cwd);
        await showCompareChanges(context, cwd, defaultBranch, message.to);
      } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: {0}', (err as Error).message));
      }
    } else if (message.type === 'compareWithCurrentBranch') {
      await showCompareChanges(context, cwd, 'HEAD', message.to);
    } else if (message.type === 'copyCommitInfo') {
      try {
        const text = await getCommitShowSummary(cwd, message.commitId);
        await vscode.env.clipboard.writeText(text);
      } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: {0}', (err as Error).message));
      }
    } else if (message.type === 'openCheckoutDialog') {
      showCheckoutDialog(
        context,
        cwd,
        { ref: message.ref, label: message.label, suggestedBranchName: message.suggestedBranchName },
        refresh,
      );
    } else if (message.type === 'deleteRef') {
      await handleDeleteRef(cwd, message.refType, message.refName, refresh);
    } else if (message.type === 'renameRef') {
      await handleRenameRef(cwd, message.refName, refresh);
    } else if (message.type === 'createBranch') {
      await handleCreateBranch(cwd, message.startPoint, refresh);
    } else if (message.type === 'createTag') {
      await handleCreateTag(cwd, message.startPoint, refresh);
    } else if (message.type === 'exportSvg') {
      await exportToFile('revision-graph.svg', { [vscode.l10n.t('SVG Image')]: ['svg'] }, Buffer.from(message.svg, 'utf-8'));
    } else if (message.type === 'exportPng') {
      const base64 = message.dataUrl.replace(/^data:image\/png;base64,/, '');
      await exportToFile(
        'revision-graph.png',
        { [vscode.l10n.t('PNG Image')]: ['png'] },
        Buffer.from(base64, 'base64'),
      );
    } else if (message.type === 'incrementalCheckout') {
      await showIncrementalCheckout(cwd, refresh);
    } else if (message.type === 'fetch') {
      if (fetchInProgress) return;
      fetchInProgress = true;
      try {
        await handleFetch(cwd, refresh);
      } finally {
        fetchInProgress = false;
      }
    }
  });
}

async function showIncrementalCheckout(cwd: string, refresh: (focusOnHead?: boolean) => Promise<void>): Promise<void> {
  const candidates = await listCheckoutCandidates(cwd);
  const items = candidates.map((candidate) => ({
    label: candidate.label,
    description: candidate.isCurrent
      ? vscode.l10n.t('current branch')
      : candidate.target !== candidate.label
        ? vscode.l10n.t('remote')
        : undefined,
    target: candidate.target,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Type to filter branches, then select one to check out'),
    matchOnDescription: false,
  });
  if (!picked) return;

  try {
    await checkoutRef(cwd, picked.target, SIMPLE_CHECKOUT_OPTIONS);
    await refresh(true);
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: checkout failed ({0})', (err as Error).message));
  }
}

async function exportToFile(
  defaultFileName: string,
  filters: Record<string, string[]>,
  content: Buffer,
): Promise<void> {
  const uri = await vscode.window.showSaveDialog({ filters, defaultUri: vscode.Uri.file(defaultFileName) });
  if (!uri) return;

  try {
    await vscode.workspace.fs.writeFile(uri, content);
    vscode.window.showInformationMessage(vscode.l10n.t('Git Revision Graph: exported to {0}', uri.fsPath));
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: export failed ({0})', (err as Error).message));
  }
}

async function showCompareChanges(
  context: vscode.ExtensionContext,
  cwd: string,
  from: string,
  to: string,
): Promise<void> {
  let fromSummary: { hash: string; subject: string };
  let toSummary: { hash: string; subject: string };
  let files: CompareData['files'];
  try {
    [fromSummary, toSummary, files] = await Promise.all([
      getCommitSummary(cwd, from),
      getCommitSummary(cwd, to),
      diffFileChanges(cwd, from, to),
    ]);
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: compare failed ({0})', (err as Error).message));
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'revisionGraphCompare',
    vscode.l10n.t('Changed Files'),
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    },
  );

  panel.webview.html = await getComparePanelHtml(panel.webview, context.extensionUri);

  panel.webview.onDidReceiveMessage(async (message: CompareWebviewToHostMessage) => {
    if (message.type === 'ready') {
      const data: CompareData = { from: fromSummary, to: toSummary, files };
      const hostMessage: CompareHostToWebviewMessage = { type: 'compareData', data };
      await panel.webview.postMessage(hostMessage);
    } else if (message.type === 'openFile') {
      await openFileDiff(from, to, message.path);
    }
  });
}

async function openFileDiff(from: string, to: string, path: string): Promise<void> {
  const fromUri = vscode.Uri.from({ scheme: GIT_SHOW_SCHEME, authority: from, path: `/${path}` });
  const toUri = vscode.Uri.from({ scheme: GIT_SHOW_SCHEME, authority: to, path: `/${path}` });
  const title = vscode.l10n.t('{0} ({1} ↔ {2})', path, from.slice(0, 7), to.slice(0, 7));
  await vscode.commands.executeCommand('vscode.diff', fromUri, toUri, title);
}

function showCheckoutDialog(
  context: vscode.ExtensionContext,
  cwd: string,
  target: CheckoutTarget,
  refreshGraph: (focusOnHead?: boolean) => Promise<void>,
): void {
  const panel = vscode.window.createWebviewPanel(
    'revisionGraphCheckout',
    vscode.l10n.t('Switch / Checkout'),
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    },
  );

  getCheckoutDialogHtml(panel.webview, context.extensionUri).then((html) => {
    panel.webview.html = html;
  });

  panel.webview.onDidReceiveMessage(async (message: CheckoutWebviewToHostMessage) => {
    if (message.type === 'ready') {
      const hostMessage: CheckoutHostToWebviewMessage = { type: 'checkoutTarget', target };
      await panel.webview.postMessage(hostMessage);
    } else if (message.type === 'cancel') {
      panel.dispose();
    } else if (message.type === 'submit') {
      try {
        await checkoutRef(cwd, target.ref, message.options);
        panel.dispose();
        vscode.window.showInformationMessage(vscode.l10n.t('Git Revision Graph: checked out {0}', target.label));
      } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: checkout failed ({0})', (err as Error).message));
        return;
      }

      // Checkout already succeeded at this point, so a submodule-update
      // failure is reported separately rather than as a checkout failure --
      // and the graph still refreshes either way.
      if (message.options.updateSubmodules) {
        try {
          await updateSubmodules(cwd);
        } catch (err) {
          vscode.window.showErrorMessage(
            vscode.l10n.t('Git Revision Graph: submodule update failed ({0})', (err as Error).message),
          );
        }
      }

      await refreshGraph(true);
    }
  });
}

async function handleFetch(cwd: string, refreshGraph: () => Promise<void>): Promise<void> {
  try {
    await fetchAll(cwd);
    vscode.window.showInformationMessage(vscode.l10n.t('Git Revision Graph: fetch complete'));
    await refreshGraph();
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: fetch failed ({0})', (err as Error).message));
  }
}

async function handleDeleteRef(
  cwd: string,
  refType: RefType,
  refName: string,
  refreshGraph: () => Promise<void>,
): Promise<void> {
  // Matches TortoiseGit's own confirmation: it checks whether the branch is
  // fully merged into HEAD *before* asking, and folds an extra warning into
  // the same dialog when it isn't, rather than attempting a safe delete and
  // reacting to git's refusal.
  let message = vscode.l10n.t('Delete {0}? This cannot be undone.', refName);
  let isUnmergedLocalBranch = false;
  if (refType === 'local-branch' || refType === 'current-branch') {
    isUnmergedLocalBranch = !(await isBranchMerged(cwd, refName));
    if (isUnmergedLocalBranch) {
      message += '\n\n' + vscode.l10n.t('This branch is not yet fully merged into HEAD.');
    }
  }

  const deleteActionLabel = vscode.l10n.t('Delete');
  const confirmed = await vscode.window.showWarningMessage(message, { modal: true }, deleteActionLabel);
  if (confirmed !== deleteActionLabel) return;

  try {
    if (refType === 'local-branch' || refType === 'current-branch') {
      await deleteLocalBranch(cwd, refName, isUnmergedLocalBranch);
    } else if (refType === 'tag') {
      await deleteTag(cwd, refName);
    } else if (refType === 'remote-branch') {
      // Local bookkeeping only -- does not touch the actual branch on the
      // remote server (see docs/HANDOFF.md for why).
      await deleteRemoteTrackingRef(cwd, `refs/remotes/${refName}`);
    } else {
      return;
    }
    vscode.window.showInformationMessage(vscode.l10n.t('Git Revision Graph: deleted {0}', refName));
    await refreshGraph();
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: delete failed ({0})', (err as Error).message));
  }
}

async function handleRenameRef(cwd: string, oldName: string, refreshGraph: () => Promise<void>): Promise<void> {
  const newName = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('New name for {0}', oldName),
    value: oldName,
    valueSelection: [0, oldName.length],
    validateInput: (value) => (value.trim() ? undefined : vscode.l10n.t('Branch name cannot be empty.')),
  });
  if (!newName || newName === oldName) return;

  let force = false;
  if (await branchExists(cwd, newName)) {
    const overwriteLabel = vscode.l10n.t('Overwrite');
    const confirmed = await vscode.window.showWarningMessage(
      vscode.l10n.t('Branch {0} already exists. Overwrite it?', newName),
      { modal: true },
      overwriteLabel,
    );
    if (confirmed !== overwriteLabel) return;
    force = true;
  }

  try {
    await renameLocalBranch(cwd, oldName, newName, force);
    vscode.window.showInformationMessage(vscode.l10n.t('Git Revision Graph: renamed {0} to {1}', oldName, newName));
    await refreshGraph();
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: rename failed ({0})', (err as Error).message));
  }
}

async function handleCreateBranch(
  cwd: string,
  startPoint: string,
  refreshGraph: (focusOnHead?: boolean) => Promise<void>,
): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('New branch name'),
    validateInput: (value) => (value.trim() ? undefined : vscode.l10n.t('Branch name cannot be empty.')),
  });
  if (!name) return;

  let force = false;
  if (await branchExists(cwd, name)) {
    const overwriteLabel = vscode.l10n.t('Overwrite');
    const confirmed = await vscode.window.showWarningMessage(
      vscode.l10n.t('Branch {0} already exists. Overwrite it?', name),
      { modal: true },
      overwriteLabel,
    );
    if (confirmed !== overwriteLabel) return;
    force = true;
  }

  try {
    await createBranch(cwd, name, startPoint, force);
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: create branch failed ({0})', (err as Error).message));
    return;
  }
  await refreshGraph();

  // Offered as a follow-up rather than an upfront checkbox: creating a
  // branch elsewhere in history is routine (bookmarking a commit) and
  // usually shouldn't move HEAD, so switching is opt-in after the fact.
  const switchLabel = vscode.l10n.t('Switch to {0}', name);
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t('Git Revision Graph: created branch {0}', name),
    switchLabel,
  );
  if (choice === switchLabel) {
    try {
      await checkoutRef(cwd, name, SIMPLE_CHECKOUT_OPTIONS);
      await refreshGraph(true);
    } catch (err) {
      vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: checkout failed ({0})', (err as Error).message));
    }
  }
}

async function handleCreateTag(cwd: string, startPoint: string, refreshGraph: () => Promise<void>): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('New tag name'),
    validateInput: (value) => (value.trim() ? undefined : vscode.l10n.t('Tag name cannot be empty.')),
  });
  if (!name) return;

  // showInputBox returns undefined only on Escape/cancel, and '' for an
  // empty submission -- that distinction is what tells apart "cancelled the
  // whole flow" from "no message" (a deliberate lightweight tag).
  const message = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Tag message (leave empty for a lightweight tag)'),
  });
  if (message === undefined) return;

  let force = false;
  if (await tagExists(cwd, name)) {
    const overwriteLabel = vscode.l10n.t('Overwrite');
    const confirmed = await vscode.window.showWarningMessage(
      vscode.l10n.t('Tag {0} already exists. Overwrite it?', name),
      { modal: true },
      overwriteLabel,
    );
    if (confirmed !== overwriteLabel) return;
    force = true;
  }

  try {
    await createTag(cwd, name, startPoint, message, force);
    vscode.window.showInformationMessage(vscode.l10n.t('Git Revision Graph: created tag {0}', name));
    await refreshGraph();
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: create tag failed ({0})', (err as Error).message));
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

// The webview runs in a separate, non-Node context and can't use
// `vscode.l10n` directly (see src/webview/l10n.ts) — instead, this reads
// whatever locale bundle matches `vscode.env.language` (falling back from
// e.g. "ja-JP" to "ja", then to "" if there's no match — the extension
// simply has no translations for that language, so the webview's own
// @vscode/l10n falls back to the original source strings, same as
// vscode.l10n does on the host side) and hands its raw JSON to every
// webview panel as `window.__L10N_BUNDLE__`. Cached: the language doesn't
// change while the extension host is running.
let l10nBundleJsonPromise: Promise<string> | undefined;

function loadL10nBundleJson(extensionUri: vscode.Uri): Promise<string> {
  l10nBundleJsonPromise ??= (async () => {
    const language = vscode.env.language;
    const candidates = [language, language.split('-')[0]];
    for (const candidate of candidates) {
      try {
        const path = vscode.Uri.joinPath(extensionUri, 'l10n', `bundle.l10n.${candidate}.json`).fsPath;
        return await fs.readFile(path, 'utf-8');
      } catch {
        // No bundle for this candidate — try the next, or fall through to '{}'.
      }
    }
    return '{}';
  })();
  return l10nBundleJsonPromise;
}

async function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const webviewDir = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'main.js'));
  const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'layoutWorker.js'));
  const nonce = getNonce();
  const l10nBundleJson = await loadL10nBundleJson(extensionUri);

  const csp = [
    `default-src 'none'`,
    // data: is needed for the PNG export path, which rasterizes the graph
    // by loading a data: SVG into an <img> before drawing it to a <canvas>
    // (a blob: source taints the canvas for readback in this webview host).
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    // Worker scripts are loaded via fetch() + a blob: URL (see main.ts),
    // since a webview resource URI can't be passed to `new Worker()` directly.
    `connect-src ${webview.cspSource}`,
    `worker-src blob:`,
  ].join('; ');

  const templatePath = vscode.Uri.joinPath(webviewDir, 'panel.html').fsPath;
  const template = await fs.readFile(templatePath, 'utf-8');

  return template
    .replaceAll('__CSP__', csp)
    .replaceAll('__NONCE__', nonce)
    .replaceAll('__SCRIPT_URI__', scriptUri.toString())
    .replaceAll('__WORKER_URI__', workerUri.toString())
    .replaceAll('__L10N_BUNDLE_JSON__', l10nBundleJson);
}

// Shared by the compare and checkout-dialog panels: neither needs a Web
// Worker, so their CSP/templating is simpler than the main graph panel's
// getWebviewHtml.
async function getSimplePanelHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  scriptName: string,
  templateName: string,
): Promise<string> {
  const webviewDir = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, scriptName));
  const nonce = getNonce();
  const l10nBundleJson = await loadL10nBundleJson(extensionUri);

  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  const templatePath = vscode.Uri.joinPath(webviewDir, templateName).fsPath;
  const template = await fs.readFile(templatePath, 'utf-8');

  return template
    .replaceAll('__CSP__', csp)
    .replaceAll('__NONCE__', nonce)
    .replaceAll('__SCRIPT_URI__', scriptUri.toString())
    .replaceAll('__L10N_BUNDLE_JSON__', l10nBundleJson);
}

function getComparePanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  return getSimplePanelHtml(webview, extensionUri, 'compare.js', 'comparePanel.html');
}

function getCheckoutDialogHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  return getSimplePanelHtml(webview, extensionUri, 'checkoutDialog.js', 'checkoutDialog.html');
}

async function getWelcomeViewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, versionText: string): Promise<string> {
  const html = await getSimplePanelHtml(webview, extensionUri, 'welcomeView.js', 'welcomeView.html');
  return html.replaceAll('__VERSION_TEXT__', versionText);
}
