# Git Revision Graph

A VSCode extension that visualizes a Git repository's commit DAG (branches,
merges, tags) as an SVG graph, inspired by [TortoiseGit](https://gitlab.com/tortoisegit/tortoisegit)'s
"Revision Graph" feature.

## Status

Early development. Implemented so far:

- Core display: fetch the commit history, collapse non-branching straight
  runs, lay out the DAG, render it as SVG (Milestone 1)
- Filtering (scope, straight-run collapsing, tag visibility) and pan/zoom
  (Milestone 2, and part of Milestone 3)

Node selection/comparison, a right-click context menu (checkout, delete
ref, copy hash, compare), tooltips, a minimap, and export are planned but
not yet built — see [docs/DESIGN.md](docs/DESIGN.md) for the full roadmap.

## Installation

This extension isn't published to the Marketplace yet. Install it from a
`.vsix` file instead:

1. Get a `.vsix`: download the `vsix-build<N>` artifact from a
   [CI run](../../actions) on GitHub (it's a zip; unzip it to get the
   `.vsix` file), or build one yourself (see [Build](#build) below).
2. Install it — **don't double-click the file** (`.vsix` is also Visual
   Studio's extension package extension, so Windows may open it with the
   wrong application). Instead:
   - From the command line: `code --install-extension revision-graph-<version>.vsix`
   - Or in VSCode: Extensions view → `...` menu → "Install from VSIX..." →
     select the file

## Build

```sh
npm install
npm run package
npm run vsix
```

This produces `revision-graph-<version>.vsix` in the project root.

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
