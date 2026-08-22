// Webview entry point: requests commit data from the extension host,
// measures node sizes, delegates layout to the Web Worker, and renders the
// resulting graph as SVG with pan/zoom. Node selection, context menu, and
// tooltips are not yet implemented (remaining M3 scope).

import type {
  GraphCommit,
  GraphNode,
  HostToWebviewMessage,
  LaidOutGraph,
  LaidOutNode,
  LogScopeOptions,
  ReduceOptions,
  WebviewToHostMessage,
} from '../shared/types';
import { computeLayout } from './computeLayout';
import { renderGraph } from './render/graphRenderer';
import { NODE_MIN_WIDTH, NODE_PADDING_X, NODE_PADDING_Y, NODE_ROW_HEIGHT } from './render/layoutConstants';
import { PanZoomController } from './render/panZoom';
import { closeContextMenu, showContextMenu, type ContextMenuItem } from './render/contextMenu';
import { SelectionController } from './render/selection';

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHostMessage): void };
declare global {
  interface Window {
    __LAYOUT_WORKER_URI__?: string;
  }
}

type LayoutWorkerMessage = { type: 'result'; graph: LaidOutGraph } | { type: 'error'; message: string };

const vscode = acquireVsCodeApi();
const statusEl = document.getElementById('graph-status');
const rootEl = document.getElementById('graph-root');
const graphScrollEl = document.getElementById('graph-scroll');

const toolbar = {
  scopeSelect: document.getElementById('scope-select') as HTMLSelectElement | null,
  rangeInputs: document.getElementById('range-inputs') as HTMLElement | null,
  rangeFrom: document.getElementById('range-from') as HTMLInputElement | null,
  rangeTo: document.getElementById('range-to') as HTMLInputElement | null,
  collapseToggle: document.getElementById('collapse-toggle') as HTMLInputElement | null,
  showTagsToggle: document.getElementById('show-tags-toggle') as HTMLInputElement | null,
  refreshButton: document.getElementById('refresh-button') as HTMLButtonElement | null,
};

if (
  !rootEl ||
  !statusEl ||
  !toolbar.scopeSelect ||
  !toolbar.rangeInputs ||
  !toolbar.rangeFrom ||
  !toolbar.rangeTo ||
  !toolbar.collapseToggle ||
  !toolbar.showTagsToggle ||
  !toolbar.refreshButton
) {
  throw new Error('Git Revision Graph: webview markup is missing expected elements');
}

function setStatus(text: string | null): void {
  statusEl!.textContent = text ?? '';
  statusEl!.style.display = text ? 'block' : 'none';
}

function currentScope(): LogScopeOptions {
  const scope = toolbar.scopeSelect!.value as LogScopeOptions['scope'];
  if (scope === 'range') {
    return {
      scope,
      fromRef: toolbar.rangeFrom!.value.trim() || undefined,
      toRef: toolbar.rangeTo!.value.trim() || 'HEAD',
    };
  }
  return { scope };
}

function currentReduceOptions(): ReduceOptions {
  return {
    collapseStraightRuns: toolbar.collapseToggle!.checked,
    showAllTags: toolbar.showTagsToggle!.checked,
  };
}

function applyFilter(): void {
  const message: WebviewToHostMessage = { type: 'setFilter', scope: currentScope(), reduce: currentReduceOptions() };
  vscode.postMessage(message);
}

toolbar.scopeSelect.addEventListener('change', () => {
  toolbar.rangeInputs!.hidden = toolbar.scopeSelect!.value !== 'range';
  applyFilter();
});
toolbar.collapseToggle.addEventListener('change', applyFilter);
toolbar.showTagsToggle.addEventListener('change', applyFilter);
toolbar.refreshButton.addEventListener('click', applyFilter);
for (const input of [toolbar.rangeFrom, toolbar.rangeTo]) {
  input.addEventListener('blur', applyFilter);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyFilter();
  });
}

// Renders the graph, attaches pan/zoom to the freshly created SVG (each
// render replaces it, so the controller can't be reused across renders —
// the old one is destroyed first, since its window-level listeners would
// otherwise keep fighting over an SVG that's no longer in the DOM), and
// centers the viewport on the current branch — findable at a glance even in
// a graph large enough that HEAD wouldn't otherwise be in view (e.g. after
// a filter change moves it). Falls back to centering the whole graph if no
// commit in the current view carries HEAD/current-branch.
let panZoomController: PanZoomController | null = null;
let selectionController: SelectionController | null = null;

function renderAndFocus(graph: LaidOutGraph): void {
  closeContextMenu();
  const svg = renderGraph(rootEl!, graph);

  selectionController?.destroy();
  const newSelectionController = new SelectionController(svg);
  selectionController = newSelectionController;
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  attachContextMenu(svg, newSelectionController, nodesById);

  if (!graphScrollEl) return;

  panZoomController?.destroy();
  const controller = new PanZoomController(graphScrollEl, svg);
  panZoomController = controller;
  const headNode = graph.nodes.find((node) =>
    node.refs.some((ref) => ref.type === 'head' || ref.type === 'current-branch'),
  );
  if (headNode) {
    controller.centerOn(headNode.x + headNode.width / 2, headNode.y + headNode.height / 2);
  } else {
    controller.centerOn(graph.width / 2, graph.height / 2);
  }
}

// Right-click a node while exactly two are selected to compare them.
// Deliberately requires the clicked node to be one of the two selected —
// right-clicking an unrelated third node wouldn't have an obvious meaning
// yet (there's no other menu item until the rest of M3's context-menu
// scope is built out).
// Checkout targets the right-clicked node's own local branch if it has
// one, otherwise the bare commit hash (a detached-HEAD checkout). Omitted
// entirely if the node IS the current branch already — nothing to do.
function checkoutMenuItem(node: LaidOutNode | undefined, commitId: string): ContextMenuItem | null {
  const refs = node?.refs ?? [];
  if (refs.some((ref) => ref.type === 'current-branch')) return null;

  const localBranch = refs.find((ref) => ref.type === 'local-branch');
  const remoteBranch = refs.find((ref) => ref.type === 'remote-branch');

  let ref: string;
  let label: string;
  let suggestedBranchName: string | undefined;

  if (localBranch) {
    ref = localBranch.name;
    label = localBranch.name;
  } else if (remoteBranch) {
    // No local branch tracks this remote one yet — checking it out means
    // creating a new local branch, so suggest a name (the remote branch's
    // own name with its "<remote>/" prefix stripped).
    ref = remoteBranch.name;
    label = remoteBranch.name;
    suggestedBranchName = remoteBranch.name.replace(/^[^/]+\//, '');
  } else {
    ref = commitId;
    label = `${commitId.slice(0, 7)} (detached HEAD)`;
  }

  return {
    label: `Checkout ${label}`,
    onClick: () => {
      const message: WebviewToHostMessage = { type: 'openCheckoutDialog', ref, label, suggestedBranchName };
      vscode.postMessage(message);
    },
  };
}

function attachContextMenu(
  svg: SVGSVGElement,
  controller: SelectionController,
  nodesById: Map<string, LaidOutNode>,
): void {
  svg.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const target = event.target as Element;
    const group = target.closest?.('[data-commit-id]') as SVGGElement | null;
    const commitId = group?.getAttribute('data-commit-id');
    if (!commitId) return;

    const items: ContextMenuItem[] = [];

    const checkoutItem = checkoutMenuItem(nodesById.get(commitId), commitId);
    if (checkoutItem) items.push(checkoutItem);

    items.push({
      label: 'Copy full hash',
      onClick: () => {
        void navigator.clipboard.writeText(commitId);
      },
    });

    // "Compare" only makes sense once two nodes are selected, and only on
    // one of those two (right-clicking an unrelated third node wouldn't
    // have an obvious meaning).
    const { first, second } = controller.getState();
    if (first && second && (commitId === first || commitId === second)) {
      items.push({
        label: `Compare ${first.slice(0, 7)} with ${second.slice(0, 7)}`,
        onClick: () => {
          const message: WebviewToHostMessage = { type: 'compare', from: first, to: second };
          vscode.postMessage(message);
        },
      });
    }

    showContextMenu(event.clientX, event.clientY, items);
  });
}

function buildGraphNodes(commits: GraphCommit[]): GraphNode[] {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif';
  ctx.font = `11px ${fontFamily}`;

  return commits.map((commit) => {
    const labels = commit.refs.length > 0 ? commit.refs.map((ref) => ref.name) : [commit.hash.slice(0, 7)];
    const maxLabelWidth = Math.max(...labels.map((label) => ctx.measureText(label).width));
    const width = Math.max(NODE_MIN_WIDTH, Math.ceil(maxLabelWidth) + NODE_PADDING_X);
    const height = labels.length * NODE_ROW_HEIGHT + NODE_PADDING_Y * 2;
    return {
      id: commit.hash,
      parents: commit.parents,
      refs: commit.refs,
      width,
      height,
      body: commit.body,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      authorDate: commit.authorDate,
    };
  });
}

// `new Worker(vscode-webview-resource-uri)` fails silently in VSCode's
// webview sandbox (the resource origin isn't Worker-loadable directly), so
// fetch the script and construct a blob: URL instead.
async function createLayoutWorker(): Promise<Worker> {
  const workerUri = window.__LAYOUT_WORKER_URI__;
  if (!workerUri) {
    throw new Error('layout worker URI was not injected into the webview');
  }
  const response = await fetch(workerUri);
  if (!response.ok) {
    throw new Error(`failed to fetch layout worker script (HTTP ${response.status})`);
  }
  const code = await response.text();
  const blobUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  return new Worker(blobUrl);
}

async function handleGraphData(commits: GraphCommit[]): Promise<void> {
  if (commits.length === 0) {
    rootEl!.replaceChildren();
    setStatus('No commits found.');
    return;
  }

  setStatus('Computing layout…');
  const nodes = buildGraphNodes(commits);

  // dagre's ranking pass recurses to a depth tracking the graph's longest
  // chain; a dedicated Worker's stack is smaller than the main thread's, so
  // a very deep history can overflow the worker even though the same graph
  // lays out fine here. Fall back to a (blocking) main-thread layout rather
  // than just failing.
  const fallbackToMainThread = (reason: string) => {
    console.warn(`Git Revision Graph: layout worker failed (${reason}), retrying on the main thread`);
    setStatus('Computing layout (fallback)…');
    try {
      renderAndFocus(computeLayout(nodes));
      setStatus(null);
    } catch (err) {
      setStatus(`Layout failed: ${(err as Error).message}`);
    }
  };

  try {
    const worker = await createLayoutWorker();

    worker.addEventListener('error', (event) => {
      worker.terminate();
      fallbackToMainThread(event.message);
    });

    worker.addEventListener('message', (event: MessageEvent<LayoutWorkerMessage>) => {
      worker.terminate();
      if (event.data.type === 'result') {
        setStatus(null);
        renderAndFocus(event.data.graph);
      } else {
        fallbackToMainThread(event.data.message);
      }
    });

    worker.postMessage({ type: 'layout', nodes });
  } catch (err) {
    fallbackToMainThread((err as Error).message);
  }
}

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  if (event.data.type === 'graphData') {
    void handleGraphData(event.data.commits);
  } else if (event.data.type === 'error') {
    rootEl!.replaceChildren();
    setStatus(`Error: ${event.data.message}`);
  }
});

vscode.postMessage({ type: 'ready' });
