# vscode-git-revision-graph

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

## Pull request merges

When merging a PR (`gh pr merge`), always use a merge commit
(`--merge`), never squash (`--squash`) or rebase (`--rebase`) — this
keeps each feature's individual commits visible in `master`'s history
instead of collapsing them into one.

## Committing

Never commit directly to `master`. Always create a feature/chore branch
first (`git checkout -b <type>/<name>`), commit there, push it, and open
a PR — even for a small or docs-only change.

Don't run `git commit` (or push, or open/update a PR) for a code change
until the user has manually verified it works — running `npm run
typecheck`/`test`/`build` successfully is not the same as the feature
actually working (a webview change also needs an Extension Development
Host reload to take effect, which build success doesn't imply). After
implementing and verifying the build, describe what changed and wait for
the user to confirm before committing — including a small fix-up commit
on an already-open PR's branch.

## Language

Write commit messages, PR titles/descriptions, and PR/issue comments in
English, even when the conversation with the user is in another language —
this repo's history and its GitHub-facing text should stay consistent for
any future contributor or reader, regardless of what language a given
session was conducted in.

## Accessibility

AccessLint runs on every PR and has flagged issues on webview HTML files
more than once. Before opening (or updating) a PR that adds or changes a
webview HTML file (`*.html` under `src/webview/`), run the same check
locally instead of waiting for CI to catch it. `accesslint scan` only
takes one file at a time and silently ignores extra positional args, so
don't pass a glob (`scan src/webview/*.html`) or `find -exec {} +` —
either one scans only the first match and skips the rest without
erroring. Use `-exec ... {} \;` instead, one invocation per file, with
each file's name echoed first so a violation can be attributed back to
its file:

```sh
find src/webview -name '*.html' -exec sh -c 'echo "== $1 =="; npx -y @accesslint/cli scan "$1"' _ {} \;
```

This automatically covers any new webview HTML file dropped into
`src/webview/` — no need to update this list when one is added. Fix
everything it reports (each file's block should end with "No
accessibility violations found.") before opening the PR. Issues found
this way so far, as a reference for what tends to slip through:

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
