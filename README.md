# Git Revision Graph

A VSCode extension that visualizes a Git repository's commit DAG (branches,
merges, tags) as an SVG graph, inspired by [TortoiseGit](https://gitlab.com/tortoisegit/tortoisegit)'s
"Revision Graph" feature.

## Status

Early development. Milestone 1 ("core display") is implemented: fetch the
commit history, collapse non-branching straight runs, lay out the DAG, and
render it as SVG. Filtering, pan/zoom, node selection/comparison, and export
are planned but not yet built — see [docs/DESIGN.md](docs/DESIGN.md) for the
full roadmap.

## Installation

This extension isn't published to the Marketplace yet. Install it from a
`.vsix` file instead:

1. Get a `.vsix`:
   - Download the `vsix-build<N>` artifact from a [CI run](../../actions) on
     GitHub (it's a zip; unzip it to get the `.vsix` file), or
   - Build it yourself:
     ```sh
     npm install
     npm run package
     npm run vsix
     ```
     This produces `revision-graph-<version>.vsix` in the project root.
2. Install it — **don't double-click the file** (`.vsix` is also Visual
   Studio's extension package extension, so Windows may open it with the
   wrong application). Instead:
   - From the command line: `code --install-extension revision-graph-<version>.vsix`
   - Or in VSCode: Extensions view → `...` menu → "Install from VSIX..." →
     select the file

## Usage

1. Open a folder that's a Git repository.
2. Run the **"Show Revision Graph"** command from the Command Palette
   (`Ctrl+Shift+P` / `Cmd+Shift+P`), or click the branch icon in the Source
   Control view's title bar.
3. The commit graph opens in a new tab as an SVG.

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
