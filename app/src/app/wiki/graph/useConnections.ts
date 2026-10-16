'use client';

/**
 * Loads a page's connections (GET /api/wiki/[page_id]/connections, the same
 * read model as the page's Connections card) for the graph's panels. Answers
 * are kept in `cache`, which the page empties whenever it reloads the graph,
 * so clicking around the map asks the server once per page.
 */

import { useEffect, useState } from 'react';
import type { PageConnections } from '../../../lib/relations';

export type ConnectionsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: PageConnections };

export function useConnections(pageId: string, cache: Map<string, PageConnections>): ConnectionsState {
  const cached = cache.get(pageId);
  const [state, setState] = useState<{ id: string; value: ConnectionsState }>({
    id: pageId,
    value: cached ? { status: 'ready', data: cached } : { status: 'loading' },
  });

  useEffect(() => {
    const hit = cache.get(pageId);
    if (hit) {
      setState({ id: pageId, value: { status: 'ready', data: hit } });
      return;
    }
    setState({ id: pageId, value: { status: 'loading' } });
    const abort = new AbortController();
    fetch(`/api/wiki/${encodeURIComponent(pageId)}/connections`, { signal: abort.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`connections fetch failed: ${r.status}`);
        return r.json() as Promise<PageConnections>;
      })
      .then((data) => {
        cache.set(pageId, data);
        setState({ id: pageId, value: { status: 'ready', data } });
      })
      .catch(() => {
        if (!abort.signal.aborted) setState({ id: pageId, value: { status: 'error' } });
      });
    return () => abort.abort();
  }, [pageId, cache]);

  // Until the effect catches up with a new page, report loading rather than the old page's data.
  if (state.id !== pageId) return cached ? { status: 'ready', data: cached } : { status: 'loading' };
  return state.value;
}
