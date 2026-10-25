'use client';

/**
 * The rest of a connection's sources for the graph panels' evidence lists:
 * the panels' connections carry three per connection, so "+N more sources"
 * loads them all on demand (GET /api/wiki/[page_id]/connections/evidence)
 * and "Show fewer" folds them away again. Client-only, apart from
 * evidenceUrl.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionItem, RelationEvidence } from '../../../lib/relations';

export type EvidenceItem = Pick<ConnectionItem, 'evidence' | 'source_count' | 'type' | 'direction' | 'page_id' | 'title'>;

/** Where every source of `item`, a connection of page `pageId`, is loaded from. */
export function evidenceUrl(pageId: string, item: Pick<EvidenceItem, 'type' | 'direction' | 'page_id' | 'title'>): string {
  const query = new URLSearchParams({ type: item.type, direction: item.direction });
  if (item.page_id !== null) query.set('page', item.page_id);
  else query.set('name', item.title);
  return `/api/wiki/${encodeURIComponent(pageId)}/connections/evidence?${query}`;
}

export type MoreEvidence =
  | { status: 'closed' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'open'; evidence: RelationEvidence[] };

export function useMoreEvidence(pageId: string, item: EvidenceItem) {
  const [state, setState] = useState<MoreEvidence>({ status: 'closed' });
  /** Loaded once; closing and opening again shows it without asking the server. */
  const loaded = useRef<RelationEvidence[] | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const url = evidenceUrl(pageId, item);

  const open = useCallback(() => {
    if (loaded.current) {
      setState({ status: 'open', evidence: loaded.current });
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState({ status: 'loading' });
    fetch(url, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`evidence fetch failed: ${r.status}`);
        return r.json() as Promise<{ items: ConnectionItem[]; count: number }>;
      })
      .then(({ items }) => {
        const evidence = items[0]?.evidence ?? [];
        loaded.current = evidence;
        setState({ status: 'open', evidence });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
  }, [url]);
  const close = useCallback(() => setState({ status: 'closed' }), []);
  return { state, open, close };
}
