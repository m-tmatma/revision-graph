// Resolves what a context-menu "Checkout" action should target for a given
// commit: its own local branch if it has one, the matching remote-tracking
// branch otherwise (suggesting a new local branch name), or the bare commit
// hash as a last resort (a detached-HEAD checkout). Returns null if the
// commit already IS the current branch -- nothing to check out. Shared by
// the main graph view and the Show Log panel, both of which offer this same
// "Checkout" item on a per-commit right-click menu.

import { t } from '../l10n';
import type { RefInfo } from '../../shared/types';

export interface CheckoutTarget {
  ref: string;
  label: string;
  suggestedBranchName?: string;
}

export function resolveCheckoutTarget(refs: RefInfo[], commitId: string): CheckoutTarget | null {
  if (refs.some((ref) => ref.type === 'current-branch')) return null;

  const localBranch = refs.find((ref) => ref.type === 'local-branch');
  if (localBranch) return { ref: localBranch.name, label: localBranch.name };

  const remoteBranch = refs.find((ref) => ref.type === 'remote-branch');
  if (remoteBranch) {
    // No local branch tracks this remote one yet -- checking it out means
    // creating a new local branch, so suggest a name (the remote branch's
    // own name with its "<remote>/" prefix stripped).
    return {
      ref: remoteBranch.name,
      label: remoteBranch.name,
      suggestedBranchName: remoteBranch.name.replace(/^[^/]+\//, ''),
    };
  }

  return { ref: commitId, label: t('{0} (detached HEAD)', commitId.slice(0, 7)) };
}

// Picks the most identifiable label for a commit: the branch/tag name it
// carries (preferring the current branch, then a local branch, then a tag,
// then a remote-tracking branch) over its bare hash. Shared by the main
// graph view (the "Show Log" panel's own title) and the Show Log panel
// (the "Compare with {0}" menu label for a two-commit selection).
export function refDisplayLabel(refs: RefInfo[], commitId: string): string {
  const preferred =
    refs.find((ref) => ref.type === 'current-branch') ??
    refs.find((ref) => ref.type === 'local-branch') ??
    refs.find((ref) => ref.type === 'tag') ??
    refs.find((ref) => ref.type === 'remote-branch');
  return preferred ? preferred.name : commitId.slice(0, 7);
}
