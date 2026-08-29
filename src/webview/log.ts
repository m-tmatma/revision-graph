// Webview entry point for the "Show Log" panel: a scrollable list of a
// commit and its ancestors, TortoiseGit "Log" dialog-style, with branch/
// merge topology drawn as a small per-row graph (see logLanes.ts). Clicking
// a commit expands its changed files inline, directly under that row
// (collapsing whichever commit was previously expanded); clicking a file
// row opens it in VSCode's native diff editor, same as the Compare panel.

import type { FileChange, LogEntry, LogHostToWebviewMessage, LogWebviewToHostMessage, RefInfo } from '../shared/types';
import { applyLocalization, t } from './l10n';
import { resolveCheckoutTarget } from './render/checkoutTarget';
import { contrastTextColor, REF_COLORS } from './render/colors';
import { showContextMenu, type ContextMenuItem } from './render/contextMenu';
import { createSvgElement, formatDate } from './render/graphRenderer';
import { computeLanes, type LaneRow } from './render/logLanes';

// Pixel geometry for each row's lane-graph column — kept in lockstep with
// the matching row height in logPanel.html's CSS (.commit-button).
const ROW_HEIGHT = 40;
const LANE_WIDTH = 16;
const LANE_COLORS = [
  'var(--vscode-charts-blue, #3794ff)',
  'var(--vscode-charts-orange, #d18616)',
  'var(--vscode-charts-green, #89d185)',
  'var(--vscode-charts-purple, #b180d7)',
  'var(--vscode-charts-red, #f14c4c)',
  'var(--vscode-charts-yellow, #cca700)',
];

declare function acquireVsCodeApi(): { postMessage(message: LogWebviewToHostMessage): void };

const vscode = acquireVsCodeApi();
applyLocalization(document);

const commitListEl = document.getElementById('commit-list');

if (!commitListEl) {
  throw new Error(t('Git Revision Graph: log panel markup is missing expected elements'));
}

let expandedHash: string | undefined;
const fileListsByHash = new Map<string, HTMLUListElement>();
const buttonsByHash = new Map<string, HTMLButtonElement>();

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

// Single-letter status codes, git-porcelain-style (A/M/D) — locale-invariant
// by convention, same as git's own --name-status output; statusLabel above
// still supplies a translated word for the hover tooltip / screen readers.
function statusLetter(status: FileChange['status']): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'modified':
      return 'M';
    default:
      return '?';
  }
}

function buildFileRow(hash: string, file: FileChange): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'file-row';

  const button = document.createElement('button');
  button.type = 'button';
  button.addEventListener('click', () => {
    const message: LogWebviewToHostMessage = { type: 'openFile', commitHash: hash, path: file.path };
    vscode.postMessage(message);
  });

  // Same rationale as the commit row's own contextmenu handler above --
  // without this, right-clicking a file falls through to the webview's
  // native OS edit menu (Cut/Copy/Paste), meaningless here since the row
  // isn't editable text.
  button.addEventListener('contextmenu', (event) => {
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

  const path = document.createElement('span');
  path.className = 'file-path';
  path.textContent = file.path;
  button.appendChild(path);

  const status = document.createElement('span');
  status.className = `file-status status-${file.status}`;
  status.textContent = statusLetter(file.status);
  status.title = statusLabel(file.status);
  button.appendChild(status);

  li.appendChild(button);
  return li;
}

function buildFileListStatus(text: string, isError: boolean): HTMLLIElement {
  const li = document.createElement('li');
  li.className = isError ? 'file-list-status error' : 'file-list-status';
  li.textContent = text;
  return li;
}

function collapseCommit(hash: string): void {
  fileListsByHash.get(hash)?.setAttribute('hidden', '');
  buttonsByHash.get(hash)?.setAttribute('aria-expanded', 'false');
}

function expandCommit(hash: string): void {
  if (expandedHash === hash) return;
  if (expandedHash) collapseCommit(expandedHash);
  expandedHash = hash;

  const fileList = fileListsByHash.get(hash);
  const button = buttonsByHash.get(hash);
  if (!fileList || !button) return;

  button.setAttribute('aria-expanded', 'true');
  fileList.removeAttribute('hidden');
  fileList.replaceChildren(buildFileListStatus(t('Loading…'), false));

  const message: LogWebviewToHostMessage = { type: 'selectCommit', hash };
  vscode.postMessage(message);
}

function toggleCommit(hash: string): void {
  if (expandedHash === hash) {
    collapseCommit(hash);
    expandedHash = undefined;
  } else {
    expandCommit(hash);
  }
}

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

function svgLine(x1: number, y1: number, x2: number, y2: number, color: string): SVGLineElement {
  const line = createSvgElement('line');
  line.setAttribute('x1', String(x1));
  line.setAttribute('y1', String(y1));
  line.setAttribute('x2', String(x2));
  line.setAttribute('y2', String(y2));
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '2');
  return line;
}

// Draws one row's git-graph segment: straight lines for lanes just passing
// through, a diagonal where lanes converge (mergeIns) or a merge commit's
// extra parent forks off a new one (forkOuts), and a dot marking this row's
// own commit — decorative (the "Merge" badge and the parent-hashes tooltip
// on the commit's own label carry the same information for screen readers).
function buildLaneGraph(row: LaneRow, laneCount: number): SVGSVGElement {
  const width = laneCount * LANE_WIDTH;
  const midY = ROW_HEIGHT / 2;

  const svg = createSvgElement('svg');
  svg.classList.add('lane-graph');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(ROW_HEIGHT));
  svg.setAttribute('viewBox', `0 0 ${width} ${ROW_HEIGHT}`);
  svg.setAttribute('aria-hidden', 'true');

  for (const lane of row.upperStems) svg.appendChild(svgLine(laneX(lane), 0, laneX(lane), midY, laneColor(lane)));
  for (const lane of row.lowerStems) svg.appendChild(svgLine(laneX(lane), midY, laneX(lane), ROW_HEIGHT, laneColor(lane)));
  for (const lane of row.mergeIns) svg.appendChild(svgLine(laneX(lane), 0, laneX(row.lane), midY, laneColor(lane)));
  for (const lane of row.forkOuts) svg.appendChild(svgLine(laneX(row.lane), midY, laneX(lane), ROW_HEIGHT, laneColor(lane)));

  const dot = createSvgElement('circle');
  dot.setAttribute('cx', String(laneX(row.lane)));
  dot.setAttribute('cy', String(midY));
  dot.setAttribute('r', row.isMerge ? '5' : '3.5');
  dot.setAttribute('fill', laneColor(row.lane));
  if (row.isMerge) {
    dot.setAttribute('stroke', 'var(--vscode-editor-background)');
    dot.setAttribute('stroke-width', '1.5');
  }
  svg.appendChild(dot);

  return svg;
}

// Checkout targets this row's own local branch if it has one, otherwise the
// bare commit hash (a detached-HEAD checkout). Omitted entirely if the row
// IS the current branch already — nothing to do. Same behavior as the main
// graph view's own "Checkout" context-menu item (resolveCheckoutTarget is
// shared between the two).
function checkoutMenuItem(entry: LogEntry): ContextMenuItem | null {
  const target = resolveCheckoutTarget(entry.refs, entry.hash);
  if (!target) return null;

  return {
    label: t('Checkout {0}', target.label),
    onClick: () => {
      const message: LogWebviewToHostMessage = {
        type: 'openCheckoutDialog',
        ref: target.ref,
        label: target.label,
        suggestedBranchName: target.suggestedBranchName,
      };
      vscode.postMessage(message);
    },
  };
}

// Same color-by-ref-type chip the main graph view draws on a node (see
// buildRefRow in graphRenderer.ts), so a branch/tag reads as one visual
// language across both panels -- without this, a commit with a branch
// pointing at it looked identical to any other, and the ref-aware
// "Checkout" item above had nothing on-screen to hint it would resolve to
// a branch name rather than a detached-HEAD checkout.
function buildRefBadge(ref: RefInfo): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = 'ref-badge';
  badge.textContent = ref.name;
  const color = REF_COLORS[ref.type];
  badge.style.backgroundColor = color;
  badge.style.color = contrastTextColor(color);
  return badge;
}

function buildCommitRow(entry: LogEntry, laneRow: LaneRow, laneCount: number): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'commit-row';

  const main = document.createElement('div');
  main.className = 'commit-row-main';
  main.appendChild(buildLaneGraph(laneRow, laneCount));

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'commit-button';
  button.setAttribute('aria-expanded', 'false');

  const subject = document.createElement('span');
  subject.className = 'subject';
  for (const ref of entry.refs) subject.appendChild(buildRefBadge(ref));
  if (laneRow.isMerge) {
    const badge = document.createElement('span');
    badge.className = 'merge-badge';
    badge.textContent = t('Merge');
    subject.appendChild(badge);
  }
  subject.appendChild(document.createTextNode(entry.subject));
  button.appendChild(subject);

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = [entry.hash.slice(0, 7), entry.authorName, formatDate(entry.authorDate)].join(' · ');
  button.appendChild(meta);

  // The graph lines already show the branch topology; the exact parent
  // hashes go in a hover tooltip instead of cluttering the always-visible
  // (single-line, ellipsized) meta text.
  if (laneRow.isMerge) {
    button.title = t('Parents: {0}', entry.parents.map((parent) => parent.slice(0, 7)).join(', '));
  }

  // Attached to the whole row, not just the button, so clicking the
  // lane-graph SVG beside the text also toggles this commit -- the SVG
  // isn't itself an interactive element (it's aria-hidden, decorative),
  // so a click there wouldn't otherwise reach anything.
  main.addEventListener('click', () => toggleCommit(entry.hash));

  // Without this, right-clicking a row falls through to the webview's
  // native OS edit menu (Cut/Copy/Paste) -- meaningless here since none of
  // this row is editable text. A small custom menu with actions that
  // actually apply to a commit replaces it, same pattern as the main
  // graph view's node context menu.
  main.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const items: ContextMenuItem[] = [];

    const checkoutItem = checkoutMenuItem(entry);
    if (checkoutItem) items.push(checkoutItem);

    items.push(
      {
        label: t('Create branch here…'),
        onClick: () => {
          const message: LogWebviewToHostMessage = { type: 'createBranch', startPoint: entry.hash };
          vscode.postMessage(message);
        },
      },
      {
        label: t('Create tag here…'),
        onClick: () => {
          const message: LogWebviewToHostMessage = { type: 'createTag', startPoint: entry.hash };
          vscode.postMessage(message);
        },
      },
      {
        label: t('Copy full hash'),
        onClick: () => {
          void navigator.clipboard.writeText(entry.hash + '\n');
        },
      },
      {
        label: t('Copy commit info'),
        onClick: () => {
          const message: LogWebviewToHostMessage = { type: 'copyCommitInfo', hash: entry.hash };
          vscode.postMessage(message);
        },
      },
    );
    showContextMenu(event.clientX, event.clientY, items);
  });

  main.appendChild(button);
  li.appendChild(main);

  const fileList = document.createElement('ul');
  fileList.className = 'file-list';
  fileList.setAttribute('hidden', '');
  li.appendChild(fileList);

  buttonsByHash.set(entry.hash, button);
  fileListsByHash.set(entry.hash, fileList);

  return li;
}

function render(entries: LogEntry[]): void {
  fileListsByHash.clear();
  buttonsByHash.clear();
  expandedHash = undefined;

  const { rows, laneCount } = computeLanes(entries);
  commitListEl!.replaceChildren(...entries.map((entry, i) => buildCommitRow(entry, rows[i], laneCount)));
  if (entries.length > 0) expandCommit(entries[0].hash);
}

function renderLogError(message: string): void {
  fileListsByHash.clear();
  buttonsByHash.clear();
  expandedHash = undefined;

  const li = document.createElement('li');
  li.className = 'file-list-status error';
  li.textContent = t('Git Revision Graph: {0}', message);
  commitListEl!.replaceChildren(li);
}

window.addEventListener('message', (event: MessageEvent<LogHostToWebviewMessage>) => {
  const message = event.data;
  if (message.type === 'logData') {
    render(message.data.entries);
  } else if (message.type === 'logError') {
    renderLogError(message.message);
  } else if (message.type === 'diffData') {
    if (message.commitHash !== expandedHash) return; // collapsed or superseded before the reply arrived
    const fileList = fileListsByHash.get(message.commitHash);
    if (!fileList) return;
    if (message.files.length === 0) {
      fileList.replaceChildren(buildFileListStatus(t('No changes.'), false));
    } else {
      fileList.replaceChildren(...message.files.map((file) => buildFileRow(message.commitHash, file)));
    }
  } else if (message.type === 'diffError') {
    if (message.commitHash !== expandedHash) return;
    const fileList = fileListsByHash.get(message.commitHash);
    fileList?.replaceChildren(buildFileListStatus(t('Git Revision Graph: {0}', message.message), true));
  }
});

vscode.postMessage({ type: 'ready' });
