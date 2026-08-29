// Watches the built-in vscode.git extension's Repository.state.onDidChange
// event for the given workspace root, so the revision graph refreshes
// itself automatically on external repo changes (a checkout done outside
// this extension, a commit, a pull, etc.) — not just after our own
// checkout/delete-ref actions, which already refresh explicitly on success.

import * as vscode from 'vscode';

interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    onDidChange: vscode.Event<void>;
  };
}

interface GitAPI {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
}

interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

// state.onDidChange fires for more than just ref/HEAD changes (e.g. working
// tree edits), and can fire several times in quick succession for a single
// user action (a checkout, a stage/unstage flurry). Coalesce into one
// refresh instead of re-running `git log` on every event.
const DEBOUNCE_MS = 500;

export function watchRepositoryChanges(cwd: string, onChange: () => void): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const debouncedOnChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(onChange, DEBOUNCE_MS);
  };

  const watchRepository = (repo: GitRepository) => {
    if (repo.rootUri.fsPath.toLowerCase() !== cwd.toLowerCase()) return;
    disposables.push(repo.state.onDidChange(debouncedOnChange));
  };

  void (async () => {
    try {
      const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
      if (!extension) return;
      const exports = extension.isActive ? extension.exports : await extension.activate();
      const git = exports.getAPI(1);

      // The returned Disposable can already have been disposed by the time
      // activation finishes (e.g. the panel closed while vscode.git was
      // still starting up) -- without this check, the subscriptions below
      // would be pushed into `disposables` after the dispose callback (see
      // below) already ran once against an empty array, leaking both
      // listeners for good since nothing calls dispose() on them again.
      if (disposed) return;

      // The matching repository may already be open, or may only appear
      // later (the git extension discovers repositories asynchronously).
      for (const repo of git.repositories) watchRepository(repo);
      disposables.push(git.onDidOpenRepository(watchRepository));
    } catch {
      // vscode.git failing to activate just means no auto-refresh on
      // external repo changes -- not fatal, and VS Code already surfaces
      // the underlying extension-activation failure on its own.
    }
  })();

  return new vscode.Disposable(() => {
    disposed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const disposable of disposables) disposable.dispose();
  });
}
