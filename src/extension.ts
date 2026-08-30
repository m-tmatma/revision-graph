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
  getDiffBase,
  getLogEntries,
  isBranchMerged,
  listCheckoutCandidates,
  listMergedLocalBranches,
  readFileAtRevision,
  renameLocalBranch,
  tagExists,
  updateSubmodules,
} from './git/gitActions';
import { fetchCommits } from './git/logReader';
import { watchRepositoryChanges } from './git/repoWatcher';
import type {
  CheckoutOptions,
  CheckoutTarget,
  CompareData,
  CompareHostToWebviewMessage,
  CompareWebviewToHostMessage,
  HostToWebviewMessage,
  LogHostToWebviewMessage,
  LogScopeOptions,
  LogWebviewToHostMessage,
  RefType,
  ReduceOptions,
  WebviewToHostMessage,
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
// command. URI shape: `revision-graph-git:/<repo-relative-path>?<rev>` -- the
// revision goes in the query, not the URI authority: a branch/remote-tracking
// name commonly contains a `/` (e.g. `origin/main`), and a URI authority
// component ends at its first `/`, silently splitting such a revision into
// the wrong authority/path pair.
const GIT_SHOW_SCHEME = 'revision-graph-git';

// The currently-open main graph panel's own refresh function, if any --
// lets a checkout triggered from a *different* panel (e.g. the Show Log
// panel's own "Checkout" item) bring that graph's current-branch highlight
// up to date immediately, the same way checking out from the graph itself
// does, rather than relying solely on repoWatcher's debounced external-
// change detection. Cleared when that panel is disposed.
let activeGraphRefresh: ((focusOnHead?: boolean) => Promise<void>) | undefined;

// The Activity Bar container's sole view, and the currently-shown commit's
// startRef/label -- read by createLogSidebarProvider on (re)resolve, and
// written by the main graph's "showLog" handler to retarget an
// already-resolved view. `label` stays undefined for the default "current
// branch" state so the view keeps its normal title instead of being
// permanently relabeled after the very first resolve.
let logSidebarView: vscode.WebviewView | undefined;
let logSidebarRefresh: (() => Promise<void>) | undefined;
let logTarget: { startRef: string; label: string | undefined } = { startRef: 'HEAD', label: undefined };

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('revisionGraph.show', () => showRevisionGraph(context)),
    vscode.workspace.registerTextDocumentContentProvider(GIT_SHOW_SCHEME, {
      provideTextDocumentContent(uri) {
        const cwd = getWorkspaceRoot();
        if (!cwd) return '';
        const path = decodeURIComponent(uri.path.replace(/^\//, ''));
        return readFileAtRevision(cwd, uri.query, path);
      },
    }),
    vscode.window.registerWebviewViewProvider('revisionGraph.welcomeView', createLogSidebarProvider(context)),
  );
}

// The Activity Bar container's sole view: a persistent commit-log view
// (defaulting to the current branch), a "Show Revision Graph" button, and a
// version-info button (see __BUILD_COMMIT__ above) so a stale Extension
// Development Host or installed build is easy to spot at a glance.
// Retargeted to a specific commit by the main graph's "Show Log"
// context-menu item instead of that opening a separate editor tab.
function createLogSidebarProvider(context: vscode.ExtensionContext): vscode.WebviewViewProvider {
  return {
    resolveWebviewView(webviewView) {
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      };

      logSidebarView = webviewView;
      webviewView.title = logTarget.label;
      webviewView.onDidDispose(() => {
        if (logSidebarView === webviewView) {
          logSidebarView = undefined;
          logSidebarRefresh = undefined;
        }
      });

      void getLogSidebarHtml(webviewView.webview, context.extensionUri).then((html) => {
        webviewView.webview.html = html;
      });

      // Shared by both branches below: neither needs cwd, so they're
      // handled identically whether or not a workspace is open.
      const handleCommonMessage = (message: LogWebviewToHostMessage): boolean => {
        if (message.type === 'show') {
          void vscode.commands.executeCommand('revisionGraph.show');
          return true;
        }
        if (message.type === 'showVersionInfo') {
          void showVersionInfoMessage(context);
          return true;
        }
        return false;
      };

      const cwd = getWorkspaceRoot();
      if (!cwd) {
        // No wiring beyond the buttons and an error in place of a log that
        // has nothing to read -- otherwise the client's initial "ready"
        // message has nothing listening for it, and the view sits on its
        // "Loading…" placeholder forever instead of saying why.
        webviewView.webview.onDidReceiveMessage((message: LogWebviewToHostMessage) => {
          if (handleCommonMessage(message)) return;
          if (message.type === 'ready') {
            const hostMessage: LogHostToWebviewMessage = {
              type: 'logError',
              message: vscode.l10n.t('open a folder first.'),
            };
            void webviewView.webview.postMessage(hostMessage);
          }
        });
        return;
      }

      const { refreshLog, handleMessage } = wireLogWebview(context, cwd, webviewView.webview, () => logTarget.startRef);
      logSidebarRefresh = refreshLog;

      webviewView.webview.onDidReceiveMessage(async (message: LogWebviewToHostMessage) => {
        if (handleCommonMessage(message)) return;
        await handleMessage(message);
      });
    },
  };
}

function getVersionText(context: vscode.ExtensionContext): string {
  return __BUILD_NUMBER__
    ? vscode.l10n.t(
        'Version {0} ({1}, build {2})',
        context.extension.packageJSON.version,
        __BUILD_COMMIT__,
        __BUILD_NUMBER__,
      )
    : vscode.l10n.t('Version {0} ({1})', context.extension.packageJSON.version, __BUILD_COMMIT__);
}

// Shows the version/build info via a native notification instead of inline
// in the sidebar, freeing up that space for more of the log -- "Copy"
// copies the same text the notification displays.
async function showVersionInfoMessage(context: vscode.ExtensionContext): Promise<void> {
  const versionText = getVersionText(context);
  const copyLabel = vscode.l10n.t('Copy');
  const selection = await vscode.window.showInformationMessage(versionText, copyLabel);
  if (selection === copyLabel) {
    await vscode.env.clipboard.writeText(versionText);
  }
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

  // Wraps `refresh` so that a repo-mutating action triggered from *this*
  // panel (checkout, create branch/tag, delete/rename ref, fetch, ...) also
  // brings the sidebar's log up to date when it's showing the default
  // current-branch view -- the reverse direction of wireLogWebview's own
  // refreshAfterRepoChange, which already keeps this graph in sync with
  // actions taken from the sidebar. Only refreshes the sidebar when it's on
  // 'HEAD': if it's been retargeted to a specific commit (via "Show Log"),
  // an unrelated checkout elsewhere shouldn't change what it's displaying.
  const refreshEverything = async (focusOnHead?: boolean) => {
    await Promise.all([refresh(focusOnHead), logTarget.startRef === 'HEAD' ? logSidebarRefresh?.() : undefined]);
  };

  // Refreshes on external repo changes too (a checkout done outside this
  // extension, a commit, a pull, ...), not just after our own
  // checkout/delete-ref actions, which already refresh explicitly.
  const repoWatcher = watchRepositoryChanges(cwd, () => void refreshEverything());
  activeGraphRefresh = refresh;
  panel.onDidDispose(() => {
    repoWatcher.dispose();
    if (activeGraphRefresh === refresh) activeGraphRefresh = undefined;
  });

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
      await showCompareChanges(context, cwd, message.from, message.to, message.fromLabel, message.toLabel);
    } else if (message.type === 'compareWithDefaultBranch') {
      try {
        const defaultBranch = await getDefaultBranchRef(cwd);
        await showCompareChanges(context, cwd, defaultBranch, message.to, undefined, message.toLabel);
      } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: {0}', (err as Error).message));
      }
    } else if (message.type === 'compareWithCurrentBranch') {
      await showCompareChanges(context, cwd, 'HEAD', message.to, message.fromLabel, message.toLabel);
    } else if (message.type === 'copyCommitInfo') {
      try {
        const text = await getCommitShowSummary(cwd, message.commitId);
        await vscode.env.clipboard.writeText(text);
      } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: {0}', (err as Error).message));
      }
    } else if (message.type === 'requestCommitTooltip') {
      // Best-effort: on failure, the error message itself becomes the
      // tooltip text (e.g. a stale commitId after a rebase moved history
      // out from under a still-rendered node) rather than a dedicated error
      // UI -- there's nothing actionable for the user to do about a hover
      // tooltip failing beyond seeing why. Kept as a separate message type
      // from the success case regardless, so the webview's cache never
      // stores a transient failure as if it were the real commit summary.
      try {
        const text = await getCommitShowSummary(cwd, message.commitId);
        const hostMessage: HostToWebviewMessage = { type: 'commitTooltip', commitId: message.commitId, text };
        await panel.webview.postMessage(hostMessage);
      } catch (err) {
        const hostMessage: HostToWebviewMessage = {
          type: 'commitTooltipError',
          commitId: message.commitId,
          message: (err as Error).message,
        };
        await panel.webview.postMessage(hostMessage);
      }
    } else if (message.type === 'openCheckoutDialog') {
      await showCheckoutDialog(
        cwd,
        { ref: message.ref, label: message.label, suggestedBranchName: message.suggestedBranchName },
        refreshEverything,
      );
    } else if (message.type === 'deleteRef') {
      await handleDeleteRef(cwd, message.refType, message.refName, refreshEverything);
    } else if (message.type === 'renameRef') {
      await handleRenameRef(cwd, message.refName, refreshEverything);
    } else if (message.type === 'deleteMergedBranches') {
      await handleDeleteMergedBranches(cwd, refreshEverything);
    } else if (message.type === 'showLog') {
      logTarget = { startRef: message.commitId, label: message.label };
      if (logSidebarView) {
        logSidebarView.title = message.label;
        logSidebarView.show(true);
        await logSidebarRefresh?.();
      } else {
        // Not resolved yet (the Activity Bar container has never been
        // opened this session) -- <viewId>.focus is VS Code's own
        // auto-generated command to reveal (and thus resolve) a
        // contributed view; resolveWebviewView then picks up the
        // logTarget set just above on its own.
        await vscode.commands.executeCommand('revisionGraph.welcomeView.focus');
      }
    } else if (message.type === 'createBranch') {
      await handleCreateBranch(cwd, message.startPoint, refreshEverything);
    } else if (message.type === 'createTag') {
      await handleCreateTag(cwd, message.startPoint, refreshEverything);
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
      await showIncrementalCheckout(cwd, refreshEverything);
    } else if (message.type === 'fetch') {
      if (fetchInProgress) return;
      fetchInProgress = true;
      try {
        await handleFetch(cwd, refreshEverything);
      } finally {
        fetchInProgress = false;
      }
    }
  });
}

async function showIncrementalCheckout(cwd: string, refresh: (focusOnHead?: boolean) => Promise<void>): Promise<void> {
  let candidates: Awaited<ReturnType<typeof listCheckoutCandidates>>;
  try {
    candidates = await listCheckoutCandidates(cwd);
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: {0}', (err as Error).message));
    return;
  }
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
  fromLabel?: string,
  toLabel?: string,
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

  // Distinguishes multiple Compare tabs open at once from each other --
  // fromLabel/toLabel (when the caller supplied one) is the commit's own
  // branch/tag name, e.g. "main" or a tag pointed at the compared commit;
  // shortRev falls back to the original ref name when `from`/`to` was
  // already one itself (e.g. "HEAD" from compareWithCurrentBranch) rather
  // than resolving it down to a hash, and only shortens an actual full
  // commit hash (the two-commit-selection case with no label).
  const panel = vscode.window.createWebviewPanel(
    'revisionGraphCompare',
    vscode.l10n.t('{0} ↔ {1}', fromLabel ?? shortRev(from), toLabel ?? shortRev(to)),
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

// `from`/`to` aren't always commit hashes -- compareWithDefaultBranch passes
// a branch name (e.g. "origin/main") and compareWithCurrentBranch passes
// "HEAD", and truncating either to 7 characters produces a misleading
// label (e.g. "origin/"). Only a real full hash gets shortened.
function shortRev(rev: string): string {
  return /^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 7) : rev;
}

async function openFileDiff(from: string, to: string, path: string): Promise<void> {
  const fromUri = vscode.Uri.from({ scheme: GIT_SHOW_SCHEME, path: `/${path}`, query: from });
  const toUri = vscode.Uri.from({ scheme: GIT_SHOW_SCHEME, path: `/${path}`, query: to });
  const title = vscode.l10n.t('{0} ({1} ↔ {2})', path, shortRev(from), shortRev(to));
  // Explicit ViewColumn.Beside: without it, vscode.diff opens in the
  // active editor group -- which, since this is always triggered from a
  // click inside the Compare/Log webview panel, is that panel's own
  // column, competing with it for space instead of opening alongside it.
  // preview: true reuses that same tab (VSCode's italic-title "preview"
  // mode) on the next file click instead of accumulating a new pinned tab
  // per file. preserveFocus: true keeps the webview panel itself the
  // active editor group throughout -- without it, focus jumps to the
  // diff on the first click, so the *second* click's "Beside" (now
  // relative to that diff, not the webview) opens yet another column
  // beside it instead of reusing the first, defeating both of the above.
  await vscode.commands.executeCommand('vscode.diff', fromUri, toUri, title, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true,
    preserveFocus: true,
  });
}

interface LogWebviewHandle {
  refreshLog: () => Promise<void>;
  handleMessage: (message: LogWebviewToHostMessage) => Promise<void>;
}

// Shared by the log sidebar (the only caller now, but kept generic over
// `webview` rather than assuming a WebviewView) since the same message
// protocol and git-command wiring applies regardless of what's hosting it.
// `getStartRef` is a getter rather than a plain value so a caller whose
// target can change over time (the sidebar, retargeted by "Show Log") can
// have `refreshLog` always re-read the current one instead of closing over
// a stale ref from whenever the webview first resolved.
function wireLogWebview(
  context: vscode.ExtensionContext,
  cwd: string,
  webview: vscode.Webview,
  getStartRef: () => string,
): LogWebviewHandle {
  // Re-fetches this same ref's history and refs (e.g. after a checkout done
  // from this panel's own "Checkout" item moves the current-branch badge),
  // as well as the initial load.
  const refreshLog = async () => {
    try {
      const entries = await getLogEntries(cwd, getStartRef());
      const hostMessage: LogHostToWebviewMessage = { type: 'logData', data: { entries } };
      await webview.postMessage(hostMessage);
    } catch (err) {
      vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: {0}', (err as Error).message));
      const hostMessage: LogHostToWebviewMessage = { type: 'logError', message: (err as Error).message };
      await webview.postMessage(hostMessage);
    }
  };

  // Shared by every action below that can add or move a ref (checkout,
  // create branch, create tag): brings the main graph panel's own view up
  // to date immediately, if one happens to be open, alongside this panel's
  // own history/ref badges -- rather than leaving either to repoWatcher's
  // debounced external-change detection.
  const refreshAfterRepoChange = async (focusOnHead?: boolean) => {
    await Promise.all([activeGraphRefresh?.(focusOnHead), refreshLog()]);
  };

  const handleMessage = async (message: LogWebviewToHostMessage): Promise<void> => {
    if (message.type === 'ready') {
      await refreshLog();
    } else if (message.type === 'selectCommit') {
      try {
        const base = await getDiffBase(cwd, message.hash);
        const files = await diffFileChanges(cwd, base, message.hash);
        const hostMessage: LogHostToWebviewMessage = { type: 'diffData', commitHash: message.hash, files };
        await webview.postMessage(hostMessage);
      } catch (err) {
        const hostMessage: LogHostToWebviewMessage = {
          type: 'diffError',
          commitHash: message.hash,
          message: (err as Error).message,
        };
        await webview.postMessage(hostMessage);
      }
    } else if (message.type === 'openFile') {
      try {
        const base = await getDiffBase(cwd, message.commitHash);
        await openFileDiff(base, message.commitHash, message.path);
      } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: {0}', (err as Error).message));
      }
    } else if (message.type === 'copyCommitInfo') {
      try {
        const text = await getCommitShowSummary(cwd, message.hash);
        await vscode.env.clipboard.writeText(text);
      } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: {0}', (err as Error).message));
      }
    } else if (message.type === 'requestCommitTooltip') {
      // Best-effort, same rationale as the main graph's own handler for
      // this message: the error text becomes the tooltip on failure, but
      // as a separate message type so it's never cached as a real summary.
      try {
        const text = await getCommitShowSummary(cwd, message.hash);
        const hostMessage: LogHostToWebviewMessage = { type: 'commitTooltip', hash: message.hash, text };
        await webview.postMessage(hostMessage);
      } catch (err) {
        const hostMessage: LogHostToWebviewMessage = {
          type: 'commitTooltipError',
          hash: message.hash,
          message: (err as Error).message,
        };
        await webview.postMessage(hostMessage);
      }
    } else if (message.type === 'openCheckoutDialog') {
      await showCheckoutDialog(
        cwd,
        { ref: message.ref, label: message.label, suggestedBranchName: message.suggestedBranchName },
        refreshAfterRepoChange,
      );
    } else if (message.type === 'createBranch') {
      await handleCreateBranch(cwd, message.startPoint, refreshAfterRepoChange);
    } else if (message.type === 'createTag') {
      await handleCreateTag(cwd, message.startPoint, refreshAfterRepoChange);
    } else if (message.type === 'compareWithCurrentBranch') {
      await showCompareChanges(context, cwd, 'HEAD', message.to, message.fromLabel, message.toLabel);
    } else if (message.type === 'compare') {
      await showCompareChanges(context, cwd, message.from, message.to, message.fromLabel, message.toLabel);
    }
  };

  return { refreshLog, handleMessage };
}

interface CheckoutFlagItem extends vscode.QuickPickItem {
  flag: 'track' | 'overwriteExisting' | 'force' | 'merge' | 'updateSubmodules';
}

// A native QuickPick instead of a WebviewPanel: a webview panel always
// occupies a full editor column (min. ~50% of the window width when opened
// beside the main graph) no matter how narrow its own content is, which is
// far more screen space than this small options form needs. QuickPick
// floats above the editor grid instead, so the main graph's column keeps
// its full width throughout.
//
// Uses the lower-level `createQuickPick` API rather than the `showQuickPick`
// convenience wrapper so the QuickPick's own filter input box can double as
// the new-branch-name field (via `alwaysShow` on every item, the flag list
// stays fully visible no matter what's typed) instead of a separate
// InputBox step -- typing a name *is* the "create a new branch" signal, so
// there's no separate checkbox for it either.
async function showCheckoutDialog(
  cwd: string,
  target: CheckoutTarget,
  refreshGraph: (focusOnHead?: boolean) => Promise<void>,
): Promise<void> {
  // These only take effect when a branch name was typed (see checkoutRef in
  // gitActions.ts) -- offering them regardless is harmless since picking
  // them without a name simply has no effect.
  const items: CheckoutFlagItem[] = [
    { flag: 'track', label: vscode.l10n.t('Track'), alwaysShow: true },
    { flag: 'overwriteExisting', label: vscode.l10n.t('Overwrite existing branch if present'), alwaysShow: true },
    { flag: 'force', label: vscode.l10n.t('Force (overwrite local changes)'), alwaysShow: true },
    { flag: 'merge', label: vscode.l10n.t('Merge local changes'), alwaysShow: true },
    { flag: 'updateSubmodules', label: vscode.l10n.t('Update submodules (init + update --recursive)'), alwaysShow: true },
  ];

  const quickPick = vscode.window.createQuickPick<CheckoutFlagItem>();
  quickPick.title = vscode.l10n.t('Switch to {0}', target.label);
  quickPick.placeholder = vscode.l10n.t('New branch name (optional); select options below, then press Enter');
  quickPick.canSelectMany = true;
  quickPick.items = items;
  // A remote-tracking branch with no local branch of its own implies
  // creating one, same as `git checkout <remote-branch>` would offer.
  quickPick.value = target.suggestedBranchName ?? '';
  quickPick.selectedItems = target.suggestedBranchName ? items.filter((item) => item.flag === 'track') : [];

  const accepted = await new Promise<{ name: string; selected: readonly CheckoutFlagItem[] } | undefined>(
    (resolve) => {
      let result: { name: string; selected: readonly CheckoutFlagItem[] } | undefined;
      quickPick.onDidAccept(() => {
        result = { name: quickPick.value.trim(), selected: quickPick.selectedItems };
        quickPick.hide();
      });
      quickPick.onDidHide(() => {
        resolve(result);
        quickPick.dispose();
      });
      quickPick.show();
    },
  );
  if (!accepted) return;

  const selectedFlags = new Set(accepted.selected.map((item) => item.flag));
  const options: CheckoutOptions = {
    createBranch: accepted.name !== '',
    newBranchName: accepted.name,
    track: selectedFlags.has('track'),
    overwriteExisting: selectedFlags.has('overwriteExisting'),
    force: selectedFlags.has('force'),
    merge: selectedFlags.has('merge'),
    updateSubmodules: selectedFlags.has('updateSubmodules'),
  };

  try {
    await checkoutRef(cwd, target.ref, options);
    vscode.window.showInformationMessage(vscode.l10n.t('Git Revision Graph: checked out {0}', target.label));
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: checkout failed ({0})', (err as Error).message));
    return;
  }

  // Checkout already succeeded at this point, so a submodule-update
  // failure is reported separately rather than as a checkout failure --
  // and the graph still refreshes either way.
  if (options.updateSubmodules) {
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
    try {
      isUnmergedLocalBranch = !(await isBranchMerged(cwd, refName));
    } catch (err) {
      // e.g. refName no longer exists (deleted outside this extension) --
      // `git merge-base --is-ancestor` then exits with neither 0 nor 1,
      // which isBranchMerged treats as a real failure rather than "not
      // merged". Reported the same way the actual delete below reports a
      // failure, rather than letting it propagate out of this message
      // handler with no feedback at all.
      vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: delete failed ({0})', (err as Error).message));
      return;
    }
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

async function handleDeleteMergedBranches(cwd: string, refreshGraph: () => Promise<void>): Promise<void> {
  let candidates: string[];
  try {
    candidates = await listMergedLocalBranches(cwd);
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Git Revision Graph: {0}', (err as Error).message));
    return;
  }
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(
      vscode.l10n.t('Git Revision Graph: no local branches are fully merged into the current branch.'),
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map((name) => ({ label: name, picked: true })),
    {
      canPickMany: true,
      placeHolder: vscode.l10n.t('Select merged branches to delete'),
    },
  );
  if (!picked || picked.length === 0) return;

  const deleteActionLabel = vscode.l10n.t('Delete');
  const confirmed = await vscode.window.showWarningMessage(
    vscode.l10n.t('Delete {0} branch(es)? This cannot be undone.', String(picked.length)),
    { modal: true },
    deleteActionLabel,
  );
  if (confirmed !== deleteActionLabel) return;

  const failures: string[] = [];
  for (const item of picked) {
    try {
      // Already confirmed merged by listMergedLocalBranches, so a safe
      // (non-force) delete is expected to succeed.
      await deleteLocalBranch(cwd, item.label);
    } catch (err) {
      failures.push(vscode.l10n.t('{0} ({1})', item.label, (err as Error).message));
    }
  }

  const deletedCount = picked.length - failures.length;
  if (deletedCount > 0) {
    vscode.window.showInformationMessage(vscode.l10n.t('Git Revision Graph: deleted {0} branch(es).', String(deletedCount)));
  }
  if (failures.length > 0) {
    vscode.window.showErrorMessage(
      vscode.l10n.t('Git Revision Graph: failed to delete: {0}', failures.join(', ')),
    );
  }
  await refreshGraph();
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
    .replaceAll('__L10N_BUNDLE_JSON__', l10nBundleJson)
    .replaceAll('__LANG__', vscode.env.language);
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
    .replaceAll('__L10N_BUNDLE_JSON__', l10nBundleJson)
    .replaceAll('__LANG__', vscode.env.language);
}

function getComparePanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  return getSimplePanelHtml(webview, extensionUri, 'compare.js', 'comparePanel.html');
}

function getLogSidebarHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  return getSimplePanelHtml(webview, extensionUri, 'log.js', 'logPanel.html');
}
