// Webview entry point for the "Show Log" panel: a scrollable list of a
// commit and its ancestors, TortoiseGit "Log" dialog-style, with branch/
// merge topology drawn as a small per-row graph (see logLanes.ts). Clicking
// a commit expands its changed files inline, directly under that row
// (collapsing whichever commit was previously expanded); clicking a file
// row opens it in VSCode's native diff editor, same as the Compare panel.

import type { FileChange, LogEntry, LogHostToWebviewMessage, LogWebviewToHostMessage, RefInfo } from '../shared/types';
import { applyLocalization, t } from './l10n';
import { refDisplayLabel, resolveCheckoutTarget } from './render/checkoutTarget';
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
const entriesByHash = new Map<string, LogEntry>();
const compareBadgesByHash = new Map<string, HTMLSpanElement>();

// Two-commit selection for "Compare": Ctrl/Cmd+click keeps a sliding window
// of the last two *distinct* commits clicked, oldest evicted first, so
// repeatedly Ctrl-clicking never gets stuck anchored to a stale first pick.
// A plain click (see clearCompareSelection below) abandons the selection
// entirely, mirroring the main graph's own SelectionController (whose plain
// click also resets the whole selection) -- without that, ordinary
// expand/collapse browsing in between Ctrl-clicks would leave an old,
// forgotten selection to resurface unexpectedly paired with whatever gets
// Ctrl-clicked next. Also reset on every full render (a fresh `logData`
// message), same as the main graph resets on every `graphData` message.
let compareSelection: string[] = [];

// A numbered badge ("1"/"2") in the subject text, rather than a colored
// accent on the row itself -- a left-edge accent sits right beside the
// multi-colored lane graph (blue/orange/green/purple/red/yellow lines), so
// any single accent color risked blending into whichever lane happened to
// be running past that row. Text position also doubles as the "from"/"to"
// order used by the eventual `compare` message.
function applyCompareHighlight(): void {
  compareBadgesByHash.forEach((badge, hash) => {
    const position = compareSelection.indexOf(hash);
    badge.hidden = position === -1;
    if (position !== -1) badge.textContent = String(position + 1);
  });
}

function toggleCompareSelection(hash: string): void {
  if (compareSelection[compareSelection.length - 1] === hash) return; // re-clicking the most recent pick is a no-op
  compareSelection = [...compareSelection, hash].slice(-2);
  applyCompareHighlight();
}

function clearCompareSelection(): void {
  if (compareSelection.length === 0) return;
  compareSelection = [];
  applyCompareHighlight();
}

// Ctrl/Cmd+right-click's own entry point (see the contextmenu listener
// below, and the "Select for Compare" menu item): if the pending selection
// isn't already a complete pair, fills the missing slot with whatever's
// currently expanded -- the ordinary (non-Ctrl) click that expanded it
// already counted as "looking at this one", it just didn't say so
// explicitly via Ctrl. Covers both "browsed to A, then Ctrl+right-click B"
// (selection empty) and "browsed to A, Ctrl+left-clicked B, then
// Ctrl+right-click B again to open the menu" (selection has only B) --
// either way this completes the pair with A. Deliberately narrower than
// "selection isn't already a full pair": if the user already Ctrl-clicked
// some other commit C (compareSelection = [C], C !== hash), prefilling
// `expandedHash` here would evict C and silently swap in A instead --
// exactly the explicit pick the user just made. Once two commits have been
// deliberately Ctrl-clicked, or the expanded commit IS the one being
// right-clicked, there's nothing to fill in and this defers entirely to
// toggleCompareSelection.
function selectForCompareViaContextMenu(hash: string): void {
  const shouldPairWithExpanded =
    compareSelection.length === 0 || (compareSelection.length === 1 && compareSelection[0] === hash);
  if (shouldPairWithExpanded && expandedHash && expandedHash !== hash) {
    compareSelection = [...compareSelection, expandedHash].slice(-2);
  }
  toggleCompareSelection(hash);
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
  const compareBadge = document.createElement('span');
  compareBadge.className = 'compare-badge';
  compareBadge.hidden = true;
  subject.appendChild(compareBadge);
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
  // so a click there wouldn't otherwise reach anything. Ctrl/Cmd+click is
  // reserved for the two-commit Compare selection below instead of
  // expanding the row, matching the main graph's own Ctrl/Cmd+click
  // convention for node selection.
  main.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey) {
      toggleCompareSelection(entry.hash);
    } else {
      // A plain click means "browse elsewhere", same as the main graph's own
      // plain click abandoning whatever pair was selected there -- without
      // this, an old compare selection from several clicks ago silently
      // stuck around through any number of ordinary expand/collapse clicks
      // in between, resurfacing unexpectedly paired with whatever was
      // Ctrl-clicked next.
      clearCompareSelection();
      toggleCommit(entry.hash);
    }
  });

  // Without this, right-clicking a row falls through to the webview's
  // native OS edit menu (Cut/Copy/Paste) -- meaningless here since none of
  // this row is editable text. A small custom menu with actions that
  // actually apply to a commit replaces it, same pattern as the main
  // graph view's node context menu.
  main.addEventListener('contextmenu', (event) => {
    event.preventDefault();

    // Holding Ctrl/Cmd while right-clicking is the fast path: pick a second
    // commit and immediately see the "Compare with {0}" item in the same
    // gesture. If nothing's been Ctrl-clicked yet this round, pair with
    // whatever's currently expanded (the commit the user was just looking
    // at via an ordinary click) rather than requiring a separate, explicit
    // Ctrl+left-click first.
    if (event.ctrlKey || event.metaKey) {
      selectForCompareViaContextMenu(entry.hash);
    }

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
      {
        label: t('Compare with current branch'),
        onClick: () => {
          const message: LogWebviewToHostMessage = { type: 'compareWithCurrentBranch', to: entry.hash };
          vscode.postMessage(message);
        },
      },
    );

    // Keyboard/AT-accessible equivalent of the Ctrl/Cmd+click selection
    // above -- that gesture has no keyboard equivalent (same gap the main
    // graph's own selection has), so these menu items expose the same two
    // states (pick a commit / compare the two picked commits) without
    // requiring a mouse.
    const [from, to] = compareSelection;
    if (from && to && (entry.hash === from || entry.hash === to)) {
      const fromLabel = refDisplayLabel(entriesByHash.get(from)?.refs ?? [], from);
      const toLabel = refDisplayLabel(entriesByHash.get(to)?.refs ?? [], to);
      items.push({
        label: t('Compare {0} and {1}', fromLabel, toLabel),
        onClick: () => {
          const message: LogWebviewToHostMessage = { type: 'compare', from, to };
          vscode.postMessage(message);
        },
      });
    } else if (compareSelection[compareSelection.length - 1] !== entry.hash) {
      items.push({
        label: t('Select for Compare'),
        onClick: () => selectForCompareViaContextMenu(entry.hash),
      });
    }

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
  entriesByHash.set(entry.hash, entry);
  compareBadgesByHash.set(entry.hash, compareBadge);

  return li;
}

function render(entries: LogEntry[]): void {
  fileListsByHash.clear();
  buttonsByHash.clear();
  entriesByHash.clear();
  compareBadgesByHash.clear();
  expandedHash = undefined;
  compareSelection = [];

  const { rows, laneCount } = computeLanes(entries);
  commitListEl!.replaceChildren(...entries.map((entry, i) => buildCommitRow(entry, rows[i], laneCount)));
  if (entries.length > 0) expandCommit(entries[0].hash);
}

function renderLogError(message: string): void {
  fileListsByHash.clear();
  buttonsByHash.clear();
  entriesByHash.clear();
  compareBadgesByHash.clear();
  expandedHash = undefined;
  compareSelection = [];

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
