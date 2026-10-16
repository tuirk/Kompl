/**
 * The knowledge graph page's model (app/wiki/graph): turns the
 * /api/wiki/graph payload into pages and lines ready to draw (colours,
 * sizes, category anchors and seeded positions, worked out once per load)
 * and filters them by the legend. The canvas callbacks only read fields set
 * here, so drawing allocates nothing per frame. Pure and client-safe; the
 * server modules are imported for their types only.
 */

import type { EdgeRelation, MissingPage } from './relation-edges';
import type { WikiGraph } from './wiki-graph';
import { PLAIN_LINK_HEX, relationHex, withAlpha } from './graph-palette';
import {
  categoryAnchors, clusterRadius, edgeWidth, nodeRadius, rankCategories, ringOrder, seedPosition, UNCATEGORIZED,
} from './graph-layout';

/** Page types hidden behind "Show source pages". */
export const SOURCE_PAGE_TYPES: ReadonlySet<string> = new Set(['source-summary', 'original-source']);
/** Page types drawn with an outer ring. */
export const RING_PAGE_TYPES: ReadonlySet<string> = new Set(['overview', 'comparison']);
const RELATED_TO = 'related_to';
/** Characters of a title drawn on the canvas. */
export const LABEL_MAX = 32;

/** Alphas: the rest of the map fades while a page or line is hovered or selected. */
const NODE_FADED = 0.14;
const SOURCE_FILL = 0.45;
const LINE_ALPHA: Record<EdgeKind, number> = { typed: 0.8, related: 0.5, plain: 0.5 };
const LINE_FADED = 0.06;
const PLAIN_BRIGHT_HEX = '#A3ACBA';

/** typed: a specific relation; related: only "related to"; plain: only a wikilink. */
export type EdgeKind = 'typed' | 'related' | 'plain';

export interface ModelNode {
  id: string;
  label: string;
  shortLabel: string;
  pageType: string;
  category: string;
  catIndex: number;
  summary: string | null;
  sourceCount: number;
  lastUpdated: string | null;
  degree: number;
  archived: boolean;
  isSource: boolean;
  ring: boolean;
  radius: number;
  color: string;
  fill: string;
  fillFaded: string;
  anchorX: number;
  anchorY: number;
  /** Simulation state: seeded here, then moved by the layout. */
  x: number;
  y: number;
}

export interface ModelLink {
  /** Ids for force-graph, which swaps them for the node objects. */
  source: string | ModelNode;
  target: string | ModelNode;
  /** The two page ids (a < b); never rewritten. */
  a: string;
  b: string;
  /** Strongest first; `direction` is read from page `a`. */
  relations: EdgeRelation[];
  wikilink: boolean;
  weight: number;
  kind: EdgeKind;
  /** The relation that colours the line: the strongest specific one, else related_to; null for a plain link. */
  colorType: string | null;
  sameCategory: boolean;
  width: number;
  color: string;
  faded: string;
  bright: string;
}

export interface CategoryInfo {
  name: string;
  /** The name as drawn over its island (upper case). */
  mapLabel: string;
  index: number;
  color: string;
  /** Past the eighth colour: grey, listed as "Other" in the legend. */
  overflow: boolean;
  /** Pages in the payload. */
  total: number;
  anchorX: number;
  anchorY: number;
}

export interface GraphModel {
  nodes: ModelNode[];
  /** Drawing order: plain links, then "related to", then typed; lighter first. */
  links: ModelLink[];
  byId: Map<string, ModelNode>;
  /** Colour rank order, "Uncategorized" last. */
  categories: CategoryInfo[];
  missing: MissingPage[];
}

export function edgeKind(relations: readonly EdgeRelation[]): EdgeKind {
  if (relations.length === 0) return 'plain';
  return relations.every((r) => r.type === RELATED_TO) ? 'related' : 'typed';
}

/** The strongest relation that is not "related to", else "related to"; null when none. */
export function colorTypeOf(relations: readonly EdgeRelation[]): string | null {
  return (relations.find((r) => r.type !== RELATED_TO) ?? relations[0])?.type ?? null;
}

export function clipLabel(title: string): string {
  return title.length > LABEL_MAX ? `${title.slice(0, LABEL_MAX - 1).trimEnd()}…` : title;
}

const KIND_ORDER: Record<EdgeKind, number> = { plain: 0, related: 1, typed: 2 };
const compareIds = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/** How much a line between two categories draws their islands together on the ring. */
const RING_AFFINITY: Record<EdgeKind, number> = { typed: 1, related: 0.5, plain: 0.1 };
const pairKey = (x: string, y: string) => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);

/** Categories in colour rank, each with its anchor on the ring (islands that share lines side by side). */
function placeCategories(data: WikiGraph): CategoryInfo[] {
  const counts = new Map<string, { name: string; live: number; total: number }>();
  for (const n of data.nodes) {
    const c = counts.get(n.category) ?? { name: n.category, live: 0, total: 0 };
    c.total += 1;
    if (!n.archived) c.live += 1;
    counts.set(n.category, c);
  }
  const ranked = rankCategories([...counts.values()]);
  const categoryOf = new Map(data.nodes.map((n) => [n.id, n.category]));
  const affinity = new Map<string, number>();
  for (const e of data.links) {
    const [ca, cb] = [categoryOf.get(e.source), categoryOf.get(e.target)];
    if (ca === undefined || cb === undefined || ca === cb) continue;
    const key = pairKey(ca, cb);
    affinity.set(key, (affinity.get(key) ?? 0) + RING_AFFINITY[edgeKind(e.relations)]);
  }
  const ring = ringOrder(ranked.map((c) => c.name), (x, y) => affinity.get(pairKey(x, y)) ?? 0);
  const total = new Map(ranked.map((c) => [c.name, c.total]));
  const anchors = categoryAnchors(ring.map((name) => total.get(name) as number));
  const anchorOf = new Map(ring.map((name, i) => [name, anchors[i]]));
  return ranked.map((c, index) => {
    const anchor = anchorOf.get(c.name) as { x: number; y: number };
    return { name: c.name, mapLabel: c.name.toUpperCase(), index, color: c.color, overflow: c.overflow, total: c.total, anchorX: anchor.x, anchorY: anchor.y };
  });
}

export function buildGraphModel(data: WikiGraph): GraphModel {
  const categories = placeCategories(data);
  const catByName = new Map(categories.map((c) => [c.name, c]));

  const nodes: ModelNode[] = data.nodes.map((n) => {
    const cat = catByName.get(n.category) ?? (catByName.get(UNCATEGORIZED) as CategoryInfo);
    const isSource = SOURCE_PAGE_TYPES.has(n.group);
    const seed = seedPosition(n.id, { x: cat.anchorX, y: cat.anchorY }, clusterRadius(cat.total));
    return {
      id: n.id,
      label: n.label,
      shortLabel: clipLabel(n.label),
      pageType: n.group,
      category: n.category,
      catIndex: cat.index,
      summary: n.summary ?? null,
      sourceCount: n.source_count,
      lastUpdated: n.last_updated ?? null,
      degree: n.degree,
      archived: n.archived === true,
      isSource,
      ring: RING_PAGE_TYPES.has(n.group),
      radius: nodeRadius(n.source_count),
      color: cat.color,
      fill: isSource ? withAlpha(cat.color, SOURCE_FILL) : cat.color,
      fillFaded: withAlpha(cat.color, isSource ? NODE_FADED / 2 : NODE_FADED),
      anchorX: cat.anchorX,
      anchorY: cat.anchorY,
      x: seed.x,
      y: seed.y,
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const links: ModelLink[] = [];
  for (const e of data.links) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    const kind = edgeKind(e.relations);
    const colorType = colorTypeOf(e.relations);
    const hex = colorType === null ? PLAIN_LINK_HEX : relationHex(colorType);
    links.push({
      source: a.id,
      target: b.id,
      a: a.id,
      b: b.id,
      relations: e.relations,
      wikilink: e.wikilink,
      weight: e.weight,
      kind,
      colorType,
      sameCategory: a.category === b.category,
      width: edgeWidth(e.weight),
      color: withAlpha(hex, LINE_ALPHA[kind]),
      faded: withAlpha(hex, LINE_FADED),
      bright: kind === 'plain' ? PLAIN_BRIGHT_HEX : hex,
    });
  }
  links.sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.weight - y.weight || compareIds(x.a, y.a) || compareIds(x.b, y.b));
  return { nodes, links, byId, categories, missing: data.missing };
}

export interface GraphFilters {
  showSources: boolean;
  showRelated: boolean;
  showPlain: boolean;
  hiddenCategories: ReadonlySet<string>;
  hiddenTypes: ReadonlySet<string>;
}

export const DEFAULT_FILTERS: GraphFilters = {
  showSources: false,
  showRelated: false,
  showPlain: false,
  hiddenCategories: new Set(),
  hiddenTypes: new Set(),
};

export function isKindShown(kind: EdgeKind, filters: GraphFilters): boolean {
  return kind === 'typed' || (kind === 'related' ? filters.showRelated : filters.showPlain);
}

export interface VisibleGraph {
  nodes: ModelNode[];
  links: ModelLink[];
  /** Visible neighbours of every visible page. */
  neighbours: Map<string, Set<string>>;
  /** Visible lines touching every visible page. */
  linksOf: Map<string, ModelLink[]>;
  /** Pages each category would show, whatever the category filter. */
  categoryCounts: Map<string, number>;
  /** Pages of each type the category filter lets through, whatever the type and source filters. */
  typeCounts: Map<string, number>;
  /** Visible pages, most sources and lines first: the order names are placed in. */
  labelOrder: ModelNode[];
  /** Place of each page within its island in that order: the first few are named when zoomed out. */
  labelRank: Map<string, number>;
}

/** The pages and lines the legend lets through, with their adjacency. */
export function filterGraph(model: GraphModel, filters: GraphFilters): VisibleGraph {
  const typeShown = (n: ModelNode) => (n.isSource ? filters.showSources : !filters.hiddenTypes.has(n.pageType));
  const categoryCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  const nodes: ModelNode[] = [];
  const neighbours = new Map<string, Set<string>>();
  const linksOf = new Map<string, ModelLink[]>();
  for (const n of model.nodes) {
    const catShown = !filters.hiddenCategories.has(n.category);
    if (catShown) typeCounts.set(n.pageType, (typeCounts.get(n.pageType) ?? 0) + 1);
    if (!typeShown(n)) continue;
    categoryCounts.set(n.category, (categoryCounts.get(n.category) ?? 0) + 1);
    if (!catShown) continue;
    nodes.push(n);
    neighbours.set(n.id, new Set());
    linksOf.set(n.id, []);
  }
  const links: ModelLink[] = [];
  for (const l of model.links) {
    if (!isKindShown(l.kind, filters)) continue;
    const na = neighbours.get(l.a);
    const nb = neighbours.get(l.b);
    if (!na || !nb) continue;
    links.push(l);
    na.add(l.b);
    nb.add(l.a);
    (linksOf.get(l.a) as ModelLink[]).push(l);
    (linksOf.get(l.b) as ModelLink[]).push(l);
  }
  const labelRank = new Map<string, number>();
  const weight = (n: ModelNode) => n.sourceCount + (linksOf.get(n.id) as ModelLink[]).length;
  const ranked = [...nodes].sort((x, y) => weight(y) - weight(x) || x.label.localeCompare(y.label));
  const seen = new Map<number, number>();
  for (const n of ranked) {
    const place = seen.get(n.catIndex) ?? 0;
    labelRank.set(n.id, place);
    seen.set(n.catIndex, place + 1);
  }
  return { nodes, links, neighbours, linksOf, categoryCounts, typeCounts, labelOrder: ranked, labelRank };
}

/**
 * True when the view draws no line at all while plain links join pages it
 * shows: the canvas then offers to turn plain links on, instead of leaving
 * a field of unconnected dots unexplained.
 */
export function plainLinksHint(model: GraphModel, visible: VisibleGraph, filters: GraphFilters): boolean {
  if (visible.links.length > 0 || filters.showPlain) return false;
  return model.links.some((l) => l.kind === 'plain' && visible.neighbours.has(l.a) && visible.neighbours.has(l.b));
}
