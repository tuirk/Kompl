/**
 * "Connect two pages" on the knowledge graph: the cheapest chain of visible
 * lines between two pages (Dijkstra). A typed relation costs 1, a plain link
 * 2 and a "related to"-only line 3, so the chain prefers lines that say how
 * pages relate. Also the steps of a chain read from its start, the title
 * pickers' matching and how a click on the map fills them. Pure and
 * client-safe, on top of graph-model.ts and graph-focus.ts.
 */

import { relationLabel } from './relation-labels';
import { namedRelation, type Highlight } from './graph-focus';
import { isMissingLink } from './graph-missing';
import type { EdgeKind, ModelLink, ModelNode, VisibleGraph } from './graph-model';

export const EDGE_COST: Readonly<Record<EdgeKind, number>> = { typed: 1, plain: 2, related: 3 };

export interface GraphPath {
  /** Page ids from start to end. */
  nodes: string[];
  /** links[i] joins nodes[i] and nodes[i + 1]. */
  links: ModelLink[];
  cost: number;
}

/** A chain's cost so far: total cost, then lines that are not typed (fewer wins a tie). */
interface Entry {
  cost: number;
  weak: number;
  id: string;
}

const before = (x: Entry, y: Entry) =>
  x.cost !== y.cost ? x.cost < y.cost : x.weak !== y.weak ? x.weak < y.weak : x.id < y.id;

/** A binary min-heap of entries; stale entries are skipped when popped. */
class Heap {
  private items: Entry[] = [];
  get size(): number {
    return this.items.length;
  }
  push(e: Entry): void {
    const a = this.items;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): Entry {
    const a = this.items;
    const top = a[0];
    const last = a.pop() as Entry;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const [l, r] = [2 * i + 1, 2 * i + 2];
        let m = i;
        if (l < a.length && before(a[l], a[m])) m = l;
        if (r < a.length && before(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * The cheapest chain from `from` to `to` over the visible lines, or null
 * when no chain joins them (or either page is not visible). Ties are broken
 * the same way on every run, whatever the order of the lines: at equal cost
 * the chain with fewer plain and "related to" lines (so more typed ones)
 * wins, then the one through lower page ids. A missing name is never a step.
 */
export function shortestPath(visible: Pick<VisibleGraph, 'linksOf'>, from: string, to: string): GraphPath | null {
  if (!visible.linksOf.has(from) || !visible.linksOf.has(to)) return null;
  const best = new Map<string, Entry>([[from, { cost: 0, weak: 0, id: from }]]);
  const via = new Map<string, ModelLink>();
  const done = new Set<string>();
  const heap = new Heap();
  heap.push({ cost: 0, weak: 0, id: from });
  while (heap.size > 0) {
    const cur = heap.pop();
    if (done.has(cur.id)) continue;
    done.add(cur.id);
    if (cur.id === to) break;
    for (const link of visible.linksOf.get(cur.id) ?? []) {
      if (isMissingLink(link)) continue;
      const other = link.a === cur.id ? link.b : link.a;
      if (done.has(other)) continue;
      const offer = { cost: cur.cost + EDGE_COST[link.kind], weak: cur.weak + (link.kind === 'typed' ? 0 : 1), id: other };
      const known = best.get(other);
      const previous = via.get(other);
      const prevFrom = previous ? (previous.a === other ? previous.b : previous.a) : '';
      const better =
        !known ||
        offer.cost < known.cost ||
        (offer.cost === known.cost && (offer.weak < known.weak || (offer.weak === known.weak && cur.id < prevFrom)));
      if (!better) continue;
      best.set(other, offer);
      via.set(other, link);
      heap.push(offer);
    }
  }
  if (!done.has(to)) return null;
  const nodes = [to];
  const links: ModelLink[] = [];
  for (let at = to; at !== from; ) {
    const link = via.get(at) as ModelLink;
    links.push(link);
    at = link.a === at ? link.b : link.a;
    nodes.push(at);
  }
  return { nodes: nodes.reverse(), links: links.reverse(), cost: (best.get(to) as Entry).cost };
}

/** What stays lit while a chain is shown. */
export function pathHighlight(path: GraphPath): Highlight {
  return { nodes: new Set(path.nodes), links: new Set(path.links) };
}

/** One step of a chain, read from its start: "Claude — Created by → Anthropic"; label null for a plain link. */
export interface PathStep {
  from: string;
  to: string;
  link: ModelLink;
  type: string | null;
  label: string | null;
}

export function pathSteps(path: GraphPath): PathStep[] {
  return path.links.map((link, i) => {
    const [from, to] = [path.nodes[i], path.nodes[i + 1]];
    const named = namedRelation(link);
    if (!named) return { from, to, link, type: null, label: null };
    const direction = from === link.a ? named.direction : named.direction === 'out' ? 'in' : 'out';
    return { from, to, link, type: named.type, label: relationLabel(named.type, direction) };
  });
}

/** A page as the title pickers offer it; archived pages say so. */
export function pickerLabel(node: Pick<ModelNode, 'label' | 'archived'>): string {
  return node.archived ? `${node.label} (archived)` : node.label;
}

/** The page whose picker label (or title) is `text`, any case; null when none. */
export function findByTitle(nodes: readonly ModelNode[], text: string): string | null {
  const want = text.trim().toLowerCase();
  if (!want) return null;
  const hit = nodes.find((n) => pickerLabel(n).toLowerCase() === want) ?? nodes.find((n) => n.label.toLowerCase() === want);
  return hit?.id ?? null;
}

/** The two pages being connected; either may still be empty. */
export interface PathQuery {
  from: string | null;
  to: string | null;
}

/** A click on the map while connecting: fills the start, then the end, then replaces the end. */
export function fillPath(query: PathQuery, id: string): PathQuery {
  if (query.from === null) return { from: id, to: query.to === id ? null : query.to };
  if (id === query.from) return query;
  return { from: query.from, to: id };
}
