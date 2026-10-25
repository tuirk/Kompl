'use client';

/**
 * The knowledge graph's payload (/api/wiki/graph), loaded again whenever
 * archived pages are turned on or off; each load clears the selection.
 * `loaded` is false until the first load and while such a reload runs (the
 * map on screen is then still the old one). An empty map may only mean
 * every page is archived, so it asks once more to tell (`archivedOnly`).
 */

import { useEffect, useState } from 'react';
import type { WikiGraph } from '../../../lib/wiki-graph';

async function loadGraph(includeArchived: boolean, signal: AbortSignal): Promise<WikiGraph> {
  const r = await fetch(includeArchived ? '/api/wiki/graph?include_archived=true' : '/api/wiki/graph', { signal });
  if (!r.ok) throw new Error(`graph fetch failed: ${r.status}`);
  return (await r.json()) as WikiGraph;
}

export function useGraphData(includeArchived: boolean, setSelected: (none: null) => void) {
  const [data, setData] = useState<WikiGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Whether `data` holds archived pages. */
  const [loadedArchived, setLoadedArchived] = useState(false);
  /** True when every page is archived: the legend stays up so "Show archived" can be turned on. */
  const [archivedOnly, setArchivedOnly] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    (async () => {
      const graph = await loadGraph(includeArchived, abort.signal);
      const hidden = !includeArchived && graph.nodes.length === 0
        ? (await loadGraph(true, abort.signal)).nodes.length > 0
        : false;
      setData(graph);
      setLoadedArchived(includeArchived);
      setArchivedOnly(hidden);
      setError(null);
      setSelected(null);
    })().catch((e: unknown) => {
      if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'failed to load graph');
    });
    return () => abort.abort();
  }, [includeArchived, setSelected]);

  return { data, error, archivedOnly, loaded: data !== null && loadedArchived === includeArchived };
}
