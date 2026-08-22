// Types shared between the extension host and the webview. Keep this file
// free of node/vscode/DOM specific APIs so it can be imported from either side.

export type RefType = 'head' | 'local-branch' | 'remote-branch' | 'tag' | 'stash' | 'other';

export interface RefInfo {
  name: string;
  type: RefType;
}

export interface GraphCommit {
  hash: string;
  /** Parent hashes, in the order reported by git (first parent first). */
  parents: string[];
  subject: string;
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
export type HostToWebviewMessage = { type: 'graphData'; commits: GraphCommit[] };

/** Message sent from the webview back to the extension host. */
export type WebviewToHostMessage = { type: 'ready' } | { type: 'error'; message: string };

/** Node shape handed to the layout engine, after size measurement. */
export interface GraphNode {
  id: string;
  parents: string[];
  refs: RefInfo[];
  width: number;
  height: number;
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
