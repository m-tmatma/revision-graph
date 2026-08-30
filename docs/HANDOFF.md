# Handoff: Git Revision Graph (VSCode extension)

Continuation notes for picking this project up in a new session. Written 2026-08-22.

## Goal

Build a VSCode extension that visualizes a Git repository's commit DAG (branches,
merges, tags), modeled on TortoiseGit's "Revision Graph" feature.

## Where things live

- **New project**: `D:\gitwork\revision-graph` — a standalone git repo, independent
  from the TortoiseGit source tree.
- **GitHub remote**: `https://github.com/m-tmatma/vscode-git-revision-graph.git`
  (`origin`), `master` branch pushed. Repo (and the `package.json` name) was
  originally `revision-graph`, renamed to `vscode-git-revision-graph` later
  (a plain "git-revision-graph" was already taken by an unrelated Python
  project) — the local folder `D:\gitwork\revision-graph` was intentionally
  left as-is, so it no longer matches the repo name.
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

## M1 status: done, merged to `master`

M1 ("core display": git log fetch → DAG build → dagre layout → static SVG
render, no pan/zoom yet) is merged (PR #1) and was manually verified against
the TortoiseGit repo itself (`--all`, 12,102 commits → 1,024 after
reduction). Also merged since: `.github/workflows/ci.yml` (typecheck/test/
build/vsix-package on every push and PR, PR #2) and a root `README.md`
(PR #3). File listing below is retained as an architecture reference.

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
  `webview.asWebviewUri` for `main.js` and `layoutWorker.js`), then holds
  per-panel `scope`/`reduce` state (defaults: `all-branches`,
  `{collapseStraightRuns: true, showAllTags: false}`). On `{type:'ready'}`
  or `{type:'setFilter', scope, reduce}` from the webview, updates that
  state and re-runs `fetchCommits` → `reduceDag` → posts
  `{type:'graphData', commits}` (or `{type:'error', message}` on failure). A
  `requestGeneration` counter discards stale results if a newer filter
  change was applied before an in-flight `git log` resolved.
- `src/webview/panel.html` — the template described above. Also holds the M2
  filter toolbar: a `#scope-select` (`all-branches`/`local-branches`/
  `current-branch`/`range`), `#range-inputs` (From/To text fields, hidden
  unless scope is `range`), `#show-branches-merges-toggle`/`#show-tags-toggle`
  checkboxes (the former renamed post-M4 from `#collapse-toggle`, with
  inverted checked-state semantics, to match TortoiseGit's own "Show
  branches and merges" wording/default), and a `#refresh-button`. `<main>`
  is a column flexbox so the
  toolbar stays fixed while `#graph-scroll` (wrapping status+root) scrolls
  independently.
- `src/webview/main.ts` — on load, posts `{type:'ready'}`. The toolbar
  controls call `applyFilter()` on change (select/checkboxes: immediately;
  the From/To text inputs: on blur or Enter, not on every keystroke) to post
  `{type:'setFilter', scope, reduce}` built from the current control values
  (`toRef` defaults to `'HEAD'` when the To field is empty). On receiving
  `graphData`, measures each node's size via `canvas.measureText` (one row
  per ref label, or the short hash if the commit has no refs — see
  `render/layoutConstants.ts` for the shared row-height/padding constants),
  then hands the sized `GraphNode[]` to the layout worker and renders the
  `LaidOutGraph` result via `renderGraph`. On receiving `{type:'error'}`,
  clears the graph and shows the message in `#graph-status` instead of
  hanging. Loads the worker by **fetching its script and constructing a
  `blob:` URL**, not `new Worker(asWebviewUri(...))` directly — the latter
  fails silently in VSCode's webview sandbox. If the worker errors (e.g.
  `RangeError: Maximum call stack size exceeded` — seen on TortoiseGit's own
  ~1000-node-after-reduction, ~1085-rank-deep history; dagre's ranking pass
  recurses to a depth tracking the graph's longest chain, and a Worker's
  stack is smaller than the main thread's), falls back to calling
  `computeLayout` directly on the main thread (blocking, but with a larger
  stack) rather than just failing.
- `src/webview/computeLayout.ts` — the actual dagre call, pulled out so both
  `layoutWorker.ts` and `main.ts` can call it. Builds a
  `dagre.graphlib.Graph` (`rankdir: 'TB'`) with an edge per commit→parent
  link (so newer commits rank above their ancestors), calls `dagre.layout(g)`
  synchronously, converts dagre's center-based node coordinates to the
  top-left convention `LaidOutNode` uses. Computes `width`/`height` itself
  from the actual max extent of every node **and every edge bend point**,
  rather than trusting dagre's own `graph.width`/`height` — those only
  account for node extents, so an edge routed around another node to avoid
  a crossing could extend past them, and the SVG viewBox (sized from
  `width`/`height`) would silently clip it, making the edge look cut off.
  Found via a real repro: a merge commit's second parent edge detour past
  `graph.width` in exactly this way (see PR #4).
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

## M2 status: done, manually verified, not yet committed

M2 (filter UI: scope select, straight-line elision toggle, show-all-tags
toggle, From..To range) is implemented per the file listing above and was
manually verified end-to-end in a real Extension Development Host, including
a real bug found and fixed along the way: dagre's `graph.width`/`height`
don't include edges that route around other nodes to avoid crossings, so the
SVG viewBox (sized from those) clipped such edges, making lines look cut
off. Fixed in `computeLayout.ts` by computing the bounding box from actual
node/edge coordinates instead (see the file listing above).

**Test/demo repo**: https://github.com/m-tmatma/revision-graph-test — a
small synthetic repo (branches, a merge, tags, an unreached branch, a
remote-only branch) built specifically so every scope/toggle combination
visibly changes the rendered graph, with expected node counts documented in
its own README. Useful for regression-checking M2 (and later M3/M4)
features by hand, since a real repo's filter differences are often too
subtle to eyeball.

**Not yet done**: commit the current working-tree state (`src/extension.ts`,
`src/shared/types.ts`, `src/webview/computeLayout.ts`, `src/webview/main.ts`,
`src/webview/panel.html`, `src/webview/render/graphRenderer.ts`), push a
branch, open a PR against `master`, update this section once merged.

## M3 status: done

M3 slices are landing as separate, self-contained PRs rather than one PR for
the whole milestone, per the user's explicit request ("M3 は要素ずつ PR 分けて"):

- **Scroll to current branch / current-branch highlighting** (shipped
  first, superseded by pan/zoom below): `logReader.ts`'s `fetchRefs`
  resolves the checked-out branch name (`git symbolic-ref --short -q HEAD`)
  and labels that branch's own ref `current-branch` (pure red, `#ff0000` in
  `colors.ts`) instead of adding a separate literal "HEAD" chip next to it —
  matches TortoiseGit's own convention (the user pointed at a real
  TortoiseGit screenshot showing the checked-out branch itself in red, not a
  separate HEAD label). The literal `head`/"HEAD" ref type still exists as a
  fallback for detached-HEAD state, where there's no branch to highlight.
- **Pan/zoom** (`src/webview/render/panZoom.ts`, `PanZoomController`):
  replaced the native `overflow: auto` scrolling from M1/M2 with a
  hand-rolled SVG `viewBox`-based pan/zoom, per DESIGN.md. Drag pans; plain
  wheel also pans; Ctrl/Cmd+wheel zooms centered on the cursor
  (`MIN_SCALE`/`MAX_SCALE` 0.05–8). `graphRenderer.ts`'s `renderGraph` no
  longer sizes the SVG to the graph's content (`width`/`height` are now
  `100%`, filling `#graph-scroll`) — `panZoom.ts` owns the viewBox instead.
  `#graph-scroll` changed from `overflow: auto` to `overflow: hidden;
  position: relative`, and `#graph-root` is now absolutely positioned
  (`inset: 0`) so it isn't pushed around by `#graph-status`'s flow height.
  `main.ts`'s old scroll-based `scrollToHead` became `renderAndFocus`,
  which creates a `PanZoomController` per render and calls
  `controller.centerOn(...)` on the current-branch node (or the graph's
  center, if none is in view) instead of `scrollTo`.

  Two real bugs surfaced during manual verification and are fixed in the
  same PR:
  - Dragging was janky (smooth via wheel, not via drag): `pointermove`
    fires far more often than the browser can repaint a large SVG, and the
    original code wrote the `viewBox` synchronously on every event.
    Batched into at most one update per `requestAnimationFrame`.
  - Dragging stopped responding entirely after the *first* drag gesture:
    traced to `container.setPointerCapture()` — unreliable specifically
    inside VSCode's webview. Replaced with `window`-level
    `pointermove`/`pointerup` listeners (no capture needed; a plain flag
    tracks whether a drag is in progress). While in there, also added a
    `destroy()` method and had `renderAndFocus` call it on the *previous*
    controller before creating a new one — every re-render was otherwise
    leaving a full set of window-level listeners behind, fighting over an
    SVG no longer even in the DOM.

- **Tooltips**: an SVG `<title>` as the first child of each node's `<g>`
  group gives every part of it a native browser tooltip on hover — no extra
  JS/CSS needed. Text matches TortoiseGit's own tooltip layout, per a
  screenshot the user provided: full hash, then `{authorName}
  <{authorEmail}> {date}` (`YYYY-MM-DD HH:mm`, not locale-dependent
  `toLocaleString()`), a blank line, then the full commit message (not just
  the subject).

  Showing the full message required a real parsing change: `GraphCommit`
  gained a `body` field (git's `%B` — subject plus body), and since a
  commit message can contain embedded newlines, `logReader.ts` could no
  longer parse `git log` one line at a time. `fetchCommits` now buffers the
  whole `git log` output (a new `runGitBuffered`, alongside the
  line-streaming `runGitLines` still used for `for-each-ref`/`rev-parse`/
  `symbolic-ref`, none of which have multi-line values) and splits records
  on `\x1e` (RECORD_SEP) instead of `\n` — `%B` is the last field in the
  format string specifically so embedded newlines in the body can't be
  mistaken for a record boundary. `parseLogLine` was renamed `parseLogRecord`
  to match. This is a deliberate step back from DESIGN.md's original
  "stream so large repos don't need one big buffer" goal, traded for
  correctness; revisit if a large repo's memory use becomes a real problem.
  Verified against real multi-paragraph merge commit messages in the
  TortoiseGit repo itself, not just synthetic test data.

- **Node selection** (`src/webview/render/selection.ts`, `SelectionController`):
  click selects a single node (highlighted via its `<rect>`'s `stroke`/
  `stroke-width`, `var(--vscode-focusBorder)`); Ctrl/Cmd+click adds a
  second, for the still-unbuilt "compare" context-menu action. State is
  `{ first: string | null; second: string | null }`, tracked in the
  controller, not yet surfaced to the extension host (nothing consumes it
  yet — that's the context menu's job). `graphRenderer.ts`'s `buildNode`
  tags each node's `<g>` with `data-commit-id` so a click can be resolved
  back to a commit hash. Deliberately does **not** use the native `click`
  event: since `panZoom.ts` treats the same pointerdown-to-pointerup
  gesture as a pan, `selection.ts` independently tracks pointerdown/
  pointerup positions and only treats it as a selection if the pointer
  moved less than 4px — otherwise a drag-to-pan would also fire spurious
  selection changes. Lifecycle matches `PanZoomController`: a new
  `SelectionController` is created per render in `renderAndFocus`, with the
  previous one `destroy()`d first.

- **Context menu — "Compare" only** (`src/webview/render/contextMenu.ts`):
  right-clicking one of the two currently-selected nodes shows a small
  custom HTML/CSS menu (webviews can't use VSCode's native menu API) with a
  single "Compare `<hashA>` with `<hashB>`" item — right-clicking anything
  else (an unselected node, the background) does nothing, since there's no
  other menu item yet. Clicking it posts `{type:'compare', from, to}` to
  the extension host (`WebviewToHostMessage`).

  This turned into a materially bigger feature than a plain `git diff`
  text dump: the user asked for something closer to TortoiseGit's own
  "Compare Revisions" dialog (a screenshot of it was provided) — a
  changed-files list with per-file added/deleted line counts, opened as
  its own panel (they'd first asked whether it could be a genuinely
  separate OS window; VSCode extensions have no supported API for that —
  a `WebviewPanel` is always a tab/split within the same VSCode window,
  though a user can drag any tab out into its own window themselves).

  What's built, on `{type:'compare'}`:
  - `src/git/gitActions.ts` (new): `getCommitSummary` (hash + subject, via
    `git log -1`), `diffFileChanges` (per-file added/deleted line counts
    and A/M/D status, via parallel `git diff --no-renames --numstat` and
    `--no-renames --name-status` calls merged by path — `--no-renames` is
    deliberate: without it, a renamed file's numstat path uses an
    ambiguous `old => new` notation that's needlessly fiddly to parse
    correctly; renames just show as a delete + an add instead), and
    `readFileAtRevision` (`git show rev:path`, returning `''` if the file
    doesn't exist at that revision — expected for a file the diff added or
    deleted, not an error).
  - `extension.ts`'s `showCompareChanges` opens a **second, separate**
    `WebviewPanel` (`'revisionGraphCompare'`, title "Changed Files",
    `ViewColumn.Beside`) with its own minimal webview: a header (which
    commit is "from"/"to") and a static table (file / extension / action /
    added / deleted), built from `src/webview/compare.ts` +
    `comparePanel.html` — no dagre/worker/pan-zoom needed, just a table.
    New esbuild entry point (`compareConfig`) and `copyHtmlTemplates`
    (renamed from `copyPanelHtml`, now copies both HTML templates).
  - Clicking a file row posts `{type:'openFile', path}` back;
    `openFileDiff` opens it in VSCode's **native** side-by-side diff view
    via `vscode.diff`, comparing two virtual documents under a registered
    `revision-graph-git://<rev>/<path>` `TextDocumentContentProvider`
    (registered once in `activate()`) that resolves content through
    `readFileAtRevision`. Using the real path (not an encoded blob) in the
    URI keeps the file extension intact, so VSCode's language detection
    still syntax-highlights the diff correctly.
  - New shared types: `FileChange`, `CompareData`,
    `CompareHostToWebviewMessage`, `CompareWebviewToHostMessage` — kept
    separate from the main graph panel's own message types, since these
    two webviews never talk to each other, only each to the extension
    host.

  Verified against real multi-file changes in the TortoiseGit repo,
  including one that touches a submodule reference (`ext/tgit`) — that
  path correctly falls back to empty content rather than erroring, since
  `git show rev:path` doesn't return normal blob content for a submodule
  gitlink entry.

- **Context menu — "Copy full hash"**: right-clicking *any* node now
  always shows a menu (previously the menu only appeared when the
  right-clicked node was one of exactly two selected nodes, since
  "Compare" was the only item). Copies via `navigator.clipboard.writeText`
  directly in the webview — no extension-host round trip needed, unlike
  "Compare". "Compare" itself still only appears as a second item when
  applicable (two selected, and the right-clicked node is one of them).

- **Context menu — "Checkout"** (a full custom-Webview dialog, not a
  one-click action — the user asked for something closer to TortoiseGit's
  own "Switch/Checkout" dialog, screenshot provided as reference):
  - `checkoutMenuItem` (`main.ts`) decides the checkout target from the
    right-clicked node's refs: its own `local-branch` ref if it has one;
    otherwise its `remote-branch` ref, with a suggested local branch name
    (the remote name's `<remote>/` prefix stripped, e.g. `origin/foo` ->
    `foo`) passed along for the dialog to pre-fill; otherwise the bare
    commit hash (detached HEAD). Omitted entirely if the node already **is**
    the current branch.
  - Unlike TortoiseGit's general-purpose dialog (invoked independent of any
    selection, with its own Branch/Tag/Commit target picker), this one's
    target is fixed to whatever node was right-clicked — no target picker,
    since the whole point of driving it from the graph is that the target
    is already chosen. Only the **options** section is reproduced:
    "Create new branch" (+ name field), "Track", "Overwrite existing branch
    if present" (`-B` vs `-b`), "Force" (discard uncommitted changes) and
    "Merge" (`git checkout --merge`, three-way-merges uncommitted changes
    into the target instead of discarding them — confirmed working against
    a real uncommitted file in an external repo, D:\sakura2, provided by
    the user for testing: the file survived the merge-checkout).
  - New `src/git/gitActions.ts` function `checkoutRef(cwd, ref, options)`
    builds `git checkout [--force] [--merge] [-b|-B <name> [--track]] <ref>`.
  - New third `WebviewPanel` (`'revisionGraphCheckout'`, title
    "Switch / Checkout") + `webview/checkoutDialog.ts`/`.html` (new esbuild
    entry point). On submit, `extension.ts`'s `showCheckoutDialog` runs
    `checkoutRef`, shows a success/error message, disposes the dialog panel,
    and — since this was a checkout WE just performed, not an external
    change to watch for (that's M4 scope) — calls the main graph panel's
    `refresh()` so the current-branch highlight/position updates
    immediately.
  - New shared types: `CheckoutTarget`, `CheckoutOptions`,
    `CheckoutHostToWebviewMessage`, `CheckoutWebviewToHostMessage`.
  - **Update submodules** option (`CheckoutOptions.updateSubmodules`): a
    checkbox that runs `git submodule update --init --recursive`
    (`gitActions.ts`'s `updateSubmodules`) right after a successful
    checkout — raised after testing against D:\sakura2, which has
    submodules (e.g. `externals/ctags`), where a checkout alone doesn't
    update them, only changes what the submodule pointer is expected to be.
    Reported as a separate success/failure from the checkout itself (the
    checkout has already succeeded by the time this runs, so a submodule
    failure shouldn't read as "checkout failed"), and the graph still
    refreshes either way. Confirmed working against D:\sakura2.

- **Context menu — "Copy ref name(s)"**: copies every ref on the
  right-clicked node at once (its full `refs/heads/...`/`refs/remotes/...`/
  `refs/tags/...` path, one per line), rather than requiring a click on
  each ref chip individually — raised because a node commonly carries both
  a local and a remote branch pointing at the same commit (per a
  TortoiseGit screenshot the user provided showing its own "ref名をコピー"
  item, plus a follow-up clarifying they wanted *all* of a node's refs
  copied together as full paths, not just one display name at a time).
  `main.ts`'s new `fullRefName` reconstructs the full path — `GraphCommit
  .refs` only carries the already-stripped display name
  (`logReader.ts`'s `displayRefName`), so this is that function's inverse.
  Omitted entirely if the node has no refs.

- **Context menu — "Delete ref"** (the last M3 item): only offered when
  the right-click lands on a *specific* ref chip — unlike "Copy ref
  name(s)", deletion is inherently per-ref, so `graphRenderer.ts`'s
  `buildRefRow` tags each ref row with `data-ref-name`/`data-ref-type`
  (brought back after being reverted during "Copy ref name(s)", which
  turned out not to need per-row targeting after all). `main.ts`'s
  `isDeletableRefType` excludes `current-branch` (can't delete the branch
  you're on), `head` (not a real ref), `stash` (needs an index, not a
  name, to target one entry — a different operation), and `other` (too
  ambiguous). Before running anything, `extension.ts`'s `handleDeleteRef`
  shows a native modal confirmation (`vscode.window.showWarningMessage`,
  "This cannot be undone.") — this is a destructive action, unlike every
  other context-menu item so far.

  What "delete" means was an explicit product decision, asked of the user
  given the range of severity across ref types:
  - `local-branch`: `git branch -d` (safe delete — refuses if not fully
    merged; no force option offered yet).
  - `tag`: `git tag -d`.
  - `remote-branch`: `git update-ref -d refs/remotes/<name>` — **local
    bookkeeping only**. Does **not** run `git push origin --delete` or
    otherwise touch the actual branch on the remote server. The user chose
    this explicitly over the alternative (also deleting on the remote)
    specifically because that would affect state shared with other
    people — out of scope for a plain right-click action.
  - New `gitActions.ts` functions: `deleteLocalBranch`, `deleteTag`,
    `deleteRemoteTrackingRef`.

  **Update, post-M4**: `isDeletableRefType` now only allows
  `local-branch` — `remote-branch` and `tag` were dropped. A local branch
  and the remote-tracking branch it tracks commonly stack as separate,
  closely-spaced ref chips on the same node (e.g. "master" right above
  "origin/master"), and a right-click meant for the local one landing on
  the remote-tracking one instead turned out to be an easy mistake in
  practice — harmless and `git fetch`-recoverable, but confusing to hit
  by accident. `deleteTag`/`deleteRemoteTrackingRef` and
  `handleDeleteRef`'s handling of those ref types are left in place in
  `extension.ts`/`gitActions.ts`; only the webview's menu no longer offers
  them.

  **Update, post-M4 (again)**: deleting a local branch not yet merged
  into HEAD used to just fail — `deleteLocalBranch` always ran the safe
  `git branch -d`, which git itself refuses in that case, surfacing as a
  plain "delete failed" error with no way to proceed. Read TortoiseGit's
  actual source (`BrowseRefsDlg.cpp`'s `ConfirmDeleteRef`) to see how it
  handles the same situation: not a try-the-safe-delete-and-react-to-the-
  refusal flow, but a merge check *before* asking
  (`CGit::IsFastForward`-equivalent), with an extra warning line folded
  into the same confirmation dialog when the branch isn't merged — no
  second dialog, no retry. `gitActions.ts`'s new `isBranchMerged(cwd, ref,
  into = 'HEAD')` runs `git merge-base --is-ancestor` for this (exit code
  1 is that command's normal way of saying "no", not a failure — only
  other exit codes reject). `handleDeleteRef` checks it for
  `local-branch`/`current-branch` before building the confirmation
  message, appends the warning when unmerged, and passes that same
  boolean straight through to `deleteLocalBranch`'s new `force` parameter
  (`git branch -D` instead of `-d`) — so a merged branch still gets the
  safe delete, and an unmerged one only gets forced after the user saw
  the warning and confirmed anyway.

**M3 is now fully done**: pan/zoom, node selection, tooltips, and the full
context menu (checkout, copy hash, copy ref name(s), compare, delete ref).
Next up per DESIGN.md: **M4** (minimap, SVG/PNG export, automatic refresh
on repo change).

## M4 status: done

M4 items landed one at a time, same as M3.

- **Automatic refresh on repo change** (done, `src/git/repoWatcher.ts`):
  `watchRepositoryChanges(cwd, onChange)` gets the built-in `vscode.git`
  extension's API (activating it if needed), finds the `Repository` whose
  `rootUri.fsPath` matches `cwd` (case-insensitive — Windows drive-letter
  casing can differ between VSCode's own resolution and the git
  extension's), and subscribes to its `state.onDidChange`. Also listens on
  `git.onDidOpenRepository`, since the matching repository may not exist
  yet when this runs (the git extension discovers repositories
  asynchronously). `state.onDidChange` fires for more than ref/HEAD
  changes (working tree edits too) and can fire several times in quick
  succession for one user action, so events are debounced (500ms) before
  triggering `refresh()` — the same function filter changes and our own
  checkout/delete-ref actions already use. `showRevisionGraph` disposes
  the watcher when the panel closes (`panel.onDidDispose`). No local
  `@types/vscode.git`-style dependency: the file declares its own minimal
  `GitRepository`/`GitAPI`/`GitExtensionExports` interfaces covering only
  what's used. Confirmed working: checking out a branch from *outside* the
  extension (a terminal, TortoiseGit, another VSCode window) while the
  graph panel is open refreshes it automatically.

- **SVG/PNG export** (done, `exportSvg`/`exportPng` in `src/webview/main.ts`,
  `exportSvg`/`exportPng` message handling + `exportToFile` in
  `src/extension.ts`): both buttons clone the currently-rendered `<svg>`,
  override its `width`/`height`/`viewBox` to the full graph's logical
  bounds (the live element's viewBox only covers the current pan/zoom
  window), and serialize it with `XMLSerializer`. SVG export just posts
  that markup to the extension host, which writes it via
  `vscode.window.showSaveDialog` + `vscode.workspace.fs.writeFile`. PNG
  export additionally rasterizes: load the serialized markup as a
  `data:image/svg+xml` `<img>`, draw it onto a `<canvas>` (background
  filled first with the page's live `--vscode-editor-background` so the
  PNG isn't transparent), then `canvas.toDataURL('image/png')` and post
  the base64 payload over to be decoded and written the same way.

  Two non-obvious failure modes found while building this, both now
  guarded against with a clear `setStatus` error instead of a silent bad
  file:
  - The isolated `<img>` document has no CSP and no connection to the
    live theme, so every fill/stroke is written as
    `var(--vscode-x, <fallback>)` — the fallback color, not the theme
    color, is what actually renders. Acceptable (not theme-matched, but
    visible) for a portable export.
  - **Large repos can produce a graph taller than the browser's 2D canvas
    can allocate** (Chromium's limit is roughly 16384px per side / ~268M
    px total area — hit in practice against a real ~10k-commit history,
    where the laid-out graph came out to `5051 x 112174`). Past that
    limit, `canvas.toDataURL()` does not throw — it silently returns the
    degenerate string `"data:,"`, which looked like a real but
    corrupt/tiny PNG once decoded and written to disk, and took a long
    debugging session (ruling out CSP, `blob:` vs `data:` URL taint, and
    `<marker>`-caused canvas tainting first) to trace back to the canvas
    size itself. `exportPng` now checks `graph.width`/`graph.height`
    against a `16384` / `16384²` limit up front and fails with a message
    pointing at Export SVG instead (unaffected, since it stays vector).

- **Minimap** (done, `src/webview/render/minimap.ts`): a small overlay in
  the bottom-right of the graph panel showing the whole graph scaled down,
  as plain unlabeled node rects (no refs/text/tooltips — illegible at that
  scale, and skipping them keeps rebuilding it on every render cheap even
  for a large history), with a rectangle tracking the main view's visible
  region. Dragging anywhere on it pans the main view there (via a new
  `PanZoomController.panTo(x, y)`, which keeps the current zoom level
  unlike `centerOn`, which resets it); the rectangle stays in sync with
  the main view's own pan/zoom through a new `PanZoomController.onChange`
  subscription (fired once, from inside `apply()`, so it covers every way
  the view can change — wheel, drag, `centerOn`, `panTo` — from one place).
  Rebuilt alongside the main graph on every re-render, same lifecycle as
  `PanZoomController`/`SelectionController` (`destroy()` the old instance
  before creating the new one).

  The container's own box size took three iterations to get right, found
  by testing against real repos of very different shapes:
  1. First, a fixed 200x150 box with the SVG fit inside via the default
     `preserveAspectRatio="xMidYMid meet"`. Our graphs are typically much
     taller than wide (commits flow top-to-bottom), and a real repo's
     history can be dramatically more so — one real test case laid out to
     `5051 x 112174`. At that ratio, "meet" scaling shrank the fitted
     content to a ~7px-wide sliver in the middle of the box, with the rest
     empty — easy to mistake for the minimap not having rendered at all
     (and initially was mistaken for exactly that).
  2. Tried stretching the SVG to fill a fixed box exactly instead
     (`preserveAspectRatio="none"`, no aspect ratio preservation at all).
     Fixed the sliver, but made an *ordinary*, moderately-tall repo's
     minimap needlessly wide — proportions matter for a graph shaped
     close to the box already.
  3. Landed on: keep proportions (default `meet`), but size the
     *container* itself to the graph's aspect ratio within bounds that
     scale with the panel's own size (so a bigger editor pane gets a
     bigger minimap) up to a hard cap, and clamp the computed width up to
     a `MIN_WIDTH` floor for the extreme case — letterboxing only kicks in
     when that floor overrides the "true" scaled width.

**Remaining M4 scope**: none — M4 is done.

## Post-M4: incremental checkout

Not part of the original DESIGN.md milestone plan — added after M4 wrapped,
on request. A **Checkout…** toolbar button opens a native
`vscode.window.showQuickPick` listing every local and remote-tracking
branch: type to fuzzy-filter, arrow keys to move the highlight, Enter to
check out the selected one. No custom webview UI — QuickPick already is
exactly the "edit box + incremental filter + arrow keys + Enter" picker
that was asked for.

- `gitActions.ts`'s new `listCheckoutCandidates(cwd)` runs
  `git for-each-ref --format=%(refname:short) refs/heads/` and the same
  against `refs/remotes/` (dropping `<remote>/HEAD`, which is a symbolic
  ref to the remote's default branch, not a branch), plus
  `git symbolic-ref --short -q HEAD` to mark the current branch.
- Deliberately simple: always a plain `git checkout <target>` (via the
  existing `checkoutRef`, called with every `CheckoutOptions` flag off) —
  no force/merge/create-branch/submodule-update. Those live on the
  right-click "Checkout" item on a specific node, which opens the full
  "Switch / Checkout" options panel instead; this one is meant purely as a
  fast, no-questions-asked branch switch.
- For a remote branch, the QuickPick target isn't the full
  `<remote>/<name>` — it's `<name>` with the remote prefix stripped.
  Checking out the full remote ref directly leaves HEAD detached; the
  short name instead triggers git's own "DWIM" behavior (create, or reuse,
  a local branch tracking it), matching what typing the branch name by
  hand would do.

## Post-M4: compare with default branch

Also on request. Right-clicking any single node now offers "Compare
`<hash>` with default branch", alongside the existing two-node-selection
"Compare" — this one needs only the one node.

- `gitActions.ts`'s new `getDefaultBranchRef(cwd)` resolves "the default
  branch" as `git symbolic-ref --short -q refs/remotes/origin/HEAD` (i.e.
  whatever the remote host — GitHub, etc. — has configured as the repo's
  default branch), falling back to a local `main` or `master` (whichever
  exists) when `origin/HEAD` isn't set (a shallow clone, or a repo with no
  remote at all). Throws if neither is found.
- The webview doesn't resolve or even know the default branch's name —
  it just sends `{ type: 'compareWithDefaultBranch', to: commitId }`, and
  `extension.ts` resolves it and calls the same `showCompareChanges` the
  regular two-node "Compare" already uses, so it's the identical
  "Changed Files" panel either way.

## Post-M4: fixing a real-repo layout crash, and what "Show branches and merges" actually does

Testing against a real, very large external repo surfaced
`RangeError: Maximum call stack size exceeded` — both the layout Worker
*and* its main-thread fallback failed, specifically with "Show branches
and merges" checked (at the time: "show every individual commit,
including ones dagReducer.ts would otherwise elide"). Getting this right
took several wrong turns, worth recording so they aren't retried:

1. **First**: fed dagReducer.ts's *full, unreduced* commit list to the
   layout engine whenever the toggle wanted every commit shown (the
   toggle used to gate whether elision ran at all). dagre's ranking pass
   recurses to a depth tracking the graph's longest chain — for a large
   real repo's full history, that's unbounded, and both the Worker and
   its larger-stack main-thread fallback overflowed.
2. **Then**: made dagReducer.ts's elision unconditional (bounding what
   the layout engine ever sees), and had it separately report each
   elided chain (`{from, to, commits}`) so the webview could splice those
   commits back in as extra nodes, purely for display, only when the
   toggle wanted every commit shown. To give an elided chain proportional
   room, its edge got a longer dagre `minlen` (one rank per elided
   commit). This backfired identically: dagre's own normalization turns a
   long-`minlen` edge into a chain of dummy nodes internally, one per
   intermediate rank, handing the exact same unbounded-recursion problem
   right back for any one very long straight run.
3. **Then**: dropped `minlen` entirely — interpolated the spliced-in
   commits within whatever short span dagre's *default* (minlen 1) layout
   already gave the edge. No more crash, but a long chain's spliced-in
   commits all landed in that same short span and rendered stacked on top
   of each other.
4. **Then**: instead of asking dagre for room, inserted it after the
   fact — sorted each elided chain's needed extra space by where its edge
   fell in the already-laid-out graph, and shifted every node/edge point
   below each insertion point down by the (cumulative) amount needed, via
   a single sort + binary-search pass (`buildOffsetLookup`), nothing
   recursive. This actually worked (no crash, no overlap) — but at that
   point, direct comparison against real TortoiseGit showed all of this
   was solving the wrong problem.

**What TortoiseGit actually does** (confirmed by reading
`RevisionGraphDlgFunc.cpp` and `Git.cpp`, not just observing the UI): a
straight run is *never* shown as individual nodes, checkbox or not —
`m_bShowBranchingsMerges` doesn't gate that at all. What it actually
gates is a `--sparse` flag on the `git log` call itself
(`LOG_INFO_SIMPILFY_BY_DECORATION | (m_bShowBranchingsMerges ? LOG_INFO_SPARSE : 0)`
→ `--simplify-by-decoration [--sparse]`). Unchecked (TortoiseGit's
default), `--simplify-by-decoration` alone lets git itself prune commits
— including whole merges — that aren't reachable from any ref and aren't
needed to preserve ancestry between ones that are, before TortoiseGit
ever sees them. Checked adds `--sparse`, which disables that pruning, so
every merge comes back from git; TortoiseGit's own straight-run elision
(the same kind of pass as our dagReducer.ts) then runs on top of *that*,
same as when unchecked.

**Final design**, matching this exactly: everything from attempts 1–4
above (`expandElidedChains.ts`, `ElidedChain`, the `minlen`/offset-lookup
machinery, the `elidedChains` field on the `graphData` message) was
deleted. `dagReducer.ts`'s elision is unconditional, full stop — the
layout engine only ever sees a bounded graph, always. "Show branches and
merges" now drives `ReduceOptions.simplifyByDecoration`, which
`logReader.ts`'s `buildLogArgs` turns into a `--simplify-by-decoration`
flag on `git log` itself (added when the toggle is *off* — checked, the
default, omits it, matching TortoiseGit's own `--sparse` behavior of
showing every merge). No custom "which merges are relevant" algorithm to
build or maintain — git already has one, TortoiseGit already delegates to
it, so we do too.

## Post-M4: Activity Bar entry point

`package.json`'s `contributes.viewsContainers.activitybar` registers a
new Activity Bar container (`resources/activity-bar-icon.svg` — a plain
diamond of four nodes/edges, standing in for a small branch+merge graph;
VS Code re-colors it to match the theme, so the SVG's own fill color
doesn't matter). Its one view (`revisionGraph.welcomeView`, `type:
"webview"`) is a `WebviewViewProvider` (`extension.ts`'s
`createLogSidebarProvider`) reusing the Show Log panel's own `log.js`/
`logPanel.html` — a "Show Revision Graph" button
(`command:revisionGraph.show`) plus a persistent commit-log view (see
"log sidebar" entry below), rather than a `viewsWelcome` button-only
fallback. (An even earlier iteration of this view really was a bare
`TreeDataProvider` returning `[]` specifically to trigger `viewsWelcome`
— replaced once a webview gave more room for the version-info footer,
then again by the current log sidebar.)

## Post-M4: localization (Japanese first)

First requested as "multi-language support, starting with Japanese", with
an explicit follow-up requirement: adding a new language later should
only mean dropping in resource files, no code changes. That shaped the
whole approach — everything routes through VS Code's own built-in
mechanisms rather than anything homegrown:

- **`package.json`'s own contributed strings** (command title,
  description, `viewsWelcome` contents) use VS Code's standard
  `package.nls.json` (default) / `package.nls.<lang>.json` (override)
  mechanism, referenced from the manifest as `%key%` placeholders, wired
  up via the top-level `"l10n": "./l10n"` field.
- **Extension host strings** (`extension.ts`, `gitActions.ts`) use the
  built-in `vscode.l10n.t()` API directly — no dependency needed, it's
  part of the `vscode` module itself in any reasonably recent VS Code.
  The source string doubles as the lookup key and the automatic fallback
  when no translation matches, so a *partial* translation file degrades
  gracefully (untranslated strings just show their original English)
  rather than erroring.
- **Webview strings are the harder case**: a webview is a separate,
  non-Node context with no access to `vscode.l10n` at all. Solved by
  using `@vscode/l10n` (MIT — the same underlying library `vscode.l10n`
  itself is built on, published standalone specifically for exactly this
  browser-side use case) inside each webview bundle
  (`src/webview/l10n.ts`), configured at startup with a bundle the
  extension host injects as `window.__L10N_BUNDLE__` (a new
  `__L10N_BUNDLE_JSON__` template placeholder, the same mechanism
  `__CSP__`/`__NONCE__`/`__SCRIPT_URI__` already used) — read from
  whichever `l10n/bundle.l10n.<lang>.json` matches `vscode.env.language`
  (falling back from e.g. `ja-JP` to `ja`, then to `{}` if there's no
  match for that language at all). One consequence: **the extension host
  and every webview end up sharing the exact same
  `l10n/bundle.l10n.ja.json`** — adding a language is one bundle file
  (plus one `package.nls.<lang>.json` for the manifest) covering
  everything, host and webview alike, matching the "just drop in a
  resource file" requirement exactly.
- **Static HTML text** (toolbar labels, table headers, dialog labels — as
  opposed to JS-generated status messages and context-menu items, which
  call `t(...)` directly) uses a `data-i18n="<source string>"` /
  `data-i18n-placeholder="<source string>"` attribute convention plus a
  generic `applyLocalization(root)` helper (also in `l10n.ts`) that walks
  every such element on startup and sets `textContent`/`placeholder`
  accordingly. A label wrapping both text and a real form control (e.g.
  `<label><input type="checkbox"/> Some text</label>`) needed its text
  wrapped in its own `<span data-i18n="...">` first — setting
  `textContent` directly on the `<label>` would have deleted the
  `<input>`.
- Deliberately **left untranslated**: pure git/technical terms
  (`HEAD`, `detached HEAD`) and any string that's 100% interpolated data
  plus universal punctuation with no literal words of its own (e.g.
  `"{0} ({1} ↔ {2})"`, the diff-editor tab title) — nothing to translate,
  and `t()` already returns those unchanged when no bundle entry exists
  for them.
- 133 keys total, covering the extension host, all four webview panels
  (main graph, "Changed Files", "Switch / Checkout", "Show Log"), and
  every `package.json`-contributed string. Verified with a throwaway script
  that every `t(...)` call site and `data-i18n(-placeholder)` attribute
  in the source has a matching bundle entry, and vice versa (no orphaned
  translations) — not kept in the repo, just a one-off sanity check.

## Post-M4: stop auto-focusing HEAD on every re-render

Originally *every* re-render — a filter/checkbox change, and especially
repo-watcher's automatic refresh on an external change (a checkout,
commit, or pull from outside the extension) — re-centered the viewport on
the current branch. Reported as the graph "jumping to the current branch
on its own": panning/zooming somewhere to look at something, then having
an unrelated external change yank the view back to HEAD without asking.

Narrowed to exactly two triggers, per request: the very first render, and
an explicit Refresh click. `main.ts` tracks this with a single module-level
`focusOnHeadForNextGraphData` flag — true initially, set true by the
Refresh button's own click handler (not shared with the other toolbar
controls' plain `applyFilter`), and read-then-reset-to-false by
`handleGraphData` on every `graphData` message it handles (both the
worker-success and main-thread-fallback paths count as the same trigger,
so the flag is captured once at the top of `handleGraphData`, not
re-read in each path). This works because the webview can't otherwise
tell *why* a given `graphData` message arrived — a `setFilter` response
and repo-watcher's unprompted push look identical on the wire, so the
"was this explicitly requested" state has to live client-side.

When the flag is false, `renderAndFocus` needs somewhere to put the
viewport instead of HEAD: `PanZoomController` gained `getView()`/
`setView(view)` (exact `{x, y, scale}`, no clamping/recentering) so the
outgoing controller's view can be captured just before it's destroyed and
handed straight to the replacement one, carrying the exact pan/zoom state
across a re-render's inherent "new SVG, new controller" reset.

## Post-M4: create branch/tag here

Also on request, growing the set of git operations available from the
graph. Right-clicking any node now offers **Create branch here…** and
**Create tag here…**.

- Unlike "Checkout" (a whole "Switch / Checkout" webview panel, because it
  has several combinable options — force/merge/track/submodule-update),
  these two have no such option set worth a panel: just a name, and for a
  tag an optional message. So the webview sends a bare
  `{ type: 'createBranch' | 'createTag', startPoint: commitId }` and
  `extension.ts` drives everything itself with native
  `vscode.window.showInputBox`/`showWarningMessage` dialogs — the same
  "no custom webview UI when a built-in picker already fits" call made for
  incremental checkout above.
- `gitActions.ts` gained `branchExists`/`tagExists` (`git show-ref
  --verify --quiet refs/heads|tags/<name>`) so the existing-name case can
  be checked *before* asking, rather than attempting the create and
  reacting to git's refusal — same reasoning as `isBranchMerged` for
  delete-branch: fold the warning into one confirmation instead of a
  failed attempt followed by a retry prompt. Confirmed, `createBranch`/
  `createTag` re-run with `-f`.
- For the tag's message prompt, `showInputBox` returns `undefined` only on
  Escape/cancel, but `''` for "submitted with nothing typed" — that's the
  signal used to tell "cancelled the whole flow" apart from "no message",
  which is deliberately a valid choice: it produces a lightweight tag
  (`git tag <name> <rev>`) instead of an annotated one
  (`git tag -a -m <message> <name> <rev>`), same distinction the real
  `git tag` CLI makes based on whether `-m`/`-a` was given.
- Creating a branch doesn't switch to it — right-clicking a specific
  historical commit to bookmark it with a branch is a distinct action
  from wanting to move HEAD there, and TortoiseGit's own "create branch"
  dialog treats switching as an opt-in checkbox rather than the default
  too. Modeled here as a follow-up `showInformationMessage` with a
  "Switch to `<name>`" action button after the branch is created,
  reusing the same plain `checkoutRef` call incremental checkout uses.

## Post-M4: switch layout engine from dagre to d3-dag

Reported as `Maximum call stack size exceeded` when opening the graph on a
very large real-world repository (tens of thousands of commits) with Scope:
All branches — both the Worker attempt and the existing main-thread fallback
(added for exactly this class of failure, see M1's "検証方法" in DESIGN.md)
failed. Confirmed the same repository renders fine in TortoiseGit itself and
in `rodriguesvali/git-revision-graph` — an unrelated VSCode extension that
happens to also be named "Git Revision Graph" (the name this project's own
README/CHANGELOG note was already taken, hence "VSCode Git Revision Graph").
That extension's README states it "intentionally loads a bounded
recent-commit window instead of unbounded full history" and uses `d3-dag`
(MIT) rather than `dagre` for layout — proof this was a solvable limitation
of the specific implementation, not an inherent ceiling.

Root cause: `dagre`'s ranking pass uses plain recursion whose depth tracks
the graph's longest chain. `dagReducer.ts`'s always-on elision only
collapses straight single-parent/single-child runs, so a repository with a
large number of genuine branch/merge points (not just a long straight
history) still produces a large, deep reduced graph — deep enough here to
overflow even the main thread's larger stack, not just the Worker's.

Replaced `dagre` with `d3-dag` (MIT) in `computeLayout.ts`, using
`layeringLongestPath` + `coordGreedy` rather than d3-dag's own
LP-solver-based defaults (`layeringSimplex`/`coordSimplex` — the library's
closest equivalent to dagre's network-simplex approach): both chosen
operators are simple, fast heuristics with no recursion whose depth tracks
the graph's shape, trading some layout tidiness (wider graphs, edges less
centered under their nodes) for guaranteed stack safety and speed.
Benchmarked directly (see `test/computeLayout.test.ts`, and the git history
for the throwaway stress-test scripts used to explore this) against three
synthetic shapes at 20,000 nodes: a linear chain (448ms) and a chain with
periodic merges (534ms) — both fast — but a wide single layer (many nodes
sharing a rank) was multiple seconds at just 5,000 nodes, scaling worse
than quadratically with `sugiyama()`'s *default* decross operator,
`decrossTwoLayer`.

That's not an edge case to write off: manually verifying the actual fix
against a real "Scope: All branches" repository (rather than only the
synthetic shapes above) reproduced the exact same symptom the dagre
migration was meant to fix — the UI stuck on "Computing layout…"
indefinitely, no error, so the main-thread fallback never even triggered
(it only fires on an explicit worker error, not on "still running"). A
repository with many active/long-lived branches genuinely does put a large
number of nodes in one rank, since `layeringLongestPath` (like dagre's
original ranking) puts every one of those branch tips the same distance
from the common history they all fork from. Switched `decross` to
`decrossDfs` (a single DFS pass, no per-layer crossing optimization) —
confirmed it handles the same 5,000-wide case in ~120ms, and re-verified
speed on the linear chain and chain-with-merges shapes plus a new
synthetic "10,000-commit trunk + 50 long-lived 500-commit branches" shape
meant to approximate a real large, actively-developed repository (all
comfortably under a second). `test/computeLayout.test.ts` has a dedicated
regression test for the wide-layer case with a tight-ish timeout, since
that's what would actually catch a regression back to the slow default.

`graphConnect()` (d3-dag's link-based graph builder) only learns about a
node from an edge referencing it, unlike dagre's `setNode`/`setEdge` split —
so a node with no in-graph parent that also isn't any other node's parent
(only possible for a single-commit repo, or an isolated node from a
scope/range filter) needs an explicit `.single(true)` self-link
(`[id, id]`) to be registered at all.

Also filed [#87](https://github.com/m-tmatma/vscode-git-revision-graph/issues/87)
before this fix landed, since bounded/windowed history loading (the other
half of what the competing extension does) is still worth doing
independently — it bounds the layout engine's input size regardless of
which library computes the layout, and is the more scalable long-term
answer for the pathological wide-graph shape above.

## Post-M4: `--sparse` was missing entirely — the real root cause of the layout slowness

Investigating why a real large repository's layout took ~2140s even after
the decrossDfs fix above (all three stages instrumented; `compute` alone —
the algorithm, isolated from worker/postMessage overhead — was the vast
majority of that time, not build or render) led to comparing node counts
against TortoiseGit on the same repository, both with "Show branches and
merges" checked. The user noticed noticeably more ref-less commits in this
extension's graph than TortoiseGit's.

Re-reading TortoiseGit's own source more carefully (confirming the exact
line already quoted in the "fixing a real-repo layout crash" entry above,
which had the right quote but missed its implication):
`LOG_INFO_SIMPILFY_BY_DECORATION | (m_bShowBranchingsMerges ? LOG_INFO_SPARSE : 0)`.
`LOG_INFO_SIMPILFY_BY_DECORATION` is **unconditional** — TortoiseGit always
applies `--simplify-by-decoration`; the checkbox only controls whether
`--sparse` is *additionally* applied on top of it (confirmed against
`Git.cpp`'s `GetLogCmd`: `LOG_INFO_ALL_BRANCH` → `--all`,
`LOG_INFO_LOCAL_BRANCHES` → `--branches`, matching this project's own
scope options 1:1).

This project's `buildLogArgs` instead treated the toggle as a plain on/off
switch for `--simplify-by-decoration` itself — so "checked" (the default)
sent *no* simplification flag at all, fetching git's full raw history.
That's a strictly larger, unpruned commit set than *either* of
TortoiseGit's two actual modes (`--simplify-by-decoration --sparse` when
checked, `--simplify-by-decoration` alone when unchecked) — explaining
both the extra ref-less noise the user noticed and, very plausibly, the
bulk of the ~2140s: `--simplify-by-decoration` prunes at the git level,
before any commit ever reaches dagReducer.ts, the layout engine, or
anything else this session's earlier instrumentation could see.

Fixed to match exactly: `buildLogArgs` now always pushes
`--simplify-by-decoration`, then `--sparse` only when the (renamed)
`ReduceOptions.sparse` is true. Renamed `simplifyByDecoration` → `sparse`
throughout (`ReduceOptions`, `buildLogArgs`, `fetchCommits`,
`currentReduceOptions`) since the old name no longer described what the
flag actually gates. Default stays checked (`sparse: true`) — matches
TortoiseGit's own default and this project's existing README wording,
neither of which needed to change; only the flag *composition* was wrong.

Confirmed against this project's own repo that both flags are valid
together (`git log --simplify-by-decoration --sparse --all`) and that
`--simplify-by-decoration` alone is dramatically more aggressive (182 → 15
commits here) — though `--sparse` mode showed the same 182 either way for
this small, mostly-linear repo, so the real reduction on the large
repository that motivated this fix is still unconfirmed pending the user's
next test.

## Post-M4: port dagre's Brandes-Köpf coordinate assignment as a custom d3-dag Coord

The `--sparse` fix above corrected the fetched history's size, but reported
layout `compute` time for the real repository was still ~610-2140s at just
10,560 nodes -- while every synthetic shape this session could construct
(up to 200,000 nodes, several shapes deliberately designed to stress
`coordGreedy`) finished in well under a second. Cloning TortoiseGit's own
source (`/home/tsuchiyama/tortoisegit`) to check its algorithm choices
directly (`RevisionGraphWnd.cpp`, `RevisionGraphDlgFunc.cpp`) confirmed it
uses `ogdf::OptimalRanking` + `ogdf::MedianHeuristic` + `ogdf::FastHierarchyLayout`
— arguably *more* sophisticated ranking/crossing-minimization than this
project's `layeringLongestPath`/`decrossDfs` — and still renders the same
real repository in ~3s, pointing squarely at d3-dag's *coordinate
assignment* step as the remaining outlier, not the choice of ranking/decross
heuristic.

Confirmed directly: swapping only `coord` from `coordGreedy` to `coordQuad`
on an otherwise-identical synthetic shape ran the process out of memory
(~4GB) before crashing. Different d3-dag coord operators have wildly
different scaling behavior for the same graph — not just a constant-factor
difference — which fits a graph shape none of this session's synthetic
attempts quite reproduced still being catastrophically slow specifically at
the coordinate-assignment step.

Considered reusing dagre's own coordinate assignment (Brandes & Köpf, "Fast
and Simple Horizontal Coordinate Assignment") directly, since dagre exists
purely as an MIT-licensed dependency at that point (its *ranking* step is
what forced the original move to d3-dag). Checked dagre's current source
(`lib/rank/feasible-tree.ts`, `lib/rank/util.ts`) and confirmed *every* one
of its ranking strategies -- including `ranker: 'longest-path'`, which
looked like an easy way to dodge the recursion without switching engines
entirely -- uses a recursive `dfs` whose depth tracks the graph's longest
chain. Re-adopting dagre wholesale (even with `ranker` overridden) wasn't
viable. dagre's `lib/position/bk.ts` (the BK implementation itself) is also
tightly coupled to dagre's own `Graph` class and its `normalize` step
(dummy-node insertion for edges spanning multiple ranks), so it isn't
directly reusable as a standalone function either.

The unlock: d3-dag's `Coord` operator interface is a supported, documented
extension point (`sugiyama().coord(customFn)`), and critically, d3-dag's
own pipeline *already* performs the dummy-node-expansion step internally
(`sugifyLayer`/`sugifyCompact`) before calling whichever `coord` operator is
configured -- handing it a ready-made `SugiNode<N,L>[][]` (a "sugi node" is
either a real node or a dummy standing in for one rank-segment of a
multi-rank edge) plus a `sep` function that already encodes node/gap
separation. That's functionally the exact representation dagre's own
`normalize` step builds for its `positionX` to consume, so dagre's BK
algorithm could be ported to work against d3-dag's `SugiNode` API instead
of dagre's own `Graph`, without needing to reimplement dummy-node insertion
or separation math at all.

`src/webview/coordBrandesKopf.ts`: ported from `@dagrejs/dagre`'s
`lib/position/bk.ts` (MIT, Copyright (c) 2012-2014 Chris Pettitt --
GPL-compatible per CLAUDE.md's license policy; the file carries the
attribution). Deliberately simplified relative to dagre's version:

- Uses d3-dag's provided `sep` function throughout instead of porting
  dagre's own separation math (which accounts for edge-label positions and
  compound-graph subgraph borders -- neither applies here).
- Only implements "type 1" conflicts (a non-inner segment crossing an inner
  segment). Dagre's "type 2" conflicts only matter for compound-graph
  subgraph border dummy nodes, a feature this project doesn't have — so
  they'd be checking for a case that can't occur. This is a real, minor
  quality tradeoff (very slightly more avoidable crossings among dummy-node
  chains in some rare layouts) with no effect on correctness or speed.
- `Map`/`Set` keyed on `SugiNode` object identity, rather than dagre's
  string ids + the `v > w` canonicalization dagre needed to keep a
  plain-object conflict map consistent.

Result, replacing only the `coord` operator (ranking/decross unchanged):
20,000-node linear chain and chain-with-merges shapes stayed in the low
hundreds of ms (as before); the previously-slow shapes dropped
dramatically -- the "trunk + 60 long-range branches" shape (4.4s with
`coordGreedy`) to ~300ms, and a synthetic shape matching the real
repository's exact reported stats (10,560 nodes, 16,791 edges, max 12
children on one node, max depth 328, max width 102) to ~400ms. Added a
dedicated regression test (`test/computeLayout.test.ts`) asserting no two
nodes in the same rank ever overlap horizontally -- the actual correctness
property Brandes-Köpf exists to guarantee, not just "did it crash or finish
in time" like the earlier tests.

Manual visual verification in a real Extension Development Host against
the actual repository that motivated this investigation is still needed —
none of this session's synthetic reproductions exactly matched its true
compute time, so the improvement is strong evidence, not final proof, until
confirmed there directly.

## Post-M4: the Activity Bar view becomes a persistent log sidebar

The Activity Bar's sole view (`revisionGraph.welcomeView`) used to be a
static screen: a "Show Revision Graph" button, a short description
paragraph, and the version/build-hash footer — otherwise permanently
empty, wasting the rest of the sidebar's vertical space. Requested
directly off a screenshot showing that empty area.

Rather than build a third, separate commit-list implementation, the
sidebar now reuses the Show Log panel's own webview bundle (`log.js`/
`logPanel.html`) wholesale: `welcomeView.ts`/`welcomeView.html` are gone,
and `logPanel.html` gained the old welcome screen's header button and
version-info footer around the existing commit list (flex column layout:
fixed-height header, flex-grow scrollable list, fixed-height footer).

Two behavioral pieces from the "always show something, and let 'Show
Log' retarget it" request:
- **Defaults to the current branch.** `extension.ts` keeps a
  module-level `logTarget = { startRef: 'HEAD', label: undefined }`;
  `logTarget.label` stays `undefined` for this default state so the
  view keeps VS Code's normal "Git Revision Graph" title instead of
  being permanently relabeled after the first resolve.
- **"Show Log" retargets the same view instead of opening a new editor
  tab.** The main graph's `showLog` handler updates `logTarget`, then
  either `logSidebarView.show(true)` + re-fetches (if the view is
  already resolved) or runs `revisionGraph.welcomeView.focus` — VS
  Code's own auto-generated command to reveal (and thereby resolve) a
  contributed view for the first time, which then picks up the
  already-updated `logTarget` on its own initial `ready` handshake.
  `showLogPanel`'s old `WebviewPanel`-per-request approach is gone
  entirely; the message-handling logic it used to own now lives in
  `wireLogWebview`, a plain function over a `vscode.Webview` (works
  the same whether that's a `WebviewPanel` or a `WebviewView`) so the
  sidebar isn't duplicating that wiring.
