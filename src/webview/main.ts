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
import { applyLocalization, t } from './l10n';
import { renderGraph } from './render/graphRenderer';
import { NODE_MIN_WIDTH, NODE_PADDING_X, NODE_PADDING_Y, NODE_ROW_HEIGHT } from './render/layoutConstants';
import { PanZoomController } from './render/panZoom';
import { closeContextMenu, showContextMenu, type ContextMenuItem } from './render/contextMenu';
import { refDisplayLabel, resolveCheckoutTarget } from './render/checkoutTarget';
import { SelectionController } from './render/selection';
import { Minimap } from './render/minimap';
import { HoverTooltipController } from './render/hoverTooltip';

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHostMessage): void };
declare global {
  interface Window {
    __LAYOUT_WORKER_URI__?: string;
  }
}

type LayoutWorkerMessage = { type: 'result'; graph: LaidOutGraph } | { type: 'error'; message: string };

// Space left above the current-branch node when it's topmost (see
// `renderAndFocus`), so it doesn't render flush against the viewport edge.
const TOP_FOCUS_MARGIN = 24;

const vscode = acquireVsCodeApi();
applyLocalization(document);
const statusEl = document.getElementById('graph-status');
const rootEl = document.getElementById('graph-root');
const graphScrollEl = document.getElementById('graph-scroll');
const minimapEl = document.getElementById('minimap');

const toolbar = {
  scopeSelect: document.getElementById('scope-select') as HTMLSelectElement | null,
  rangeInputs: document.getElementById('range-inputs') as HTMLElement | null,
  rangeFrom: document.getElementById('range-from') as HTMLInputElement | null,
  rangeTo: document.getElementById('range-to') as HTMLInputElement | null,
  showBranchesMergesToggle: document.getElementById('show-branches-merges-toggle') as HTMLInputElement | null,
  showTagsToggle: document.getElementById('show-tags-toggle') as HTMLInputElement | null,
  refreshButton: document.getElementById('refresh-button') as HTMLButtonElement | null,
  fetchButton: document.getElementById('fetch-button') as HTMLButtonElement | null,
  checkoutButton: document.getElementById('checkout-button') as HTMLButtonElement | null,
  deleteMergedBranchesButton: document.getElementById('delete-merged-branches-button') as HTMLButtonElement | null,
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
  !toolbar.showBranchesMergesToggle ||
  !toolbar.showTagsToggle ||
  !toolbar.refreshButton ||
  !toolbar.fetchButton ||
  !toolbar.checkoutButton ||
  !toolbar.deleteMergedBranchesButton ||
  !toolbar.exportSvgButton ||
  !toolbar.exportPngButton
) {
  throw new Error(t('Git Revision Graph: webview markup is missing expected elements'));
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
    // Checked (the default) = TortoiseGit's own "Show branches and merges"
    // checked = `--sparse` on top of the always-applied
    // `--simplify-by-decoration` (see ReduceOptions/logReader.ts) = show
    // every merge, but still only within the ref-relevant history that
    // --simplify-by-decoration establishes. Unchecked drops --sparse for
    // more aggressive pruning.
    sparse: toolbar.showBranchesMergesToggle!.checked,
    showAllTags: toolbar.showTagsToggle!.checked,
  };
}

function applyFilter(): void {
  const message: WebviewToHostMessage = { type: 'setFilter', scope: currentScope(), reduce: currentReduceOptions() };
  vscode.postMessage(message);
}

// Whether the *next* `graphData` message should re-center the viewport on
// the current branch, rather than keeping wherever the user last panned/
// zoomed to. True initially (so the very first render focuses HEAD), after
// an explicit Refresh click, and after toggling "Show branches and merges"
// (it can prune or restore a large number of merges at once, moving the
// current branch's node far enough that the old pan/zoom position no
// longer makes sense); false for every other client-triggered request —
// scope/tags/range changes, and repo-watcher's own automatic refresh on
// external changes (a checkout, commit, or pull from outside the
// extension), which used to yank the view back to HEAD without the user
// asking for that. Consumed (read, then reset to false) by the next
// handleGraphData call, so it only ever applies to the one render it was
// set for. Separately, the host can also request a focus on a specific
// graphData message (see `focusOnHead` on HostToWebviewMessage) — used
// after a checkout we performed ourselves, since that's a case where
// jumping to the (new) current branch is exactly what the user wants.
let focusOnHeadForNextGraphData = true;

// See handleGraphData's own comment on why this exists.
let renderGeneration = 0;

toolbar.scopeSelect.addEventListener('change', () => {
  toolbar.rangeInputs!.hidden = toolbar.scopeSelect!.value !== 'range';
  // A scope change can be at least as big a structural change as toggling
  // "Show branches and merges" (e.g. Local branches -> All branches can
  // jump from dozens to thousands of nodes) -- without this, the current
  // branch's node could end up far outside the old pan/zoom position, or
  // the view could even land somewhere with no nodes at all.
  focusOnHeadForNextGraphData = true;
  applyFilter();
});
toolbar.showBranchesMergesToggle.addEventListener('change', () => {
  focusOnHeadForNextGraphData = true;
  applyFilter();
});
toolbar.showTagsToggle.addEventListener('change', applyFilter);
toolbar.refreshButton.addEventListener('click', () => {
  focusOnHeadForNextGraphData = true;
  applyFilter();
});
toolbar.fetchButton.addEventListener('click', () => {
  const message: WebviewToHostMessage = { type: 'fetch' };
  vscode.postMessage(message);
});
toolbar.checkoutButton.addEventListener('click', () => {
  const message: WebviewToHostMessage = { type: 'incrementalCheckout' };
  vscode.postMessage(message);
});
toolbar.deleteMergedBranchesButton.addEventListener('click', () => {
  const message: WebviewToHostMessage = { type: 'deleteMergedBranches' };
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
// otherwise keep fighting over an SVG that's no longer in the DOM).
//
// `focusOnHead` controls whether this also (re-)centers the viewport on
// the current branch: true for the very first render, an explicit Refresh
// click, toggling "Show branches and merges", and a checkout we performed
// ourselves (see `focusOnHeadForNextGraphData`'s own comment) — every other
// re-render (a
// filter/checkbox change, or an automatic refresh from repo-watcher
// noticing an external change) instead carries over the previous
// controller's exact pan/zoom state, so the view doesn't jump out from
// under the user without them asking for that.
let panZoomController: PanZoomController | null = null;
let selectionController: SelectionController | null = null;
let minimapController: Minimap | null = null;
let lastRenderedGraph: LaidOutGraph | null = null;

// One instance for the whole page's lifetime (its tooltip element lives in
// document.body, outside the SVG that gets replaced on every re-render) --
// requests the same text `git show -s`/"Copy commit info" would produce, so
// hovering a node reads exactly the same as copying it.
const hoverTooltip = new HoverTooltipController((commitId) => {
  const message: WebviewToHostMessage = { type: 'requestCommitTooltip', commitId };
  vscode.postMessage(message);
});

function renderAndFocus(graph: LaidOutGraph, focusOnHead: boolean): void {
  closeContextMenu();
  lastRenderedGraph = graph;
  const svg = renderGraph(rootEl!, graph);

  // Carried over the same way pan/zoom state is below (and for the same
  // reason): a re-render (an automatic refresh from repo-watcher noticing
  // an external commit/checkout/pull, say) shouldn't silently drop a
  // two-commit Compare selection the user made deliberately. Only ids
  // that still exist in the new graph are kept -- one could have been
  // pruned by dagReducer's own elision, or the commit could simply be
  // gone from this scope now.
  const previousSelection = selectionController?.getState();
  selectionController?.destroy();
  const newSelectionController = new SelectionController(svg);
  selectionController = newSelectionController;
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  if (previousSelection) {
    newSelectionController.setState({
      first: previousSelection.first !== null && nodesById.has(previousSelection.first) ? previousSelection.first : null,
      second: previousSelection.second !== null && nodesById.has(previousSelection.second) ? previousSelection.second : null,
    });
  }
  attachContextMenu(svg, newSelectionController, nodesById);
  attachHoverTooltip(svg);

  if (!graphScrollEl) return;

  const previousView = panZoomController?.getView();
  panZoomController?.destroy();
  const controller = new PanZoomController(graphScrollEl, svg);
  panZoomController = controller;

  if (!focusOnHead && previousView) {
    controller.setView(previousView);
  } else {
    // Falls back to centering the whole graph if no commit in the current
    // view carries HEAD/current-branch (or there's no previous view to
    // carry over — the very first render, by construction, always wants
    // focusOnHead anyway).
    const headNode = graph.nodes.find((node) => node.isCurrentBranch);
    if (headNode) {
      // Nothing renders above the current branch (e.g. it's up to date with
      // its remote) when no other node's top edge sits above its own —
      // vertically centering it there would leave an empty band above the
      // top of the graph, so align the viewport's top edge with the
      // graph's instead, with a little breathing room.
      const isTopmost = graph.nodes.every((node) => node.y >= headNode.y);
      if (isTopmost) {
        controller.centerOnTop(headNode.x + headNode.width / 2, headNode.y - TOP_FOCUS_MARGIN);
      } else {
        controller.centerOn(headNode.x + headNode.width / 2, headNode.y + headNode.height / 2);
      }
    } else {
      controller.centerOn(graph.width / 2, graph.height / 2);
    }
  }

  if (minimapEl) {
    minimapController?.destroy();
    try {
      minimapController = new Minimap(minimapEl, graph, controller);
    } catch (err) {
      minimapController = null;
      minimapEl.textContent = t('Minimap error: {0}', (err as Error).message);
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
  if (!liveSvg) throw new Error(t('no graph rendered yet'));

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
      t(
        "graph is too large to export as PNG ({0}x{1} exceeds the browser's canvas size limit) — use Export SVG instead",
        String(Math.round(graph.width)),
        String(Math.round(graph.height)),
      ),
    );
  }

  const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buildExportSvgMarkup(graph))}`;

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    // A blocked (e.g. by CSP) load doesn't reliably fire onerror in every
    // environment, so this would otherwise hang forever with no visible
    // error at all — a timeout guarantees some reaction either way.
    const timeoutId = setTimeout(() => reject(new Error(t('timed out rasterizing the SVG'))), 10_000);
    const img = new Image();
    img.onload = () => {
      clearTimeout(timeoutId);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timeoutId);
      reject(new Error(t('failed to rasterize the SVG')));
    };
    img.src = svgDataUrl;
  });

  // The SVG can fire `load` while still decoding to a 0x0 image (seen when
  // the SVG fails to parse but doesn't error out outright) — drawing that
  // onto the canvas silently produces a near-empty PNG instead of a visible
  // failure, so catch it here instead.
  if (image.naturalWidth === 0 || image.naturalHeight === 0) {
    throw new Error(t('rasterized SVG has no dimensions (naturalWidth/naturalHeight is 0)'));
  }

  const canvas = document.createElement('canvas');
  canvas.width = graph.width;
  canvas.height = graph.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(t('canvas 2D context unavailable'));
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#1e1e1e';
  ctx.fillRect(0, 0, graph.width, graph.height);
  ctx.drawImage(image, 0, 0, graph.width, graph.height);

  const dataUrl = canvas.toDataURL('image/png');
  // toDataURL() can return the degenerate "data:," instead of throwing
  // when the canvas is unusable (e.g. a tainted source) in some Electron/
  // Chromium builds — that string would otherwise slip through to the
  // extension host and get written out as a handful of garbage bytes.
  if (!dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error(t('canvas produced no PNG data (got "{0}")', dataUrl.slice(0, 32)));
  }

  const message: WebviewToHostMessage = { type: 'exportPng', dataUrl };
  vscode.postMessage(message);
}

toolbar.exportSvgButton.addEventListener('click', exportSvg);
toolbar.exportPngButton.addEventListener('click', () => {
  if (!lastRenderedGraph) return;
  exportPng(lastRenderedGraph).catch((err: unknown) => {
    setStatus(t('Export failed: {0}', (err as Error).message));
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

// Only 'local-branch' is offered now. 'remote-branch' and 'tag' used to
// be too, but deleting a remote-tracking branch only ever touched local
// bookkeeping (never the actual branch on the remote server) — and a
// node commonly stacks a local branch and the remote-tracking branch it
// tracks as separate, closely-spaced ref chips (e.g. "master" right above
// "origin/master"), so a right-click meant for the local one landing on
// the remote-tracking one instead was an easy mistake to make, and
// confusing/alarming to see happen even though it was harmless and
// `git fetch`-recoverable. Dropped both rather than only 'remote-branch',
// on request. 'current-branch' (can't delete the branch you're on),
// 'head' (not a real ref), and 'stash' (needs an index, not a name) were
// never offered either.
function isDeletableRefType(type: RefType): boolean {
  return type === 'local-branch';
}

// Unlike delete, git doesn't refuse to rename the branch you're currently
// on (`git branch -m <new>` works fine in that case), so 'current-branch'
// is offered here too. The stacking-mistake concern that dropped
// 'remote-branch'/'tag' from isDeletableRefType above applies just the
// same to rename, so those stay excluded.
function isRenameableRefType(type: RefType): boolean {
  return type === 'local-branch' || type === 'current-branch';
}

// Used for the "Show Log" panel's title so it reads e.g. "Log: main" rather
// than "Log: a1b2c3d" whenever the right-clicked commit has a ref to name
// it by (refDisplayLabel is shared with the Show Log panel's own "Compare
// with {0}" menu label).
function nodeDisplayLabel(node: LaidOutNode | undefined, commitId: string): string {
  return refDisplayLabel(node?.refs ?? [], commitId);
}

// Checkout targets the right-clicked node's own local branch if it has
// one, otherwise the bare commit hash (a detached-HEAD checkout). Omitted
// entirely if the node IS the current branch already — nothing to do.
function checkoutMenuItem(node: LaidOutNode | undefined, commitId: string): ContextMenuItem | null {
  const target = resolveCheckoutTarget(node?.refs ?? [], commitId);
  if (!target) return null;

  return {
    label: t('Checkout {0}', target.label),
    onClick: () => {
      const message: WebviewToHostMessage = {
        type: 'openCheckoutDialog',
        ref: target.ref,
        label: target.label,
        suggestedBranchName: target.suggestedBranchName,
      };
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
      label: t('Show Log'),
      onClick: () => {
        const message: WebviewToHostMessage = {
          type: 'showLog',
          commitId,
          label: nodeDisplayLabel(nodesById.get(commitId), commitId),
        };
        vscode.postMessage(message);
      },
    });

    // Both hand off entirely to the extension host: name/message input and
    // the existing-ref overwrite check are native VSCode dialogs there
    // (showInputBox/showWarningMessage), not a webview panel — there's no
    // combinable-options set here the way there is for checkout.
    items.push({
      label: t('Create branch here…'),
      onClick: () => {
        const message: WebviewToHostMessage = { type: 'createBranch', startPoint: commitId };
        vscode.postMessage(message);
      },
    });
    items.push({
      label: t('Create tag here…'),
      onClick: () => {
        const message: WebviewToHostMessage = { type: 'createTag', startPoint: commitId };
        vscode.postMessage(message);
      },
    });

    // Copies every ref on the node at once (its full `refs/heads/...` path,
    // one per line) rather than requiring a click on each ref chip
    // individually — a node commonly carries both a local and a remote
    // branch pointing at the same commit.
    const nodeRefs = nodesById.get(commitId)?.refs ?? [];
    if (nodeRefs.length > 0) {
      items.push({
        label: nodeRefs.length === 1 ? t('Copy ref name') : t('Copy ref names ({0})', String(nodeRefs.length)),
        onClick: () => {
          void navigator.clipboard.writeText(nodeRefs.map(fullRefName).join('\n') + '\n');
        },
      });
    }

    items.push({
      label: t('Copy full hash'),
      onClick: () => {
        void navigator.clipboard.writeText(commitId);
      },
    });

    // Unlike the copy items above, this needs the extension host — the
    // webview only has the already-parsed commit fields (subject, body,
    // author, ...), not the exact `git show -s` text (ref decorations,
    // git's own date formatting, a "Merge:" line for merge commits, ...).
    items.push({
      label: t('Copy commit info'),
      onClick: () => {
        const message: WebviewToHostMessage = { type: 'copyCommitInfo', commitId };
        vscode.postMessage(message);
      },
    });

    // "Compare" only makes sense once two nodes are selected, and only on
    // one of those two (right-clicking an unrelated third node wouldn't
    // have an obvious meaning).
    const { first, second } = controller.getState();
    if (first && second && (commitId === first || commitId === second)) {
      items.push({
        label: t('Compare'),
        onClick: () => {
          const message: WebviewToHostMessage = { type: 'compare', from: first, to: second };
          vscode.postMessage(message);
        },
      });
    }

    // Unlike "Compare" above, this needs only the right-clicked node — the
    // extension host resolves "the default branch" itself (origin/HEAD,
    // falling back to a local main/master) rather than the webview needing
    // to know it. Hidden once two nodes are already selected: "Compare"
    // above already covers that case, and offering both at once is
    // redundant (and, if the right-clicked node ends up not being either
    // selected node, ambiguous about which node "with default branch"
    // would even apply to).
    if (!(first && second)) {
      items.push({
        label: t('Compare with default branch'),
        onClick: () => {
          const message: WebviewToHostMessage = { type: 'compareWithDefaultBranch', to: commitId };
          vscode.postMessage(message);
        },
      });
      // Same rationale as "Compare with default branch" above, just against
      // HEAD (whatever's currently checked out, branch or detached) instead
      // of the repo's default branch — the extension host passes 'HEAD'
      // straight to git rather than the webview needing to resolve it.
      items.push({
        label: t('Compare with current branch'),
        onClick: () => {
          const message: WebviewToHostMessage = { type: 'compareWithCurrentBranch', to: commitId };
          vscode.postMessage(message);
        },
      });
    }

    // Same ref-chip targeting as "Delete" below — renaming is ref-specific
    // too. Placed before Delete so the destructive item stays last.
    const refRow = target.closest?.('[data-ref-name]') as SVGGElement | null;
    const clickedRefName = refRow?.getAttribute('data-ref-name');
    const clickedRefType = refRow?.getAttribute('data-ref-type') as RefType | null;
    if (clickedRefName && clickedRefType && isRenameableRefType(clickedRefType)) {
      items.push({
        label: t('Rename {0}', fullRefName({ name: clickedRefName, type: clickedRefType })),
        onClick: () => {
          const message: WebviewToHostMessage = {
            type: 'renameRef',
            refType: clickedRefType,
            refName: clickedRefName,
          };
          vscode.postMessage(message);
        },
      });
    }

    // Only offered when the click landed on a specific ref chip (unlike
    // "Copy ref name(s)" above, deleting is inherently ref-specific — you
    // wouldn't want deleting one ref on a node to also delete the others).
    // Kept last in the menu: it's the only destructive item here.
    if (clickedRefName && clickedRefType && isDeletableRefType(clickedRefType)) {
      items.push({
        label: t('Delete {0}', fullRefName({ name: clickedRefName, type: clickedRefType })),
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

// Delegated over the whole SVG (one pair of listeners survives every
// re-render, rather than one per node -- a real repo's graph can have
// thousands) -- `mousemove` re-derives which node (if any) is currently
// under the cursor on every move, since `mouseenter`/`mouseleave` don't
// bubble and so can't be delegated the same way `attachContextMenu`
// delegates its own single click-driven lookup. Only acts when that
// derived node actually changes, though -- the tooltip itself is anchored
// to the node, not the cursor, so it has nothing to do on every move
// within the same node.
function attachHoverTooltip(svg: SVGSVGElement): void {
  let hoveredCommitId: string | null = null;
  svg.addEventListener('mousemove', (event) => {
    const target = event.target as Element;
    const group = target.closest?.('[data-commit-id]') as SVGGElement | null;
    const commitId = group?.getAttribute('data-commit-id') ?? null;
    if (commitId === hoveredCommitId) return; // already anchored here (or already showing nothing)
    hoveredCommitId = commitId;
    if (commitId && group) {
      hoverTooltip.enter(commitId, group);
    } else {
      hoverTooltip.leave();
    }
  });
  svg.addEventListener('mouseleave', () => {
    hoveredCommitId = null;
    hoverTooltip.leave();
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
      isCurrentBranch: commit.isCurrentBranch,
    };
  });
}

// `new Worker(vscode-webview-resource-uri)` fails silently in VSCode's
// webview sandbox (the resource origin isn't Worker-loadable directly), so
// fetch the script and construct a blob: URL instead.
// Fetched and turned into an object URL once for the page's whole lifetime,
// rather than on every graphData message -- a long session's worth of
// external-change auto-refreshes would otherwise accumulate one unrevoked
// blob URL per render (Worker.terminate() doesn't release it). Caches the
// in-flight promise too, not just the eventual URL, so two calls racing
// before the first fetch resolves share the same fetch instead of issuing
// a second one.
let layoutWorkerBlobUrlPromise: Promise<string> | undefined;

function getLayoutWorkerBlobUrl(): Promise<string> {
  if (!layoutWorkerBlobUrlPromise) {
    layoutWorkerBlobUrlPromise = (async () => {
      const workerUri = window.__LAYOUT_WORKER_URI__;
      if (!workerUri) {
        throw new Error(t('layout worker URI was not injected into the webview'));
      }
      const response = await fetch(workerUri);
      if (!response.ok) {
        throw new Error(t('failed to fetch layout worker script (HTTP {0})', String(response.status)));
      }
      const code = await response.text();
      return URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    })().catch((err: unknown) => {
      // A failed fetch shouldn't be cached forever -- the next render
      // should retry rather than repeat the same stale failure.
      layoutWorkerBlobUrlPromise = undefined;
      throw err;
    });
  }
  return layoutWorkerBlobUrlPromise;
}

async function createLayoutWorker(): Promise<Worker> {
  return new Worker(await getLayoutWorkerBlobUrl());
}

async function handleGraphData(commits: GraphCommit[], hostRequestedFocus: boolean): Promise<void> {
  // Each graphData message computes its layout independently (worker or
  // main-thread fallback), and either can resolve out of order relative to
  // a later message's -- a generation counter, same pattern extension.ts's
  // own `refresh` already uses for its git-log fetches, keeps a slower,
  // now-superseded render from clobbering a newer one.
  const generation = ++renderGeneration;
  const isStale = () => generation !== renderGeneration;

  // Consumed once per graphData message, regardless of which of the two
  // render paths below (worker success vs. main-thread fallback) ends up
  // handling it — both are the same logical render, just two possible
  // outcomes of computing its layout. Either the client-side flag (Refresh
  // click, or the very first render) or the host explicitly asking for it
  // (e.g. after a checkout we performed) triggers a focus.
  const focusOnHead = focusOnHeadForNextGraphData || hostRequestedFocus;
  focusOnHeadForNextGraphData = false;

  if (commits.length === 0) {
    if (isStale()) return;
    rootEl!.replaceChildren();
    setStatus(t('No commits found.'));
    return;
  }

  setStatus(t('Computing layout…'));
  const nodes = buildGraphNodes(commits);

  // Ticks the status up with elapsed seconds while waiting, so "still
  // working on a large repository" is distinguishable from "stuck" without
  // needing DevTools.
  const waitStart = performance.now();
  let tickerHandle: ReturnType<typeof setInterval> | undefined;
  const startTicker = (label: string) => {
    stopTicker();
    tickerHandle = setInterval(() => {
      setStatus(`${label} (${Math.round((performance.now() - waitStart) / 1000)}s)`);
    }, 2000);
  };
  const stopTicker = () => {
    if (tickerHandle !== undefined) {
      clearInterval(tickerHandle);
      tickerHandle = undefined;
    }
  };

  const finish = (graph: LaidOutGraph) => {
    stopTicker();
    if (isStale()) return; // a newer graphData message superseded this one
    renderAndFocus(graph, focusOnHead);
    setStatus(null);
  };

  // Falls back to a (blocking) main-thread layout rather than just failing
  // if the worker itself couldn't be started (see createLayoutWorker's own
  // error cases) or throws for some other reason.
  const fallbackToMainThread = (reason: string) => {
    if (isStale()) return;
    console.warn(`Git Revision Graph: layout worker failed (${reason}), retrying on the main thread`);
    startTicker(t('Computing layout (fallback)…'));
    try {
      finish(computeLayout(nodes));
    } catch (err) {
      stopTicker();
      if (isStale()) return;
      setStatus(t('Layout failed: {0} (reduced nodes: {1})', (err as Error).message, String(nodes.length)));
    }
  };

  try {
    const worker = await createLayoutWorker();
    if (isStale()) {
      worker.terminate();
      return;
    }
    startTicker(t('Computing layout…'));

    worker.addEventListener('error', (event) => {
      worker.terminate();
      stopTicker();
      fallbackToMainThread(event.message);
    });

    worker.addEventListener('message', (event: MessageEvent<LayoutWorkerMessage>) => {
      worker.terminate();
      stopTicker();
      if (event.data.type === 'result') {
        finish(event.data.graph);
      } else {
        fallbackToMainThread(event.data.message);
      }
    });

    worker.postMessage({ type: 'layout', nodes });
  } catch (err) {
    stopTicker();
    fallbackToMainThread((err as Error).message);
  }
}

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  if (event.data.type === 'graphData') {
    void handleGraphData(event.data.commits, event.data.focusOnHead === true);
  } else if (event.data.type === 'error') {
    rootEl!.replaceChildren();
    setStatus(t('Error: {0}', event.data.message));
  } else if (event.data.type === 'commitTooltip') {
    hoverTooltip.handleResponse(event.data.commitId, event.data.text);
  } else if (event.data.type === 'commitTooltipError') {
    hoverTooltip.handleError(event.data.commitId, event.data.message);
  }
});

vscode.postMessage({ type: 'ready' });
