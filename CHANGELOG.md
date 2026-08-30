# Changelog

All notable changes to the "Git Revision Graph" extension are documented
here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Changed

- Log sidebar: the first (topmost) commit is no longer auto-expanded on
  load — every commit starts collapsed until clicked.
- Log sidebar: the per-commit lane graph's branch lines are now spaced
  more tightly, leaving more room for the commit text when history is
  deeply branched.

### Removed

- The hover tooltip showing commit info (main graph and log sidebar),
  since it got in the way while interacting with commits — use the
  "Copy commit info" context-menu item instead.

## 0.11.0

### Added

- Log sidebar: a "Checkout" item in the per-commit context menu
  (targeting the commit's own branch when it has one, rather than
  always a detached-HEAD checkout), and color-coded branch/tag badges
  on any commit a ref points to.
- Log sidebar: "Create branch here…" / "Create tag here…" items in
  the per-commit context menu.
- Log sidebar: a "Compare with current branch" item in the
  per-commit context menu, opening the Compare (Changed Files) panel
  against HEAD.
- Log sidebar: Ctrl/Cmd+click two commits (or use the "Select for
  Compare" context-menu item, including Ctrl/Cmd+right-click as a
  shortcut that pairs with whatever's currently expanded) to diff them
  directly against each other, same as the main graph view's own
  two-node selection.
- A "Remote branches" option in the toolbar's scope filter, showing
  only commits reachable from remote-tracking refs.
- The Activity Bar container now shows a persistent commit-log sidebar
  (defaulting to the current branch) instead of a mostly-empty welcome
  view — retarget it to any commit via the main graph's "Show Log"
  context-menu item, jump to the full graph with its "Show Revision
  Graph" button, and check the running build via its "ℹ" version-info
  button (shown in a copyable notification).
- Hovering a commit (in the main graph or the log sidebar) now shows a
  tooltip with the same text as **Copy commit info** (`git show -s`'s
  output: hash, ref decorations, author, date, and full message),
  after a short delay.

### Changed

- The "Changed Files" panel's own editor tab title now shows the two
  compared revisions — a branch or tag name when either side has one
  (e.g. "main ↔ v1.2.0"), otherwise a short hash (e.g. "54e873f ↔
  5a427b9") — instead of a fixed "Changed Files" label, so multiple
  Compare tabs open at once are distinguishable from each other.
  "Compare with current branch" shows the current branch's own name
  here too (e.g. "main ↔ v1.2.0") rather than the literal "HEAD" —
  or, with a detached HEAD, the checked-out commit's own short hash.
- The sidebar's commit log now refreshes automatically after a
  checkout, branch/tag creation, or merged-branch deletion — whether
  triggered from the main graph, the sidebar itself, or externally —
  as long as it's still showing the default current-branch view.
- With scope set to "Local branches" or "Remote branches", a commit's
  ref badges now only show branches of the matching kind (tags still
  always show) — previously a commit could show a local-branch chip
  while scoped to "Remote branches" (or vice versa) if it happened to
  also be the other kind's tip.
- The "Checkout" dialog is now a native VS Code QuickPick instead of a
  webview panel — it no longer eats up half the window's width as an
  editor column just to show a small options form, and creating a
  branch is a single screen (type the name, then pick any options)
  instead of a separate follow-up step.

### Fixed

- Log sidebar: right-clicking a commit now shows a menu with actions
  relevant to that commit (**Copy full hash**, **Copy commit info**)
  instead of the webview's native Cut/Copy/Paste edit menu.
- Copying a commit's ref name(s) or commit info to the clipboard (main
  graph and log sidebar) now ends with a trailing newline, so pasting
  it elsewhere leaves the cursor on a fresh line. **Copy full hash**
  now omits the trailing newline, matching how other tools copy a bare
  hash.
- Log sidebar: right-clicking a file in a commit's changed-files list
  now shows a menu with a **Copy path** action instead of the webview's
  native Cut/Copy/Paste edit menu.
- Compare (Changed Files) panel: right-clicking a file row now shows the
  same **Copy path** menu instead of the webview's native Cut/Copy/Paste
  edit menu.
- The "Checkout…" branch picker now reports an error instead of doing
  nothing when listing branches fails.
- The "Compare" panel's per-file diff now opens correctly for a
  revision containing a "/" (e.g. `origin/main`), instead of silently
  reading the wrong revision or failing.
- File paths containing non-ASCII characters (e.g. Japanese filenames)
  in the "Compare" panel and the log sidebar's changed-files list now show
  and copy correctly, instead of git's escaped/quoted form.
- A commit's `origin/HEAD` no longer shows as a redundant extra chip
  alongside its real default branch (e.g. `origin/main`) in the main
  graph and log sidebar.
- Compare (Changed Files) panel: file rows are now keyboard-operable
  (Tab to focus, Enter/Space to open), not just clickable with a mouse.
- Rapid filter/checkbox changes in the main graph could occasionally
  render an older, already-superseded layout over a newer one; the
  main graph now always shows the most recent request's result.
- Ref-type badge text color (main graph nodes and the log sidebar's
  per-commit badges) now picks black or white by actual contrast against the
  badge's background, rather than a luminance cutoff that picked the
  lower-contrast option for a few colors (e.g. the local-branch green).
- The main graph's viewport now stays in sync when its panel is
  resized, instead of keeping the old pan/zoom dimensions until the
  next pan, zoom, or refresh.
- Changing the scope filter (e.g. "Local branches" to "All branches")
  now re-centers the viewport on the current branch, instead of
  keeping the old pan/zoom position — which could leave the current
  branch's node far off-screen, or even show an apparently-blank graph.
- With scope set to "Remote branches", the checked-out branch's own
  local-branch chip no longer leaks through — the scope filter was
  excluding `local-branch`-typed refs but not the separate
  `current-branch` type used for whichever branch is checked out.
- With scope set to "Remote branches", a detached-HEAD commit's "HEAD"
  chip no longer leaks through either — same gap as the `current-branch`
  fix above, but for the separate `head` ref type used when there's no
  checked-out branch to attribute it to.
- A detached-HEAD commit's chip now reads "HEAD (detached)" instead of
  a bare "HEAD" — rendered as an ordinary chip in the same red as a
  real current-branch chip, plain "HEAD" could read as an actual branch
  name at a glance.

## 0.10.0

### Added

- A "Show Log" item in the commit context menu, opening a panel that
  lists a commit and its ancestors with a per-commit git-graph (merges
  and branch topology drawn as lanes) and lets you expand any commit
  inline to see and diff its changed files.

## 0.9.0

### Added

- A "Delete Merged Branches…" button in the graph's toolbar, listing
  local branches already merged into the current branch and letting you
  pick which ones to delete.

## 0.8.0

### Changed

- "Show all tags" now defaults to on.

## 0.7.0

### Added

- A "Fetch" button in the graph's toolbar, running `git fetch --all
  --prune` (updates every remote's tracking branches and removes local
  remote-tracking refs for branches deleted upstream), then refreshing
  the graph.

## 0.6.0

### Fixed

- The graph could fail to open on very large repositories with
  `Maximum call stack size exceeded`. Replaced the layout engine (dagre →
  d3-dag) to fix it.
- The graph could also take an extremely long time to open on very large,
  branchy repositories even after the fix above. Fixed by using a
  faster coordinate-assignment algorithm (Brandes-Köpf, ported from dagre —
  the same class of algorithm TortoiseGit itself uses for this step).

## 0.5.0

### Added

- `scripts/install-remote-ssh.sh`, for installing onto a Remote-SSH (or
  Dev Containers/WSL) host from a shell — finds the running VS Code
  Server's own CLI shim under `~/.vscode-server` directly, rather than
  relying on `PATH`'s `code`, which isn't reliable in that context.
- Simplified Chinese localization.
- Spanish localization.
- Brazilian Portuguese localization.
- Russian localization.
- Korean localization.
- French localization.
- German localization.
- Traditional Chinese localization.

## 0.4.0

### Added

- Right-click context menu: **Copy commit info**, copying the same text
  `git show -s` would print for that commit (hash and ref decorations,
  author, date, and full message).

### Fixed

- The SCM title bar button's icon no longer looks inconsistent with the
  Activity Bar container's icon — both now use the same custom diamond
  design instead of the built-in `$(git-branch)` codicon.

## 0.3.0

### Added

- Right-click context menu: **Rename** for a local branch's ref chip,
  prompting for a new name (warning first if a branch with that name
  already exists). Offered on the current branch too, since git doesn't
  refuse to rename the branch you're on.
- Right-click context menu: **Compare with current branch**, opening the
  "Changed Files" panel against whatever's currently checked out (`HEAD`)
  — a counterpart to the existing **Compare with default branch**.

## 0.2.0

### Added

- Right-click context menu: **Create branch here…** and **Create tag here…**,
  creating a local branch or a lightweight/annotated tag (message input left
  empty) at the clicked commit. Warns before overwriting an existing branch
  or tag with the same name; creating a branch offers a follow-up "Switch to"
  action rather than checking it out automatically.

## 0.1.0

Initial feature set.

### Added

- Visualize a repository's commit history as an interactive SVG graph —
  branches, merges, and tags — inspired by TortoiseGit's Revision Graph.
- Filtering by scope (all branches / local branches / current branch /
  a From..To range), with straight-line commit runs collapsed by default
  ("Show branches and merges" toggle controls whether git prunes merges
  unreachable from any ref, matching TortoiseGit's own default).
- Pan, zoom, and a minimap for navigating large graphs.
- Node tooltips (full hash, author, date, commit message) and a
  right-click context menu: checkout, copy ref name(s)/full hash,
  compare two selected commits or against the repo's default branch,
  and delete a local branch (matches TortoiseGit's own handling of an
  unmerged branch — warns, then force-deletes on confirmation).
- A "Switch / Checkout" panel (create branch, track, force, merge,
  update submodules) and a separate toolbar **Checkout…** picker for a
  fast plain checkout.
- A "Changed Files" comparison panel with per-file added/deleted line
  counts, opening the native VS Code diff editor per file.
- Export the graph as SVG or PNG.
- Automatic refresh when the repository changes outside the extension
  (a checkout, commit, or pull from a terminal or another tool).
- An Activity Bar entry point alongside the existing Command Palette
  command and Source Control title-bar button.
- Localization support, with Japanese included — adding another
  language only requires new resource files, no code changes.
