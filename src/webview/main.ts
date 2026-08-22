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
  RefInfo,
  RefType,
  WebviewToHostMessage,
} from '../shared/types';
import { computeLayout } from './computeLayout';
import { renderGraph } from './render/graphRenderer';
import { NODE_MIN_WIDTH, NODE_PADDING_X, NODE_PADDING_Y, NODE_ROW_HEIGHT } from './render/layoutConstants';
import { PanZoomController } from './render/panZoom';
import { closeContextMenu, showContextMenu, type ContextMenuItem } from './render/contextMenu';
import { SelectionController } from './render/selection';
import { Minimap } from './render/minimap';

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
const minimapEl = document.getElementById('minimap');

const toolbar = {
  scopeSelect: document.getElementById('scope-select') as HTMLSelectElement | null,
  rangeInputs: document.getElementById('range-inputs') as HTMLElement | null,
  rangeFrom: document.getElementById('range-from') as HTMLInputElement | null,
  rangeTo: document.getElementById('range-to') as HTMLInputElement | null,
  collapseToggle: document.getElementById('collapse-toggle') as HTMLInputElement | null,
  showTagsToggle: document.getElementById('show-tags-toggle') as HTMLInputElement | null,
  refreshButton: document.getElementById('refresh-button') as HTMLButtonElement | null,
  checkoutButton: document.getElementById('checkout-button') as HTMLButtonElement | null,
  exportSvgButton: document.getElementById('export-svg-button') as HTMLButtonElement | null,
  exportPngButton: document.getElementById('export-png-button') as HTMLButtonElement | null,
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
  !toolbar.refreshButton ||
  !toolbar.checkoutButton ||
  !toolbar.exportSvgButton ||
  !toolbar.exportPngButton
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
toolbar.checkoutButton.addEventListener('click', () => {
  const message: WebviewToHostMessage = { type: 'incrementalCheckout' };
  vscode.postMessage(message);
});
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
let minimapController: Minimap | null = null;
let lastRenderedGraph: LaidOutGraph | null = null;

function renderAndFocus(graph: LaidOutGraph): void {
  closeContextMenu();
  lastRenderedGraph = graph;
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

  if (minimapEl) {
    minimapController?.destroy();
    try {
      minimapController = new Minimap(minimapEl, graph, controller);
    } catch (err) {
      minimapController = null;
      minimapEl.textContent = `Minimap error: ${(err as Error).message}`;
    }
  }
}

// The live SVG's viewBox reflects the current pan/zoom, not the full
// graph — export should capture everything, so a clone gets its
// width/height/viewBox reset to the graph's full logical bounds before
// serializing. Node/edge positions don't depend on pan/zoom (only the
// viewBox attribute does), so cloning the already-rendered SVG is enough;
// no need to re-render from scratch.
function buildExportSvgMarkup(graph: LaidOutGraph): string {
  const liveSvg = rootEl!.querySelector('svg');
  if (!liveSvg) throw new Error('no graph rendered yet');

  const clone = liveSvg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('width', String(graph.width));
  clone.setAttribute('height', String(graph.height));
  clone.setAttribute('viewBox', `0 0 ${graph.width} ${graph.height}`);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return new XMLSerializer().serializeToString(clone);
}

function exportSvg(): void {
  if (!lastRenderedGraph) return;
  const message: WebviewToHostMessage = { type: 'exportSvg', svg: buildExportSvgMarkup(lastRenderedGraph) };
  vscode.postMessage(message);
}

// Rasterizes by loading the SVG as an <img> onto a <canvas>: the SVG's
// `var(--vscode-x, fallback)` colors only resolve against this page's live
// theme while connected to this document, so an isolated <img> falls back
// to the literal fallback colors already baked into every fill/stroke —
// a reasonable, if not theme-matched, result for a portable export. The
// canvas background is filled with the page's *actual* current background
// color first (read from this live document, so it isn't subject to that
// same isolation), so the PNG isn't transparent.
//
// A large repo's graph can be taller than the browser's 2D canvas can
// allocate (Chromium's limit is roughly 16384px per side / ~268M px total
// area) — past that, canvas.toDataURL() doesn't throw, it silently returns
// the degenerate string "data:,", which otherwise looks like a real but
// tiny/corrupt PNG once written to disk. Bail out early with a clear
// message instead (SVG export has no such limit, since it stays vector).
const MAX_CANVAS_DIMENSION = 16_384;
const MAX_CANVAS_AREA = MAX_CANVAS_DIMENSION * MAX_CANVAS_DIMENSION;

async function exportPng(graph: LaidOutGraph): Promise<void> {
  if (
    graph.width > MAX_CANVAS_DIMENSION ||
    graph.height > MAX_CANVAS_DIMENSION ||
    graph.width * graph.height > MAX_CANVAS_AREA
  ) {
    throw new Error(
      `graph is too large to export as PNG (${Math.round(graph.width)}x${Math.round(graph.height)} exceeds the browser's canvas size limit) — use Export SVG instead`,
    );
  }

  const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buildExportSvgMarkup(graph))}`;

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    // A blocked (e.g. by CSP) load doesn't reliably fire onerror in every
    // environment, so this would otherwise hang forever with no visible
    // error at all — a timeout guarantees some reaction either way.
    const timeoutId = setTimeout(() => reject(new Error('timed out rasterizing the SVG')), 10_000);
    const img = new Image();
    img.onload = () => {
      clearTimeout(timeoutId);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timeoutId);
      reject(new Error('failed to rasterize the SVG'));
    };
    img.src = svgDataUrl;
  });

  // The SVG can fire `load` while still decoding to a 0x0 image (seen when
  // the SVG fails to parse but doesn't error out outright) — drawing that
  // onto the canvas silently produces a near-empty PNG instead of a visible
  // failure, so catch it here instead.
  if (image.naturalWidth === 0 || image.naturalHeight === 0) {
    throw new Error('rasterized SVG has no dimensions (naturalWidth/naturalHeight is 0)');
  }

  const canvas = document.createElement('canvas');
  canvas.width = graph.width;
  canvas.height = graph.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2D context unavailable');
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#1e1e1e';
  ctx.fillRect(0, 0, graph.width, graph.height);
  ctx.drawImage(image, 0, 0, graph.width, graph.height);

  const dataUrl = canvas.toDataURL('image/png');
  // toDataURL() can return the degenerate "data:," instead of throwing
  // when the canvas is unusable (e.g. a tainted source) in some Electron/
  // Chromium builds — that string would otherwise slip through to the
  // extension host and get written out as a handful of garbage bytes.
  if (!dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error(`canvas produced no PNG data (got "${dataUrl.slice(0, 32)}")`);
  }

  const message: WebviewToHostMessage = { type: 'exportPng', dataUrl };
  vscode.postMessage(message);
}

toolbar.exportSvgButton.addEventListener('click', exportSvg);
toolbar.exportPngButton.addEventListener('click', () => {
  if (!lastRenderedGraph) return;
  exportPng(lastRenderedGraph).catch((err: unknown) => {
    setStatus(`Export failed: ${(err as Error).message}`);
  });
});

// Right-click a node while exactly two are selected to compare them.
// Deliberately requires the clicked node to be one of the two selected —
// right-clicking an unrelated third node wouldn't have an obvious meaning
// yet (there's no other menu item until the rest of M3's context-menu
// scope is built out).
// Reconstructs the full `refs/heads/...` path GraphCommit.refs doesn't
// carry (logReader.ts only sends the already-stripped display name) — the
// inverse of logReader.ts's displayRefName/classifyRef.
function fullRefName(ref: RefInfo): string {
  switch (ref.type) {
    case 'local-branch':
    case 'current-branch':
      return `refs/heads/${ref.name}`;
    case 'remote-branch':
      return `refs/remotes/${ref.name}`;
    case 'tag':
      return `refs/tags/${ref.name}`;
    case 'stash':
      return 'refs/stash';
    case 'head':
      return 'HEAD';
    default:
      return ref.name;
  }
}

// Deletion isn't offered for 'current-branch' (can't delete the branch
// you're on), 'head' (not a real ref), 'stash' (needs an index, not a
// name, to target a specific entry — different operation), or 'other'
// (too ambiguous what deleting it would even mean).
function isDeletableRefType(type: RefType): boolean {
  return type === 'local-branch' || type === 'remote-branch' || type === 'tag';
}

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

    // Copies every ref on the node at once (its full `refs/heads/...` path,
    // one per line) rather than requiring a click on each ref chip
    // individually — a node commonly carries both a local and a remote
    // branch pointing at the same commit.
    const nodeRefs = nodesById.get(commitId)?.refs ?? [];
    if (nodeRefs.length > 0) {
      items.push({
        label: nodeRefs.length === 1 ? 'Copy ref name' : `Copy ref names (${nodeRefs.length})`,
        onClick: () => {
          void navigator.clipboard.writeText(nodeRefs.map(fullRefName).join('\n'));
        },
      });
    }

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

    // Only offered when the click landed on a specific ref chip (unlike
    // "Copy ref name(s)" above, deleting is inherently ref-specific — you
    // wouldn't want deleting one ref on a node to also delete the others).
    // Kept last in the menu: it's the only destructive item here.
    const refRow = target.closest?.('[data-ref-name]') as SVGGElement | null;
    const clickedRefName = refRow?.getAttribute('data-ref-name');
    const clickedRefType = refRow?.getAttribute('data-ref-type') as RefType | null;
    if (clickedRefName && clickedRefType && isDeletableRefType(clickedRefType)) {
      items.push({
        label: `Delete ${fullRefName({ name: clickedRefName, type: clickedRefType })}`,
        onClick: () => {
          const message: WebviewToHostMessage = {
            type: 'deleteRef',
            refType: clickedRefType,
            refName: clickedRefName,
          };
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
