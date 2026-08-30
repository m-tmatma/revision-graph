---
name: full-review-pr
description: Open a review-only PR that diffs the entire current codebase against the repo's first commit, so an AI review bot (CodeRabbit, etc.) reviews everything at once instead of only recent PRs. Use when the user asks to "get CodeRabbit to review the whole codebase", "force a full review", or similar (see PR #122/#124 in this repo's history for the precedent this codifies).
---

# Full-codebase review PR

A normal PR's diff is only what changed since it branched off `master`, so a
review bot never sees code that was merged before the bot was watching this
repo, or before this workflow existed. This skill opens a PR whose diff is
**the entire current codebase**, by making the PR's *base* branch the repo's
very first commit instead of `master`.

This PR is **never meant to be merged** — it exists only to get a review, then
gets closed. Confirm with the user before pushing/opening anything if they
haven't already explicitly asked for this in the current conversation.

## Steps

1. **Find the repo's first commit:**
   ```sh
   git rev-list --max-parents=0 HEAD
   ```
   If this prints more than one hash, the repo has multiple root commits
   (unusual) — ask the user which root to base off, don't guess.

2. **Create and push a branch at that commit.** Name it something like
   `chore/full-review-base` (or `chore/full-review-base-2` etc. if that name
   is already taken from a previous round):
   ```sh
   git checkout -b chore/full-review-base <first-commit-hash>
   git push -u origin chore/full-review-base
   ```
   Then return to whatever branch the user was previously on
   (`git checkout -`), since this base branch has no other purpose.

3. **Open the PR with the direction reversed** — base = the new
   first-commit branch, head = `master` (or the repo's actual default
   branch) — so the diff is "everything added since the beginning of
   history", i.e. the whole codebase:
   ```sh
   gh pr create --base chore/full-review-base --head master \
     --title "chore: full-codebase review base for CodeRabbit" \
     --body "Review-only PR to get a full-codebase review — not meant to be merged. Will be closed once the review is complete."
   ```
   Follow this repo's own PR-title-prefix convention from `CLAUDE.md` if one
   exists (a `chore:` prefix is usually right for this, since it's tooling/
   process, not a user-facing change).

4. **Wait for the review**, respecting the review bot's own rate limits —
   most (CodeRabbit included) allow roughly one full review per hour on
   free/standard plans. If a review doesn't start automatically, trigger one
   with a PR comment (e.g. `@coderabbitai review` for CodeRabbit) and use
   `ScheduleWakeup` to check back later rather than polling immediately or
   retriggering repeatedly.

5. **Collect every finding from *two* separate endpoints** — a finding
   "outside the diff range" only shows up in one of them, so checking just
   one silently misses findings:
   ```sh
   gh api repos/<owner>/<repo>/pulls/<N>/comments   # inline, in-diff comments
   gh api repos/<owner>/<repo>/pulls/<N>/reviews     # review body text, incl. "outside diff range" notes
   ```

6. **Triage findings on their merits before fixing anything** — don't
   blindly apply every suggestion. Verify each one against the actual
   current code/behavior (write a quick test or reproduce it manually where
   feasible) and skip/reject ones that don't hold up, with a documented
   reason.

7. **Fix real findings as normal feature/fix branches+PRs** — one commit
   per distinct finding (per this repo's `CLAUDE.md` convention on splitting
   review fix-ups), not bundled into one giant commit, and not on the
   review-only branch itself.

8. **Close the review-only PR without merging** once its findings are
   captured — merging it would be a no-op at best (head is already
   `master`) and confusing at worst:
   ```sh
   gh pr close <N> --comment "Full-codebase review captured; closing without merging."
   ```
   The `chore/full-review-base` branch can be deleted at this point too
   (locally and on `origin`) — it has no further use once the PR is closed.
