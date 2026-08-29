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
