// Extension host entry point: registers `revisionGraph.show`, fetches the
// commit DAG via the git CLI, reduces it, and hosts the webview that lays it
// out (in a Web Worker) and renders it as SVG.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { reduceDag } from './git/dagReducer';
import { diffFileChanges, getCommitSummary, readFileAtRevision } from './git/gitActions';
import { fetchCommits } from './git/logReader';
import type {
  CompareData,
  CompareHostToWebviewMessage,
  CompareWebviewToHostMessage,
  HostToWebviewMessage,
  LogScopeOptions,
  ReduceOptions,
  WebviewToHostMessage,
} from './shared/types';

const DEFAULT_SCOPE: LogScopeOptions = { scope: 'all-branches' };
const DEFAULT_REDUCE_OPTIONS: ReduceOptions = { showAllTags: false, collapseStraightRuns: true };

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
  );
}

export function deactivate(): void {}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function showRevisionGraph(context: vscode.ExtensionContext): Promise<void> {
  const cwd = getWorkspaceRoot();
  if (!cwd) {
    vscode.window.showErrorMessage('Git Revision Graph: open a folder first.');
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'revisionGraph',
    'Git Revision Graph',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    },
  );

  panel.webview.html = await getWebviewHtml(panel.webview, context.extensionUri);

  let scope: LogScopeOptions = DEFAULT_SCOPE;
  let reduce: ReduceOptions = DEFAULT_REDUCE_OPTIONS;
  // Filter changes can arrive faster than the git log they trigger resolves
  // (e.g. rapidly toggling checkboxes); only the latest request's result
  // should ever reach the webview.
  let requestGeneration = 0;

  const refresh = async () => {
    const generation = ++requestGeneration;
    try {
      const commits = await fetchCommits(cwd, scope);
      const reduced = reduceDag(commits, reduce);
      if (generation !== requestGeneration) return;
      const message: HostToWebviewMessage = { type: 'graphData', commits: reduced };
      await panel.webview.postMessage(message);
    } catch (err) {
      if (generation !== requestGeneration) return;
      const message: HostToWebviewMessage = { type: 'error', message: (err as Error).message };
      await panel.webview.postMessage(message);
    }
  };

  panel.webview.onDidReceiveMessage(async (message: WebviewToHostMessage) => {
    if (message.type === 'ready') {
      await refresh();
    } else if (message.type === 'setFilter') {
      scope = message.scope;
      reduce = message.reduce;
      await refresh();
    } else if (message.type === 'error') {
      vscode.window.showErrorMessage(`Git Revision Graph: ${message.message}`);
    } else if (message.type === 'compare') {
      await showCompareChanges(context, cwd, message.from, message.to);
    }
  });
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
    vscode.window.showErrorMessage(`Git Revision Graph: compare failed (${(err as Error).message})`);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'revisionGraphCompare',
    'Changed Files',
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
  const title = `${path} (${from.slice(0, 7)} ↔ ${to.slice(0, 7)})`;
  await vscode.commands.executeCommand('vscode.diff', fromUri, toUri, title);
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

async function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const webviewDir = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'main.js'));
  const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'layoutWorker.js'));
  const nonce = getNonce();

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource}`,
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
    .replaceAll('__WORKER_URI__', workerUri.toString());
}

async function getComparePanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const webviewDir = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'compare.js'));
  const nonce = getNonce();

  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  const templatePath = vscode.Uri.joinPath(webviewDir, 'comparePanel.html').fsPath;
  const template = await fs.readFile(templatePath, 'utf-8');

  return template.replaceAll('__CSP__', csp).replaceAll('__NONCE__', nonce).replaceAll('__SCRIPT_URI__', scriptUri.toString());
}
