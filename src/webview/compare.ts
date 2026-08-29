// Webview entry point for the "Changed Files" compare panel: a lightweight,
// static-table view (no layout engine, no worker) listing per-file
// added/deleted line counts between two revisions, TortoiseGit-style.
// Clicking a row asks the extension host to open that file's diff in
// VSCode's native diff editor.

import type { CompareData, CompareHostToWebviewMessage, CompareWebviewToHostMessage, FileChange } from '../shared/types';
import { applyLocalization, t } from './l10n';
import { showContextMenu, type ContextMenuItem } from './render/contextMenu';

declare function acquireVsCodeApi(): { postMessage(message: CompareWebviewToHostMessage): void };

const vscode = acquireVsCodeApi();
applyLocalization(document);

const fromRevEl = document.getElementById('from-rev');
const toRevEl = document.getElementById('to-rev');
const fileListEl = document.getElementById('file-list');

if (!fromRevEl || !toRevEl || !fileListEl) {
  throw new Error(t('Git Revision Graph: compare panel markup is missing expected elements'));
}

function statusLabel(status: FileChange['status']): string {
  switch (status) {
    case 'added':
      return t('Added');
    case 'deleted':
      return t('Deleted');
    case 'modified':
      return t('Modified');
    default:
      return t('Other');
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

  // Without this, right-clicking a row falls through to the webview's
  // native OS edit menu (Cut/Copy/Paste) -- meaningless here since the row
  // isn't editable text. Same fix as the Show Log panel's own file rows.
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const items: ContextMenuItem[] = [
      {
        label: t('Copy path'),
        onClick: () => {
          void navigator.clipboard.writeText(file.path + '\n');
        },
      },
    ];
    showContextMenu(event.clientX, event.clientY, items);
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
  fromRevEl!.textContent = t('{0}: {1}', data.from.hash.slice(0, 7), data.from.subject);
  toRevEl!.textContent = t('{0}: {1}', data.to.hash.slice(0, 7), data.to.subject);
  fileListEl!.replaceChildren(...data.files.map(buildRow));
}

window.addEventListener('message', (event: MessageEvent<CompareHostToWebviewMessage>) => {
  if (event.data.type === 'compareData') {
    render(event.data.data);
  }
});

vscode.postMessage({ type: 'ready' });
