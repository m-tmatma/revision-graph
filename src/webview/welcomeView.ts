// Webview entry point for the Activity Bar's welcome view: a "Show Revision
// Graph" button plus the running extension's version and build commit hash,
// shown so a stale Extension Development Host or installed build is easy to
// spot at a glance rather than mistaken for a code bug (see docs/HANDOFF.md).
// The version/commit text itself is resolved host-side and baked into the
// HTML template (see extension.ts's getWelcomeViewHtml) — this script only
// wires up the two buttons.

import type { WelcomeWebviewToHostMessage } from '../shared/types';
import { applyLocalization, t } from './l10n';

declare function acquireVsCodeApi(): { postMessage(message: WelcomeWebviewToHostMessage): void };

const vscode = acquireVsCodeApi();
applyLocalization(document);

const showButton = document.getElementById('show-button') as HTMLButtonElement | null;
const copyButton = document.getElementById('copy-button') as HTMLButtonElement | null;
const versionTextEl = document.getElementById('version-text');

if (!showButton || !copyButton || !versionTextEl) {
  throw new Error(t('Git Revision Graph: welcome view markup is missing expected elements'));
}

showButton.addEventListener('click', () => {
  const message: WelcomeWebviewToHostMessage = { type: 'show' };
  vscode.postMessage(message);
});

let copyFeedbackTimeout: ReturnType<typeof setTimeout> | undefined;
copyButton.addEventListener('click', () => {
  void navigator.clipboard.writeText(versionTextEl.textContent ?? '').then(() => {
    copyButton.textContent = t('Copied');
    clearTimeout(copyFeedbackTimeout);
    copyFeedbackTimeout = setTimeout(() => {
      copyButton.textContent = t('Copy version info');
    }, 1500);
  });
});
