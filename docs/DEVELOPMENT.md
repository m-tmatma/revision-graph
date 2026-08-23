# Development

Information for contributors working on this extension. For what it does
and how to use it, see [README.md](../README.md).

## Status

All planned milestones are implemented:

- Core display: fetch the commit history, collapse non-branching straight
  runs, lay out the DAG, render it as SVG (Milestone 1)
- Filtering (scope, straight-run collapsing, tag visibility), pan/zoom,
  node selection, tooltips, and the full context menu (checkout, copy
  hash, copy ref name(s), compare, delete ref) (Milestones 2 and 3)
- Automatic refresh when the repo changes outside the extension — a
  checkout, commit, or pull from a terminal or another tool — SVG/PNG
  export, and a minimap (Milestone 4)

See [DESIGN.md](DESIGN.md) for design details and [HANDOFF.md](HANDOFF.md)
for implementation notes.

## Build

```sh
npm install
npm run package
npm run vsix
```

This produces `vscode-git-revision-graph-<version>.vsix` in the project root.

## Development loop

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

## Adding a language

The UI follows VS Code's own display language setting automatically.
Adding a new language is just two resource files, no code changes:

- `package.nls.<lang>.json` for `package.json`'s own contributed strings
  (command name, description, ...)
- `l10n/bundle.l10n.<lang>.json` for everything else (shared by the
  extension host and every webview panel)

Any string missing from a translation file falls back to its original
English.

## License policy

GPLv2 — see [LICENSE](../LICENSE). See also [CLAUDE.md](../CLAUDE.md) for
this project's dependency license policy.

## Contributing

A few project conventions live in [CLAUDE.md](../CLAUDE.md) (originally
written as instructions for an AI coding assistant, but they apply to any
contributor) — worth reading before opening a PR:

- **Dependency licensing**: no GPL-incompatible dependency (see "License
  policy" above).
- **PR merges**: always a merge commit (`gh pr merge --merge`), never
  squash or rebase, so each feature's individual commits stay visible in
  `master`'s history.
- **Accessibility**: any PR that adds or changes a webview HTML file
  (`*.html` under `src/webview/`) needs a clean local `accesslint` scan
  first — CLAUDE.md has the exact command and the list of issues it tends
  to catch.
