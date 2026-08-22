// Thin bootstrap around @vscode/l10n for the webview side: the extension
// host's own `vscode.l10n` namespace isn't available here (a webview is a
// separate, non-Node context), so the host instead injects the resolved
// locale bundle's raw contents as `window.__L10N_BUNDLE__` (see
// extension.ts's getWebviewHtml/getSimplePanelHtml), and @vscode/l10n —
// the same underlying library `vscode.l10n` itself is built on — is
// configured with it here.
//
// Adding a new language: an `l10n/bundle.l10n.<lang>.json` file (shared by
// both the extension host and every webview) plus a
// `package.nls.<lang>.json` for package.json's own contributed strings —
// no code changes on either side.

import * as l10n from '@vscode/l10n';

declare global {
  interface Window {
    __L10N_BUNDLE__?: Record<string, string>;
  }
}

l10n.config({ contents: window.__L10N_BUNDLE__ ?? {} });

export const t = l10n.t;

/**
 * Localizes every static piece of markup in `root` (an HTML template's
 * fixed labels, button text, table headers, ...): `[data-i18n]`'s own
 * attribute value is the English source string, replaced as that
 * element's `textContent`; `[data-i18n-placeholder]` does the same for an
 * `<input>`'s `placeholder`. Dynamic, JS-generated text (status messages,
 * context-menu items, per-row table cells, ...) isn't covered here — each
 * of those call sites uses `t(...)` directly instead.
 */
export function applyLocalization(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder!);
  });
}
