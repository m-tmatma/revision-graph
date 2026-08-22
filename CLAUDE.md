# revision-graph

## License policy

This project is licensed under GPLv2 (see [LICENSE](LICENSE)). Do not add a
dependency (runtime or otherwise redistributed) whose license is incompatible
with GPLv2 — check the FSF license-compatibility list
(https://www.gnu.org/licenses/license-list.html) before adding any new
third-party library. If a library's license is not GPL-compatible, prefer a
compatible alternative; if none exists and the library is still needed, keep
it as a clearly separate, unmodified vendored file (mere aggregation) rather
than bundling/merging it into GPLv2-licensed source, and document the
exception clearly.

## Accessibility

AccessLint runs on every PR and has flagged issues on webview HTML files
more than once. Before opening (or updating) a PR that adds or changes a
webview HTML file (`*.html` under `src/webview/`), run the same check
locally instead of waiting for CI to catch it:

```sh
npx -y @accesslint/cli scan src/webview/panel.html
npx -y @accesslint/cli scan src/webview/comparePanel.html
```

Fix everything it reports (exit code 0 = clean) before opening the PR. Add
a `scan` line for any new webview HTML file. Issues found this way so far,
as a reference for what tends to slip through:

- A page needs exactly one `<main>` landmark wrapping its primary content,
  and exactly one level-one heading (`<h1>`) — visually-hidden via a
  `.visually-hidden` class is fine if a visible heading doesn't fit the
  design. The heading must be *inside* the `<main>` landmark, not a
  sibling before it — `landmarks/region` still flags a heading that sits
  outside every landmark even if a `<main>` exists elsewhere on the page.
- Any `<table>` needs at least one `<td>` present in the static HTML, even
  if the real rows are rendered by JS after the page loads (e.g. a single
  placeholder/loading row) — static analysis only sees markup as shipped,
  not JS-rendered output.
