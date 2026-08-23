# Changelog

All notable changes to the "Git Revision Graph" extension are documented
here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Added

- `scripts/install-remote-ssh.sh`, for installing onto a Remote-SSH (or
  Dev Containers/WSL) host from a shell — finds the running VS Code
  Server's own CLI shim under `~/.vscode-server` directly, rather than
  relying on `PATH`'s `code`, which isn't reliable in that context.
- Simplified Chinese localization.
- Spanish localization.
- Brazilian Portuguese localization.

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
