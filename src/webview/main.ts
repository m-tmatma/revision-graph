// Webview entry point: requests commit data from the extension host,
// measures node sizes, delegates layout to the Web Worker, and renders the
// resulting graph as SVG. No pan/zoom or interaction yet (M3 scope).

import type {
  GraphCommit,
  GraphNode,
  HostToWebviewMessage,
  LaidOutGraph,
  LogScopeOptions,
  ReduceOptions,
  WebviewToHostMessage,
} from '../shared/types';
import { computeLayout } from './computeLayout';
import { renderGraph } from './render/graphRenderer';
import { NODE_MIN_WIDTH, NODE_PADDING_X, NODE_PADDING_Y, NODE_ROW_HEIGHT } from './render/layoutConstants';

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
    return { id: commit.hash, parents: commit.parents, refs: commit.refs, width, height };
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
      renderGraph(rootEl!, computeLayout(nodes));
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
        renderGraph(rootEl!, event.data.graph);
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
