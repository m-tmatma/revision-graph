// Webview entry point for the "Switch / Checkout" dialog panel: shows the
// (already-determined, from the right-clicked node) checkout target and a
// TortoiseGit-style options form, and posts back either `submit` (with the
// chosen options) or `cancel`.

import type { CheckoutHostToWebviewMessage, CheckoutOptions, CheckoutWebviewToHostMessage } from '../shared/types';
import { applyLocalization, t } from './l10n';

declare function acquireVsCodeApi(): { postMessage(message: CheckoutWebviewToHostMessage): void };

const vscode = acquireVsCodeApi();
applyLocalization(document);

const targetLabelEl = document.getElementById('target-label');
const createBranchEl = document.getElementById('create-branch') as HTMLInputElement | null;
const newBranchNameEl = document.getElementById('new-branch-name') as HTMLInputElement | null;
const trackEl = document.getElementById('track') as HTMLInputElement | null;
const overwriteExistingEl = document.getElementById('overwrite-existing') as HTMLInputElement | null;
const forceEl = document.getElementById('force') as HTMLInputElement | null;
const mergeEl = document.getElementById('merge') as HTMLInputElement | null;
const updateSubmodulesEl = document.getElementById('update-submodules') as HTMLInputElement | null;
const okButton = document.getElementById('ok-button') as HTMLButtonElement | null;
const cancelButton = document.getElementById('cancel-button') as HTMLButtonElement | null;

if (
  !targetLabelEl ||
  !createBranchEl ||
  !newBranchNameEl ||
  !trackEl ||
  !overwriteExistingEl ||
  !forceEl ||
  !mergeEl ||
  !updateSubmodulesEl ||
  !okButton ||
  !cancelButton
) {
  throw new Error(t('Git Revision Graph: checkout dialog markup is missing expected elements'));
}

function updateEnabledState(): void {
  const creating = createBranchEl!.checked;
  newBranchNameEl!.disabled = !creating;
  trackEl!.disabled = !creating;
  overwriteExistingEl!.disabled = !creating;
}
createBranchEl.addEventListener('change', updateEnabledState);
updateEnabledState();

okButton.addEventListener('click', () => {
  const options: CheckoutOptions = {
    createBranch: createBranchEl.checked,
    newBranchName: newBranchNameEl.value.trim(),
    track: trackEl.checked,
    overwriteExisting: overwriteExistingEl.checked,
    force: forceEl.checked,
    merge: mergeEl.checked,
    updateSubmodules: updateSubmodulesEl.checked,
  };

  if (options.createBranch && !options.newBranchName) {
    newBranchNameEl.focus();
    return;
  }

  const message: CheckoutWebviewToHostMessage = { type: 'submit', options };
  vscode.postMessage(message);
});

cancelButton.addEventListener('click', () => {
  const message: CheckoutWebviewToHostMessage = { type: 'cancel' };
  vscode.postMessage(message);
});

window.addEventListener('message', (event: MessageEvent<CheckoutHostToWebviewMessage>) => {
  if (event.data.type === 'checkoutTarget') {
    const { target } = event.data;
    targetLabelEl.textContent = target.label;

    // Checking out a remote-tracking branch with no local branch of its
    // own implies creating one — pre-fill and default to that, same as
    // `git checkout <remote-branch>` would offer.
    if (target.suggestedBranchName) {
      newBranchNameEl.value = target.suggestedBranchName;
      createBranchEl.checked = true;
      trackEl.checked = true;
      updateEnabledState();
    }
  }
});

vscode.postMessage({ type: 'ready' });
