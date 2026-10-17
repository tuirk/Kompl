'use client';

/**
 * The graph's focus scope mirrored into the address (?focus=<page_id>&depth=2),
 * so a focused view can be shared or reloaded. The page's own state is the
 * truth: the address is read once when the page opens (a "See in graph" link
 * or a reload) and rewritten in place on every change. The rewrite keeps
 * Next.js's history state, so the router is not asked to navigate (its
 * search-params sync raced the page's state), and no history entry is added:
 * Back still leaves the graph.
 */

import { GRAPH_PATH, parseScope, scopeQuery, type GraphScope } from '../../../lib/graph-scope';

export function readScope(): GraphScope {
  return parseScope(window.location.search);
}

export function writeScope(scope: GraphScope): void {
  window.history.replaceState(window.history.state, '', `${GRAPH_PATH}${scopeQuery(scope)}`);
}
