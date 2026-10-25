'use client';

/**
 * Everything the graph page derives from the payload and its controls, each
 * worked out only when its inputs change: the model, the map the legend lets
 * through, the focused view (lib/graph-scope.ts), the missing names on top
 * (graph-missing.ts), the bridge pages (useBridges.ts: once per load, in a
 * Web Worker, on the default view, whatever the legend and the focus) and a
 * path being connected (graph-path.ts, over the map the legend shows, never
 * through a missing name).
 */

import { useMemo } from 'react';
import { buildMissingLayer, withMissing } from '../../../lib/graph-missing';
import { buildGraphModel, filterGraph, type GraphFilters, type ModelNode } from '../../../lib/graph-model';
import { pathHighlight, shortestPath, type PathQuery } from '../../../lib/graph-path';
import { focusGraph, type GraphScope } from '../../../lib/graph-scope';
import type { WikiGraph } from '../../../lib/wiki-graph';
import { useBridges } from './useBridges';

const NO_DATA: WikiGraph = { nodes: [], links: [], missing: [] };

export function useGraphView(
  data: WikiGraph | null, filters: GraphFilters, scope: GraphScope, showMissing: boolean, pathQuery: PathQuery | null
) {
  const model = useMemo(() => buildGraphModel(data ?? NO_DATA), [data]);
  /** The map the legend lets through, before any focus. */
  const full = useMemo(() => filterGraph(model, filters), [model, filters]);
  const focusId = scope.focus !== null && full.neighbours.has(scope.focus) ? scope.focus : null;
  const scoped = useMemo(
    () => (focusId ? focusGraph(model, filters, full, focusId, scope.depth) : full),
    [model, filters, full, focusId, scope.depth]
  );
  const layer = useMemo(() => buildMissingLayer(model), [model]);
  const visible = useMemo(() => (showMissing ? withMissing(scoped, layer) : scoped), [showMissing, scoped, layer]);
  const lookup = useMemo(() => new Map<string, ModelNode>([...model.byId, ...layer.byId]), [model, layer]);

  // Betweenness is O(pages x lines): once per load, off the main thread, never on a legend toggle.
  const bridges = useBridges(model);
  const bridgeIds = useMemo(() => new Set(bridges.keys()), [bridges]);

  const path = useMemo(() => {
    if (!pathQuery?.from || !pathQuery.to || pathQuery.from === pathQuery.to) return null;
    return shortestPath(full, pathQuery.from, pathQuery.to);
  }, [full, pathQuery]);
  const pinned = useMemo(() => (path ? pathHighlight(path) : null), [path]);
  /** Ringed like the selection: the two pages being connected, else the focused page. */
  const marked = useMemo(() => {
    if (pathQuery) return new Set([pathQuery.from, pathQuery.to].filter((id): id is string => id !== null));
    return focusId ? new Set([focusId]) : null;
  }, [pathQuery, focusId]);
  /** Pages the path pickers offer, by title. */
  const pickable = useMemo(
    () => [...full.nodes].sort((x, y) => x.label.localeCompare(y.label) || (x.id < y.id ? -1 : 1)),
    [full]
  );

  return { model, full, focusId, scoped, layer, visible, lookup, bridges, bridgeIds, path, pinned, marked, pickable };
}
