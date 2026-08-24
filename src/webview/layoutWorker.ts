/// <reference lib="webworker" />
// Runs the layout engine inside a dedicated Web Worker, so layout
// computation never blocks the webview's render/interaction thread. See
// computeLayout.ts for the main-thread fallback main.ts also keeps for
// the (rare) case where the worker itself fails to start.

import { computeLayout } from './computeLayout';
import type { GraphNode } from '../shared/types';

interface LayoutRequest {
  type: 'layout';
  nodes: GraphNode[];
}

self.addEventListener('message', (event: MessageEvent<LayoutRequest>) => {
  if (event.data?.type !== 'layout') return;

  try {
    const start = performance.now();
    const graph = computeLayout(event.data.nodes);
    const computeMs = performance.now() - start;
    (self as unknown as Worker).postMessage({ type: 'result', graph, computeMs });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', message: String(err) });
  }
});
