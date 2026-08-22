# Git Revision Graph

A VSCode extension that visualizes a Git repository's commit DAG (branches,
merges, tags) as an SVG graph, inspired by [TortoiseGit](https://gitlab.com/tortoisegit/tortoisegit)'s
"Revision Graph" feature.

## Status

Early development. Implemented so far:

- Core display: fetch the commit history, collapse non-branching straight
  runs, lay out the DAG, render it as SVG (Milestone 1)
- Filtering (scope, straight-run collapsing, tag visibility), pan/zoom,
  node selection, tooltips, and the full context menu (checkout, copy
  hash, copy ref name(s), compare, delete ref) (Milestones 2 and 3)

A minimap and SVG/PNG export are planned but not yet built — see
[docs/DESIGN.md](docs/DESIGN.md) for the full roadmap.

## Installation

This extension isn't published to the Marketplace yet. Install it from a
`.vsix` file instead:

1. Get a `.vsix`: download the `vsix-build<N>` artifact from a
   [CI run](../../actions) on GitHub (it's a zip; unzip it to get the
   `.vsix` file), or build one yourself (see [Build](#build) below).
2. Install it — **don't double-click the file** (`.vsix` is also Visual
   Studio's extension package extension, so Windows may open it with the
   wrong application). Instead:
   - From the command line: `code --install-extension vscode-git-revision-graph-<version>.vsix`
   - Or in VSCode: Extensions view → `...` menu → "Install from VSIX..." →
     select the file

## Build

```sh
npm install
npm run package
npm run vsix
```

This produces `vscode-git-revision-graph-<version>.vsix` in the project root.

## Usage

1. Open a folder that's a Git repository.
2. Run the **"Show Revision Graph"** command from the Command Palette
   (`Ctrl+Shift+P` / `Cmd+Shift+P`), or click the branch icon in the Source
   Control view's title bar.
3. The commit graph opens in a new tab as an SVG, scrolled/zoomed to the
   current branch (shown in red — the checked-out branch itself, not a
   separate "HEAD" label).

**Toolbar**, along the top of the panel:

- **Scope**: All branches / Local branches / Current branch / From..To
  range. For a range, leave **To** blank for `HEAD`, and **From** blank to
  go from the very start of history.
- **Collapse straight runs**: hides commits that are neither a branch/merge
  point nor referenced by any branch/tag (on by default).
- **Show all tags**: when off, a tag alone doesn't stop a commit from being
  collapsed by the toggle above; when on, every tagged commit is kept.
- **Refresh**: re-applies the current settings (mainly useful after typing
  into From/To, which otherwise apply on blur/Enter).

**Navigating the graph**:

- Drag to pan.
- Mouse wheel to pan, Ctrl (Cmd on macOS) + wheel to zoom, centered on the
  cursor.
- Hover a node for its full hash, author, date, and commit message.
- Click a node to select it; Ctrl (Cmd on macOS) + click a second node to
  select it too.
- Right-click a node for:
  - **Checkout** (unless it's already the current branch) — opens a
    "Switch / Checkout" panel (target branch/tag/commit is fixed to
    whatever you clicked; create a new branch, track, force, merge local
    changes, or update submodules, TortoiseGit-style).
  - **Copy ref name(s)**, if it has any refs (every ref on the node, as
    full `refs/heads/...` paths, one per line).
  - **Copy full hash**.
  - With two nodes selected, right-clicking either of them also offers
    **Compare**, which opens a "Changed Files" panel (added/deleted line
    counts per file); click a file there to view its diff in VSCode's
    native diff editor.
  - Right-click a *specific ref chip* (not just anywhere on the node) for
    **Delete** — asks for confirmation first. Deleting a remote-tracking
    branch (e.g. `origin/foo`) only removes the local tracking ref; it
    does not touch the actual branch on the remote server.

## Development

```sh
npm install
npm run watch   # esbuild in watch mode
```

Press `F5` in VSCode to launch an Extension Development Host window with the
extension loaded (this runs the `watch` task first, via `.vscode/tasks.json`).

Other useful scripts:

```sh
npm run typecheck
npm test
npm run build     # one-off build (non-watch)
```

## License

GPLv2 — see [LICENSE](LICENSE). See also [CLAUDE.md](CLAUDE.md) for this
project's dependency license policy.
