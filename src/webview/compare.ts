// Webview entry point for the "Changed Files" compare panel: a lightweight,
// static-table view (no layout engine, no worker) listing per-file
// added/deleted line counts between two revisions, TortoiseGit-style.
// Clicking a row asks the extension host to open that file's diff in
// VSCode's native diff editor.

import type { CompareData, CompareHostToWebviewMessage, CompareWebviewToHostMessage, FileChange } from '../shared/types';

declare function acquireVsCodeApi(): { postMessage(message: CompareWebviewToHostMessage): void };

const vscode = acquireVsCodeApi();

const fromRevEl = document.getElementById('from-rev');
const toRevEl = document.getElementById('to-rev');
const fileListEl = document.getElementById('file-list');

if (!fromRevEl || !toRevEl || !fileListEl) {
  throw new Error('Git Revision Graph: compare panel markup is missing expected elements');
}

function statusLabel(status: FileChange['status']): string {
  switch (status) {
    case 'added':
      return 'Added';
    case 'deleted':
      return 'Deleted';
    case 'modified':
      return 'Modified';
    default:
      return 'Other';
  }
}

function fileExtension(path: string): string {
  const lastDot = path.lastIndexOf('.');
  const lastSlash = path.lastIndexOf('/');
  return lastDot > lastSlash ? path.slice(lastDot + 1) : '';
}

function buildRow(file: FileChange): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.addEventListener('click', () => {
    const message: CompareWebviewToHostMessage = { type: 'openFile', path: file.path };
    vscode.postMessage(message);
  });

  const pathCell = document.createElement('td');
  pathCell.textContent = file.path;
  row.appendChild(pathCell);

  const extCell = document.createElement('td');
  extCell.textContent = fileExtension(file.path);
  row.appendChild(extCell);

  const statusCell = document.createElement('td');
  statusCell.textContent = statusLabel(file.status);
  row.appendChild(statusCell);

  const addedCell = document.createElement('td');
  addedCell.className = 'added';
  addedCell.textContent = file.added !== undefined ? String(file.added) : '';
  row.appendChild(addedCell);

  const deletedCell = document.createElement('td');
  deletedCell.className = 'deleted';
  deletedCell.textContent = file.deleted !== undefined ? String(file.deleted) : '';
  row.appendChild(deletedCell);

  return row;
}

function render(data: CompareData): void {
  fromRevEl!.textContent = `${data.from.hash.slice(0, 7)}: ${data.from.subject}`;
  toRevEl!.textContent = `${data.to.hash.slice(0, 7)}: ${data.to.subject}`;
  fileListEl!.replaceChildren(...data.files.map(buildRow));
}

window.addEventListener('message', (event: MessageEvent<CompareHostToWebviewMessage>) => {
  if (event.data.type === 'compareData') {
    render(event.data.data);
  }
});

vscode.postMessage({ type: 'ready' });
