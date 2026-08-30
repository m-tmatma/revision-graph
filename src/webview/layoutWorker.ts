// Runs the layout engine inside a dedicated Web Worker, so layout
// computation never blocks the webview's render/interaction thread. See
// computeLayout.ts for the main-thread fallback main.ts also keeps for
// the (rare) case where the worker itself fails to start.
//
// Type-checked against its own tsconfig.worker.json (WebWorker lib only,
// no DOM) rather than the shared tsconfig.json -- combining the DOM and
// WebWorker libs in one program gives `self` a merged, ambiguous type
// (previously worked around here with `self as unknown as Worker`); with
// only WebWorker in scope, `self` is a plain DedicatedWorkerGlobalScope
// and postMessage needs no cast.

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
    self.postMessage({ type: 'result', graph });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err) });
  }
});
