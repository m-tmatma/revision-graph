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
}

/** Options controlling which commits are included in the fetched log. */
export interface LogScopeOptions {
  scope: 'all-branches' | 'local-branches' | 'current-branch' | 'range';
  /** Only used when scope === 'range'. Exclusive lower bound (git's `^from`). */
  fromRef?: string;
  /** Only used when scope === 'range'. Inclusive upper bound. */
  toRef?: string;
}

/** Options controlling the straight-line elision pass. */
export interface ReduceOptions {
  showAllTags: boolean;
  collapseStraightRuns: boolean;
}

/** Message sent from the extension host to the webview. */
export type HostToWebviewMessage =
  | { type: 'graphData'; commits: GraphCommit[] }
  | { type: 'error'; message: string };

/** Message sent from the webview back to the extension host. */
export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'setFilter'; scope: LogScopeOptions; reduce: ReduceOptions }
  | { type: 'compare'; from: string; to: string }
  | { type: 'openCheckoutDialog'; ref: string; label: string; suggestedBranchName?: string }
  | { type: 'deleteRef'; refType: RefType; refName: string }
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
  /** Carried through from GraphCommit for the hover tooltip. */
  body: string;
  authorName: string;
  authorEmail: string;
  /** Unix time in seconds. */
  authorDate: number;
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

// --- Checkout dialog (a third, separate WebviewPanel opened from the main
// graph's "Checkout" context-menu item) ---

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

export type CheckoutHostToWebviewMessage = { type: 'checkoutTarget'; target: CheckoutTarget };

export type CheckoutWebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'submit'; options: CheckoutOptions }
  | { type: 'cancel' };
