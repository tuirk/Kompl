/**
 * Focus mode on the knowledge graph: /wiki/graph?focus=<page_id>&depth=1|2
 * shows one page and the pages within one or two lines of it, over the
 * lines the legend shows. The URL form, the "See in graph" link, the pages
 * kept, and the legend change that reveals a focused page the filters hide.
 * Pure; the URL helpers are server-safe too (the page's Connections card
 * links here).
 */

import { filterGraph, type GraphFilters, type GraphModel, type ModelNode, type VisibleGraph } from './graph-model';

export type FocusDepth = 1 | 2;

export interface GraphScope {
  /** The focused page, or null for the full map. */
  focus: string | null;
  depth: FocusDepth;
}

export const FULL_MAP: GraphScope = { focus: null, depth: 1 };
export const GRAPH_PATH = '/wiki/graph';

/** Reads ?focus= and ?depth= (anything but 2 is depth 1). */
export function parseScope(search: string): GraphScope {
  const params = new URLSearchParams(search);
  const focus = params.get('focus')?.trim() || null;
  return { focus, depth: focus !== null && params.get('depth') === '2' ? 2 : 1 };
}

/** The query string for a scope: '' for the full map; depth only when it is 2. */
export function scopeQuery(scope: GraphScope): string {
  if (scope.focus === null) return '';
  const params = new URLSearchParams({ focus: scope.focus });
  if (scope.depth === 2) params.set('depth', '2');
  return `?${params.toString()}`;
}

export function sameScope(x: GraphScope, y: GraphScope): boolean {
  return x.focus === y.focus && x.depth === y.depth;
}

/** The graph focused on a page (the Connections card's "See in graph"). */
export function seeInGraphHref(pageId: string): string {
  return `${GRAPH_PATH}${scopeQuery({ focus: pageId, depth: 1 })}`;
}

/** The page and every page within `depth` visible lines of it; empty when the page is not visible. */
export function hopsFrom(visible: Pick<VisibleGraph, 'neighbours'>, center: string, depth: number): Set<string> {
  if (!visible.neighbours.has(center)) return new Set();
  const kept = new Set([center]);
  let ring = [center];
  for (let d = 0; d < depth && ring.length > 0; d++) {
    const next: string[] = [];
    for (const id of ring) {
      for (const other of visible.neighbours.get(id) ?? []) {
        if (kept.has(other)) continue;
        kept.add(other);
        next.push(other);
      }
    }
    ring = next;
  }
  return kept;
}

/**
 * The focused view: the pages within `depth` lines of `center` over the
 * graph the legend shows (`full`), and every visible line among them. The
 * legend's counts then describe this view.
 */
export function focusGraph(
  model: GraphModel, filters: GraphFilters, full: VisibleGraph, center: string, depth: FocusDepth
): VisibleGraph {
  const kept = hopsFrom(full, center, depth);
  return filterGraph({ ...model, nodes: model.nodes.filter((n) => kept.has(n.id)) }, filters);
}

/**
 * The filters with `node` let through: its category and page type shown,
 * and source pages on when it is one. The same object when nothing changes,
 * so a focus on a visible page leaves the legend as it is.
 */
export function revealFilters(filters: GraphFilters, node: ModelNode): GraphFilters {
  const hiddenCategory = filters.hiddenCategories.has(node.category);
  const hiddenType = !node.isSource && filters.hiddenTypes.has(node.pageType);
  const hiddenSource = node.isSource && !filters.showSources;
  if (!hiddenCategory && !hiddenType && !hiddenSource) return filters;
  const without = (set: ReadonlySet<string>, value: string) => new Set([...set].filter((v) => v !== value));
  return {
    ...filters,
    showSources: filters.showSources || node.isSource,
    hiddenCategories: hiddenCategory ? without(filters.hiddenCategories, node.category) : filters.hiddenCategories,
    hiddenTypes: hiddenType ? without(filters.hiddenTypes, node.pageType) : filters.hiddenTypes,
  };
}

/** Line kinds the legend hides that would join a focused page to the map. */
export interface FocusHint {
  plain: boolean;
  related: boolean;
}

/**
 * Why a focused view shows a lone page: when it draws no line at all, the
 * hidden kinds (plain links, "related to") that join the focused page to a
 * page the legend shows (`full`). Null when the view has lines, nothing is
 * focused, or no hidden line would help.
 */
export function focusHint(
  model: Pick<GraphModel, 'links'>, full: Pick<VisibleGraph, 'neighbours'>, scoped: Pick<VisibleGraph, 'links'>,
  focusId: string | null, filters: GraphFilters
): FocusHint | null {
  if (focusId === null || scoped.links.length > 0) return null;
  let plain = false;
  let related = false;
  for (const l of model.links) {
    if (l.a !== focusId && l.b !== focusId) continue;
    if (!full.neighbours.has(l.a === focusId ? l.b : l.a)) continue;
    if (l.kind === 'plain' && !filters.showPlain) plain = true;
    if (l.kind === 'related' && !filters.showRelated) related = true;
  }
  return plain || related ? { plain, related } : null;
}

/** The hint's button: "Show plain links", "Show “related to”" or both. */
export function focusHintAction(hint: FocusHint): string {
  if (hint.plain && hint.related) return 'Show plain links and “related to”';
  return hint.plain ? 'Show plain links' : 'Show “related to”';
}
