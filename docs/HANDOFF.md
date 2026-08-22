# Handoff: Git Revision Graph (VSCode extension)

Continuation notes for picking this project up in a new session. Written 2026-08-22.

## Goal

Build a VSCode extension that visualizes a Git repository's commit DAG (branches,
merges, tags), modeled on TortoiseGit's "Revision Graph" feature.

## Where things live

- **New project**: `D:\gitwork\revision-graph` — a standalone git repo, independent
  from the TortoiseGit source tree.
- **GitHub remote**: `https://github.com/m-tmatma/revision-graph.git` (`origin`),
  `master` branch pushed.
- **Design doc**: [docs/DESIGN.md](./DESIGN.md) — the full approved design (see
  summary below). Committed on `master` (commit `5af0b58`).
- **Current work branch**: `feature/m1-core-graph`, branched from `master`, **not
  yet pushed / no PR opened**. Contains uncommitted new files (see "Current file
  state" below).

## Key decisions made in this thread

1. **Scope**: full feature parity with TortoiseGit's Revision Graph (not a
   trimmed MVP) — see DESIGN.md "ゴール/非ゴール" for the exact include/exclude list.
2. **Data source**: shell out directly to the `git` CLI (`child_process.spawn`),
   not the VSCode Git extension API, not isomorphic-git.
3. **Rendering**: SVG (not Canvas).
4. **Layout engine**: **`@dagrejs/dagre`** (MIT). Originally chose **elkjs**
   (`elk.layered`) because it mirrors TortoiseGit's OGDF Sugiyama pipeline
   (ranking → crossing minimization → coordinate assignment) more closely
   than dagre — but elkjs is EPL-2.0, which FSF lists as GPL-incompatible,
   and elkjs doesn't grant GPL as an EPL-2.0 "Secondary License". Switched to
   dagre (also a layered/Sugiyama-style algorithm, MIT license, fully
   GPL-compatible) once that was caught. See item 8 and
   [CLAUDE.md](../CLAUDE.md) for the license policy this triggered. Runs
   inside a Web Worker in the webview so layout computation never blocks the
   render thread.
5. **Process split**: Extension Host (Node) does git log fetch + DAG
   construction + straight-line elision; Webview (browser context) does
   dagre layout (in a worker) + SVG rendering + interaction. Any actual git
   mutation (checkout, ref deletion, etc.) must be delegated back to the
   Extension Host — the webview cannot run git itself.
6. **PR workflow**: **sequential PRs per milestone** (not a stacked-PR chain).
   Branch for a milestone → PR → merge to `master` → branch the next milestone
   from the updated `master`. (User explicitly declined the gh-stack /
   stacked-PR approach.)
7. **Code comments**: English only, even though this conversation and the
   design doc are in Japanese.
8. **License**: **GPLv2**, matching TortoiseGit's license. `LICENSE` is added
   (commit `ce02bde`) — GPLv2 text copied verbatim from TortoiseGit's own
   LICENSE, with the intro paragraph and copyright line rewritten for this
   project. `CLAUDE.md` records the resulting policy: no dependency whose
   license is GPL-incompatible per the FSF list
   (https://www.gnu.org/licenses/license-list.html); this is what caught the
   elkjs/EPL-2.0 issue in item 4 and is why dagre (MIT) is the layout engine
   instead.

## TortoiseGit research summary (why the design looks like this)

Researched `src/TortoiseProc/RevisionGraph/*` in the TortoiseGit source tree.
Key findings that motivated the design:

- **Data model**: no bespoke graph-node struct; a `CLogDataVector` (ordered
  hash list) + `CLogCache` (hash → commit metadata) + `MAP_HASH_NAME` (hash →
  ref names) feed an `ogdf::Graph` where `node->index()` is the only link back
  to metadata.
- **Log fetching**: an embedded, modified copy of Git's own C sources
  (not libgit2, not shelling to `git.exe`), driven via `git_open_log` /
  `git_get_log_nextcommit`. Range depends on filter dialog: `HEAD` only, local
  branches, explicit `^from to`, or all branches (`--all`-equivalent).
- **DAG construction**: one node per commit hash, edges from child → parent by
  looking up each `m_ParentHash[j]` in the hash→index map; synthetic nodes are
  created for parents outside the fetched range.
- **Layout**: entirely delegated to **OGDF's SugiyamaLayout** —
  `OptimalRanking` (rank/row assignment) → `MedianHeuristic` (crossing
  minimization / lane order) → `FastHierarchyLayout` (final x/y + edge bend
  points). No bespoke lane-assignment code exists in TortoiseGit itself; it all
  lives inside the linked OGDF library.
- **Reduction/elision pass**: commits are kept if they have a ref pointing at
  them (or are a submodule pointer); a commit with exactly one parent and one
  child (a non-branching straight run) is spliced out — the child's parent
  pointer is rewritten straight to the grandparent, and the commit is dropped.
  This only runs when the "hide all tags" or "show branchings/merges" toggles
  are active.
- **Rendering**: a `GraphicsDevice` abstraction shares one draw path across
  on-screen GDI+, SVG export, WMF export, and Graphviz export. Nodes are
  rounded/cut-corner rectangles, stacking one label per ref inside the same
  box; color is chosen **by ref type** (current branch / local branch / remote
  branch / tag / stash / bisect / other), not by branch identity, using a
  fixed palette plus WCAG-luminance-based contrast text color. Edges are plain
  polylines (not bezier) built from OGDF's bend points, clipped to node borders
  before drawing; arrowheads are hand-computed triangles.
- **Interactivity**: Ctrl+wheel zoom, drag-to-pan, rubber-band zoom, a
  minimap (rendered via the same draw path at reduced scale), click / Ctrl+click
  2-node selection for diff/compare, a dynamically built context menu, and
  tooltips via linear hit-testing over node rects (O(n), fine at typical repo
  sizes but flagged as worth optimizing in a web port).
- **Threading**: the entire fetch → DAG build → layout pipeline runs on a
  worker thread (`CFuture<bool>`), posting back to the UI thread only for
  paint/scrollbar/minimap updates. There is no incremental update — every
  filter change tears down and rebuilds the whole graph and reruns layout from
  scratch; only per-commit metadata is memoized by hash.
- **Legacy remnants**: an older, richer SVN-derived two-stage node/state model
  (`CVisibleGraphNode`, `CRevisionGraphState`, expand/collapse glyphs, copy/
  rename tracking) exists only as dead `#if 0` code — deliberately simplified
  away when OGDF/Sugiyama replaced the bespoke SVN layout engine. This is why
  the new project's design explicitly excludes copy/rename tracking and
  expand/collapse glyphs from scope.

Full architecture, data model, milestones, and file layout: see
[docs/DESIGN.md](./DESIGN.md) (already committed to `master`).

## Current file state (on `feature/m1-core-graph`)

`LICENSE` is committed on this branch (`ce02bde`). Everything else below is
present in the working tree but **not yet committed**. M1 ("core display":
git log fetch → DAG build → dagre layout → static SVG render, no pan/zoom
yet) is functionally complete and passing its own build/typecheck/test, but
has **not yet been sanity-checked end-to-end in a real Extension Development
Host window** — see "Immediate next steps".

- `package.json` — extension manifest; command `revisionGraph.show`, SCM title
  menu entry, deps: `@dagrejs/dagre` (runtime), `esbuild`/`typescript`/
  `vitest`/`@types/vscode`/`@types/node` (dev).
- `CLAUDE.md` — license policy: no GPL-incompatible dependency, per the FSF
  compatibility list. This is why the layout engine is dagre, not elkjs (see
  DESIGN.md's "レイアウトアルゴリズム" and HANDOFF item 8 above).
- `tsconfig.json` — ES2022, strict, `moduleResolution: Bundler`.
- `esbuild.js` — three build targets: `src/extension.ts` → `dist/extension.js`
  (node/cjs), `src/webview/main.ts` → `dist/webview/main.js` (browser/iife),
  `src/webview/layoutWorker.ts` → `dist/webview/layoutWorker.js`
  (browser/iife, runs as a Web Worker); also copies `src/webview/panel.html`
  to `dist/webview/panel.html` verbatim (not run through esbuild — it's a
  template with `__CSP__`/`__NONCE__`/`__SCRIPT_URI__`/`__WORKER_URI__`
  placeholders that `extension.ts` fills in at runtime).
- `.gitignore` — `node_modules/`, `dist/`, `out/`, `*.vsix`, `.vscode-test/`.
- `.vscode/launch.json`, `.vscode/tasks.json` — F5 runs the "Run Extension"
  extensionHost launch config, with `npm run watch` as the pre-launch build
  task.
- `src/shared/types.ts` — shared types used by both extension host and webview:
  `RefType`, `RefInfo`, `GraphCommit`, `LogScopeOptions`, `ReduceOptions`,
  `HostToWebviewMessage`, `WebviewToHostMessage`, `GraphNode`, `LaidOutNode`,
  `LaidOutEdge`, `LaidOutGraph`.
- `src/git/logReader.ts` — shells out to `git log --pretty=format:...` (fields
  separated by `\x1f`) plus `git for-each-ref` + `git rev-parse HEAD` for ref
  info; exports `fetchCommits(cwd, options: LogScopeOptions): Promise<GraphCommit[]>`,
  plus the pure helpers `buildLogArgs`/`classifyRef`/`displayRefName`/
  `parseLogLine` (extracted so they're unit-testable without a real repo).
- `src/git/dagReducer.ts` — the straight-line elision pass: `reduceDag(commits, options)`.
  Builds a child-count map, marks commits for elision when they have no
  "protecting" ref (tags don't count unless `showAllTags`) and exactly one
  parent and one child, then resolves each surviving commit's parents through
  the elided chain to the nearest kept ancestor.
- `src/extension.ts` — `activate()` registers `revisionGraph.show`; the
  command creates a `WebviewPanel` (nonce-based CSP), reads
  `dist/webview/panel.html`, fills in the placeholders (including
  `webview.asWebviewUri` for `main.js` and `layoutWorker.js`), waits for a
  `{type:'ready'}` message from the webview, then calls `fetchCommits` (scope
  `all-branches`, hardcoded default for M1 — filter UI is M2) → `reduceDag`
  → posts `{type:'graphData', commits}`.
- `src/webview/panel.html` — the template described above.
- `src/webview/main.ts` — on load, posts `{type:'ready'}`; on receiving
  `graphData`, measures each node's size via `canvas.measureText` (one row
  per ref label, or the short hash if the commit has no refs — see
  `render/layoutConstants.ts` for the shared row-height/padding constants),
  then hands the sized `GraphNode[]` to the layout worker and renders the
  `LaidOutGraph` result via `renderGraph`. Loads the worker by **fetching its
  script and constructing a `blob:` URL**, not `new Worker(asWebviewUri(...))`
  directly — the latter fails silently in VSCode's webview sandbox. If the
  worker errors (e.g. `RangeError: Maximum call stack size exceeded` — seen
  on TortoiseGit's own ~1000-node-after-reduction, ~1085-rank-deep history;
  dagre's ranking pass recurses to a depth tracking the graph's longest
  chain, and a Worker's stack is smaller than the main thread's), falls back
  to calling `computeLayout` directly on the main thread (blocking, but with
  a larger stack) rather than just failing.
- `src/webview/computeLayout.ts` — the actual dagre call, pulled out so both
  `layoutWorker.ts` and `main.ts` can call it. Builds a
  `dagre.graphlib.Graph` (`rankdir: 'TB'`) with an edge per commit→parent
  link (so newer commits rank above their ancestors), calls `dagre.layout(g)`
  synchronously, converts dagre's center-based node coordinates to the
  top-left convention `LaidOutNode` uses.
- `src/webview/layoutWorker.ts` — calls `computeLayout` inside the Web
  Worker and posts back `{type:'result', graph: LaidOutGraph}` (or
  `{type:'error', message}`).
- `src/webview/render/colors.ts` — fixed ref-type color palette +
  WCAG-relative-luminance contrast text color.
- `src/webview/render/layoutConstants.ts` — `NODE_ROW_HEIGHT`/`NODE_PADDING_X`/
  `NODE_PADDING_Y`/`NODE_MIN_WIDTH`, shared between `main.ts` (sizing) and
  `graphRenderer.ts` (drawing) so they can't drift apart.
- `src/webview/render/graphRenderer.ts` — builds the SVG: rounded-rect nodes
  with one colored chip per ref (or the short hash, unstyled, if there are no
  refs), polyline edges using dagre's `points` directly (no manual
  node-border clipping needed — dagre already anchors edge points at the
  node boundary), arrowheads via an SVG `<marker>`.
- `test/dagReducer.test.ts`, `test/logReader.test.ts` — vitest, synthetic
  commit data, no real git repo needed. 27 tests, all passing.

## Immediate next steps (not yet done)

1. ~~Manually sanity-check M1 end-to-end~~ — **done**. Verified against the
   TortoiseGit repo itself (`--all`, 12,102 commits → 1,024 after
   reduction) via `F5`; the graph renders correctly. Two real bugs were
   found and fixed along the way (both described above): the direct
   `new Worker(asWebviewUri(...))` webview issue, and the worker-stack-depth
   overflow on TortoiseGit's very deep history (now has a main-thread
   fallback).
2. Commit the current working-tree state (everything listed above except
   `LICENSE`, which is already committed on this branch), push
   `feature/m1-core-graph`, open a PR against `master`.

## Milestones after M1 (per DESIGN.md, each its own sequential PR)

- **M2**: filter dialog (all-branches / local-branches / current-branch /
  from-to range), straight-line elision toggle, "show all tags" toggle.
- **M3**: pan/zoom, 2-node selection for compare, context menu (checkout,
  delete ref, copy hash, compare), tooltips.
- **M4**: minimap, SVG/PNG export, automatic refresh on repo change (via the
  `vscode.git` extension API's `Repository.state.onDidChange`).
