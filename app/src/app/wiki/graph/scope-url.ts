'use client';

/**
 * The graph's focus scope mirrored into the address (?focus=<page_id>&depth=2),
 * so a focused view can be shared, reloaded and walked with Back / Forward.
 * The page's own state is the truth: the address is read when the page opens
 * (a "See in graph" link or a reload) and on Back / Forward. Entering,
 * changing or leaving a focus adds a history entry; a depth change or a
 * correction replaces the current one (lib/graph-scope.ts historyMode).
 *
 * Writes use the native History API with no state of their own, as the App
 * Router documents: Next.js copies its own entry state into the new entry
 * (so Back / Forward stay on this page, with no reload or server request) and
 * takes the new address as its own. Keeping Next's state by hand instead
 * would leave its router on the old address, which it writes back on its
 * next update. The page reads the address itself, never useSearchParams.
 * Also the notice about the address, e.g. a focused page not on the map.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { FULL_MAP, GRAPH_PATH, historyMode, parseScope, sameScope, scopeQuery, type GraphScope } from '../../../lib/graph-scope';

function readScope(): GraphScope {
  return parseScope(window.location.search);
}

function writeScope(scope: GraphScope, mode: 'push' | 'replace'): void {
  const url = `${GRAPH_PATH}${scopeQuery(scope)}`;
  if (mode === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

export function useScopeAddress() {
  const [scope, setScope] = useState<GraphScope>(FULL_MAP);
  const [notice, setNotice] = useState<string | null>(null);
  /** The scope shown, for telling a focus change from a depth change. */
  const shown = useRef<GraphScope>(FULL_MAP);
  const show = useCallback((next: GraphScope) => {
    shown.current = next;
    setScope(next);
  }, []);

  // The address once when the page opens, and again on Back / Forward between graph entries.
  useEffect(() => {
    show(readScope());
    const onPop = () => {
      show(readScope());
      setNotice(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [show]);

  /** A new scope from the viewer: a history entry for a focus change; `replace` for a correction. */
  const changeScope = useCallback((next: GraphScope, mode?: 'replace') => {
    setNotice(null);
    const prev = shown.current;
    if (sameScope(prev, next)) return;
    writeScope(next, mode ?? historyMode(prev, next));
    show(next);
  }, [show]);

  return { scope, changeScope, notice, setNotice };
}
