'use client';

/**
 * The map's bridge pages (lib/graph-bridges.ts), worked out once per load
 * in a Web Worker (lib/graph-worker-browser.ts) so the page stays
 * responsive while betweenness runs: none until the pass is back, and a
 * new load cancels a pass still running. If the worker fails, the pass
 * runs here instead.
 */

import { useEffect, useState } from 'react';
import { bridgeWork, mapBridges } from '../../../lib/graph-bridges';
import type { Bridge } from '../../../lib/graph-metrics';
import type { GraphModel } from '../../../lib/graph-model';
import { runInBrowserWorker } from '../../../lib/graph-worker-browser';

const NO_BRIDGES: ReadonlyMap<string, Bridge> = new Map();

export function useBridges(model: GraphModel): ReadonlyMap<string, Bridge> {
  const [found, setFound] = useState<{ model: GraphModel; bridges: ReadonlyMap<string, Bridge> } | null>(null);
  useEffect(() => {
    let current = true;
    const { job, finish } = bridgeWork(model);
    const pass = runInBrowserWorker(job);
    pass.scores
      .then(finish, () => (current ? mapBridges(model) : NO_BRIDGES))
      .then((bridges) => {
        if (current) setFound({ model, bridges });
      });
    return () => {
      current = false;
      pass.cancel();
    };
  }, [model]);
  // Badges from the previous load never show on this one.
  return found?.model === model ? found.bridges : NO_BRIDGES;
}
