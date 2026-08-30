// Types shared between the extension host and the webview. Keep this file
// free of node/vscode/DOM specific APIs so it can be imported from either side.

export type RefType = 'head' | 'current-branch' | 'local-branch' | 'remote-branch' | 'tag' | 'stash' | 'other';

export interface RefInfo {
  name: string;
  type: RefType;
}

export interface GraphCommit {
  hash: string;
  /** Parent hashes, in the order reported by git (first parent first). */
  parents: string[];
  /** First line of the commit message. */
  subject: string;
  /** Full commit message (git's %B) — subject plus body, if any. */
  body: string;
  authorName: string;
  authorEmail: string;
  /** Unix time in seconds. */
  authorDate: number;
  refs: RefInfo[];
  /**
   * Whether this is the checked-out commit (HEAD, or the branch it points
   * to) -- computed from the *unfiltered* refs, independent of `refs`
   * itself possibly having its `current-branch`/`head` entry hidden by a
   * scope filter (see logReader.ts's filterRefsForScope), so scope-based
   * badge filtering can never break current-branch centering.
   */
  isCurrentBranch: boolean;
}

/** Options controlling which commits are included in the fetched log. */
export interface LogScopeOptions {
  scope: 'all-branches' | 'local-branches' | 'remote-branches' | 'current-branch' | 'range';
  /** Only used when scope === 'range'. Exclusive lower bound (git's `^from`). */
  fromRef?: string;
  /** Only used when scope === 'range'. Inclusive upper bound. */
  toRef?: string;
}

/**
 * Options controlling how much of the history is shown. `showAllTags`
 * governs dagReducer.ts's always-on straight-line elision (a tag alone
 * protects a commit from being elided only when this is true).
 * `sparse` is passed straight through to `git log` as `--sparse` on top of
 * an always-applied `--simplify-by-decoration` (see logReader.ts's
 * buildLogArgs — this exactly matches TortoiseGit's own "Show branches and
 * merges" toggle) — whether git itself skips over merges that
 * simplify-by-decoration would otherwise treat as pass-throughs, before
 * dagReducer.ts's own elision even runs.
 */
export interface ReduceOptions {
  showAllTags: boolean;
  sparse: boolean;
}

/** Message sent from the extension host to the webview. */
export type HostToWebviewMessage =
  | { type: 'graphData'; commits: GraphCommit[]; focusOnHead?: boolean }
  | { type: 'error'; message: string }
  | { type: 'commitTooltip'; commitId: string; text: string }
  | { type: 'commitTooltipError'; commitId: string; message: string };

/** Message sent from the webview back to the extension host. */
export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'setFilter'; scope: LogScopeOptions; reduce: ReduceOptions }
  | { type: 'compare'; from: string; to: string; fromLabel?: string; toLabel?: string }
  | { type: 'compareWithDefaultBranch'; to: string; toLabel?: string }
  | { type: 'compareWithCurrentBranch'; to: string; toLabel?: string; fromLabel?: string }
  | { type: 'copyCommitInfo'; commitId: string }
  | { type: 'requestCommitTooltip'; commitId: string }
  | { type: 'openCheckoutDialog'; ref: string; label: string; suggestedBranchName?: string }
  | { type: 'deleteRef'; refType: RefType; refName: string }
  | { type: 'renameRef'; refType: RefType; refName: string }
  | { type: 'deleteMergedBranches' }
  | { type: 'showLog'; commitId: string; label: string }
  | { type: 'createBranch'; startPoint: string }
  | { type: 'createTag'; startPoint: string }
  | { type: 'fetch' }
  | { type: 'exportSvg'; svg: string }
  | { type: 'exportPng'; dataUrl: string }
  | { type: 'incrementalCheckout' };

/** Node shape handed to the layout engine, after size measurement. */
export interface GraphNode {
  id: string;
  parents: string[];
  refs: RefInfo[];
  width: number;
  height: number;
  /** Carried through from GraphCommit -- see its doc comment. */
  isCurrentBranch: boolean;
}

export interface LaidOutNode extends GraphNode {
  x: number;
  y: number;
}

export interface LaidOutEdge {
  source: string;
  target: string;
  bendPoints: { x: number; y: number }[];
}

export interface LaidOutGraph {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

// --- Compare panel (a second, separate WebviewPanel opened from the main
// graph's "Compare" context-menu item) ---

export interface FileChange {
  path: string;
  status: 'added' | 'deleted' | 'modified' | 'other';
  /** Undefined for a binary file, which `git diff --numstat` reports as `-`. */
  added?: number;
  deleted?: number;
}

export interface CompareData {
  from: { hash: string; subject: string };
  to: { hash: string; subject: string };
  files: FileChange[];
}

export type CompareHostToWebviewMessage = { type: 'compareData'; data: CompareData };

export type CompareWebviewToHostMessage = { type: 'ready' } | { type: 'openFile'; path: string };

// --- Checkout target/options (used from the main graph's "Checkout"
// context-menu item -- resolved via a native QuickPick/InputBox flow in
// extension.ts rather than a webview, so no message protocol is needed) ---

export interface CheckoutTarget {
  /** Branch name, tag name, or commit hash — whatever `git checkout` should target. */
  ref: string;
  /** Human-readable label for the same target, e.g. "main" or "a1b2c3d (detached HEAD)". */
  label: string;
  /**
   * Pre-fill for "Create new branch" when checking out a remote-tracking
   * branch with no local branch of its own — the remote branch's name with
   * its `<remote>/` prefix stripped (e.g. "origin/foo" -> "foo").
   */
  suggestedBranchName?: string;
}

export interface CheckoutOptions {
  createBranch: boolean;
  newBranchName: string;
  /** Only meaningful together with createBranch. */
  track: boolean;
  /** Only meaningful together with createBranch: use `-B` instead of `-b`. */
  overwriteExisting: boolean;
  force: boolean;
  merge: boolean;
  /** Run `git submodule update --init --recursive` after a successful checkout. */
  updateSubmodules: boolean;
}

// --- Log sidebar (the Activity Bar container's sole view): a persistent
// scrollable list of a commit and its ancestors, with per-commit file
// changes shown on selection -- defaults to the current branch, and can be
// retargeted to any commit via the main graph's "Show Log" context-menu
// item. Also carries a "Show Revision Graph" button and the running
// version/build commit hash. ---

export interface LogEntry {
  hash: string;
  subject: string;
  authorName: string;
  /** Unix time in seconds. */
  authorDate: number;
  /** Parent hashes, in the order git reports them (first parent first). More than one means this is a merge commit. */
  parents: string[];
  refs: RefInfo[];
}

export interface LogPanelData {
  entries: LogEntry[];
}

export type LogHostToWebviewMessage =
  | { type: 'logData'; data: LogPanelData }
  | { type: 'logError'; message: string }
  | { type: 'diffData'; commitHash: string; files: FileChange[] }
  | { type: 'diffError'; commitHash: string; message: string }
  | { type: 'commitTooltip'; hash: string; text: string }
  | { type: 'commitTooltipError'; hash: string; message: string };

export type LogWebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'show' }
  | { type: 'showVersionInfo' }
  | { type: 'selectCommit'; hash: string }
  | { type: 'openFile'; commitHash: string; path: string }
  | { type: 'copyCommitInfo'; hash: string }
  | { type: 'requestCommitTooltip'; hash: string }
  | { type: 'openCheckoutDialog'; ref: string; label: string; suggestedBranchName?: string }
  | { type: 'createBranch'; startPoint: string }
  | { type: 'createTag'; startPoint: string }
  | { type: 'compareWithCurrentBranch'; to: string; toLabel?: string; fromLabel?: string }
  | { type: 'compare'; from: string; to: string; fromLabel?: string; toLabel?: string };
