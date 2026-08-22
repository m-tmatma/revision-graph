/// <reference lib="webworker" />
// Runs dagre layout inside a dedicated Web Worker, so layout computation
// never blocks the webview's render/interaction thread for typical repos.
// See computeLayout.ts for why main.ts also keeps a main-thread fallback for
// when this worker's smaller stack can't handle a very deep history.

import { computeLayout } from './computeLayout';
import type { GraphNode } from '../shared/types';

interface LayoutRequest {
  type: 'layout';
  nodes: GraphNode[];
}

self.addEventListener('message', (event: MessageEvent<LayoutRequest>) => {
  if (event.data?.type !== 'layout') return;

  try {
    const graph = computeLayout(event.data.nodes);
    (self as unknown as Worker).postMessage({ type: 'result', graph });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', message: String(err) });
  }
});
