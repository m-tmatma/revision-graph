---
name: full-review-pr
description: Open a PR that diffs the entire current codebase against the repo's first commit, so an AI review bot (CodeRabbit, etc.) reviews everything at once instead of only recent PRs. Use when the user asks to "get CodeRabbit to review the whole codebase", "force a full review", or similar (see PR #122/#124 and #137/#139 in this repo's history for the precedent this codifies).
---

# Full-codebase review PR

A normal PR's diff is only what changed since it branched off `master`, so a
review bot never sees code that was merged before the bot was watching this
repo, or before this workflow existed. This skill opens a PR whose diff is
**the entire current codebase**, by making the PR's *base* branch the repo's
very first commit instead of `master`.

The PR's *head* is a real feature branch (branched from `master`), not
`master` itself — findings get fixed by pushing commits directly onto that
same branch, so CodeRabbit's own incremental review picks up each push
automatically, and the branch ends as a normal PR to merge (no separate
review-only PR to close, no separate fix-up PR either). Confirm with the
user before pushing/opening anything if they haven't already explicitly
asked for this in the current conversation.

## Steps

1. **Find the repo's first commit:**
   ```sh
   git rev-list --max-parents=0 HEAD
   ```
   If this prints more than one hash, the repo has multiple root commits
   (unusual) — ask the user which root to base off, don't guess.

2. **Create and push a branch at that commit.** Name it `chore/full-review-base`
   (or `chore/full-review-base-2` etc. if that name is already taken from a
   previous round) — whatever you pick, **reuse that exact same name in step
   4** rather than re-typing `chore/full-review-base` there, so a suffixed
   name doesn't silently make the PR target a stale review branch. This
   branch is pure scaffolding (a pointer at the first commit, so the PR's
   diff covers everything since) — nothing ever gets committed to it:
   ```sh
   BASE_BRANCH=chore/full-review-base   # bump the suffix here if already taken
   git checkout -b "$BASE_BRANCH" <first-commit-hash>
   git push -u origin "$BASE_BRANCH"
   ```

3. **Create and push a second branch off `master`** — this one is a normal
   feature/fix branch, per this repo's own branching convention, and is
   where every finding actually gets fixed:
   ```sh
   REVIEW_BRANCH=fix/coderabbit-full-review-findings   # bump the suffix if already taken
   git checkout -b "$REVIEW_BRANCH" master
   git push -u origin "$REVIEW_BRANCH"
   git checkout -   # back to whatever branch the user was previously on
   ```

4. **Open the PR with the direction reversed** — base = `$BASE_BRANCH`
   (from step 2), head = `$REVIEW_BRANCH` (from step 3) — so the diff is
   "everything added since the beginning of history", i.e. the whole
   codebase:
   ```sh
   gh pr create --base "$BASE_BRANCH" --head "$REVIEW_BRANCH" \
     --title "chore: full-codebase review for CodeRabbit"
   ```
   Follow this repo's own PR-title-prefix convention from `CLAUDE.md` if one
   exists (a `chore:` prefix is fine as a starting point; it doesn't have to
   match whatever the findings actually turn out to be, since step 8's fixes
   land as their own commits regardless).

5. **Wait for the review**, respecting the review bot's own rate limits —
   most (CodeRabbit included) allow roughly one full review per hour on
   free/standard plans. If a review doesn't start automatically (e.g. it
   only auto-reviews PRs targeting the repo's actual default branch, not an
   arbitrary base like `$BASE_BRANCH`), trigger one with a PR comment (e.g.
   `@coderabbitai review` for CodeRabbit) and use `ScheduleWakeup` to check
   back later rather than polling immediately or retriggering repeatedly.

6. **Collect every finding from *two* separate endpoints** — a finding
   "outside the diff range" only shows up in one of them, so checking just
   one silently misses findings:
   ```sh
   gh api repos/<owner>/<repo>/pulls/<N>/comments   # inline, in-diff comments
   gh api repos/<owner>/<repo>/pulls/<N>/reviews     # review body text, incl. "outside diff range" notes
   ```

7. **Triage findings on their merits before fixing anything** — don't
   blindly apply every suggestion. Verify each one against the actual
   current code/behavior (write a quick test or reproduce it manually where
   feasible) and skip/reject ones that don't hold up, with a documented
   reason. Reply to whichever findings have their own inline comment
   thread (most reviewers only expose *some* findings as separate,
   individually-repliable comments; a finding embedded only in the review
   body's own text has no thread to reply to).

8. **Fix real findings directly on `$REVIEW_BRANCH`** — one commit per
   distinct finding (per this repo's `CLAUDE.md` convention on splitting
   review fix-ups), pushed to that same branch rather than a separate
   branch/PR. Each push updates this same PR's diff, and CodeRabbit's own
   incremental review picks up just the new commits on its own (or via
   another `@coderabbitai review` comment, same rate-limit caveat as
   step 5) — repeat steps 5-8 for as many rounds as the reviewer keeps
   finding things.

9. **Merge `$REVIEW_BRANCH`'s PR normally** once its findings are
   addressed — this is a real PR now (not a throwaway), so it follows this
   repo's usual merge process (merge commit, not squash/rebase, per
   `CLAUDE.md`). `$BASE_BRANCH` (whatever name step 2 actually used) can be
   deleted at this point too (locally and on `origin`) — it has no further
   use once the PR is merged.
