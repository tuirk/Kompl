/**
 * "Show missing pages" on the knowledge graph: names the sources keep naming
 * that have no page yet (the payload's `missing`), drawn as dashed hollow
 * circles joined to the pages they are named with. Report-only: they take
 * the hover card, never a panel or a path. Built once per load; added on top
 * of the visible graph without changing it. Pure and client-safe.
 */

import { OVERVIEW_NAMES } from './graph-labels';
import { nodeRadius } from './graph-layout';
import { clipLabel, type GraphModel, type ModelLink, type ModelNode, type VisibleGraph } from './graph-model';
import { CANVAS_BG, LINE_ALPHA, LINE_FADED, LINE_HEX, LINE_LIT_HEX, withAlpha } from './graph-palette';

/** A missing page's dashed outline. Its lines are dashed too, at the "related to" brightness. */
export const MISSING_HEX = '#AEB4BE';
const MISSING_LINE = withAlpha(LINE_HEX, LINE_ALPHA.related);
const MISSING_LINE_FADED = withAlpha(LINE_HEX, LINE_FADED);
/** A missing name starts this far (graph units) from its first page, plus that page's radius. */
const MISSING_OFFSET = 26;

export interface MissingNode extends ModelNode {
  missing: true;
  /** The first page it is named with; it starts beside it. */
  homeId: string;
}

export interface MissingLink extends ModelLink {
  missing: true;
}

export interface MissingLayer {
  nodes: MissingNode[];
  /** Each missing name's lines, one per page it is named with. */
  linksOf: Map<string, MissingLink[]>;
  byId: Map<string, MissingNode>;
}

export function isMissingNode(node: ModelNode): node is MissingNode {
  return (node as Partial<MissingNode>).missing === true;
}

export function isMissingLink(link: ModelLink): link is MissingLink {
  return (link as Partial<MissingLink>).missing === true;
}

/** Page ids never contain a colon, so these ids never clash with a page's. */
export const missingId = (name: string) => `missing:${name}`;

/** The hover card's second line for a missing name. */
export function missingDetail(sources: number): string {
  return `Named in ${sources} source${sources === 1 ? '' : 's'}, no page yet`;
}

/** Puts a missing name just outside its home page, on the side away from the page's island anchor. */
function placeBeside(node: MissingNode, home: ModelNode): void {
  const angle = Math.atan2(home.y - home.anchorY, home.x - home.anchorX) || 0;
  const reach = home.radius + node.radius + MISSING_OFFSET;
  node.x = home.x + reach * Math.cos(angle);
  node.y = home.y + reach * Math.sin(angle);
  const sim = node as { vx?: number; vy?: number };
  sim.vx = 0;
  sim.vy = 0;
}

/**
 * Moves every missing name beside its home page where that page is now, so
 * names shown after the layout has settled start next to their pages.
 */
export function placeMissing(layer: MissingLayer, byId: ReadonlyMap<string, ModelNode>): void {
  for (const node of layer.nodes) {
    const home = byId.get(node.homeId);
    if (home) placeBeside(node, home);
  }
}

/** The missing names whose pages are in the payload, placed beside their first page. */
export function buildMissingLayer(model: Pick<GraphModel, 'missing' | 'byId'>): MissingLayer {
  const nodes: MissingNode[] = [];
  const linksOf = new Map<string, MissingLink[]>();
  for (const m of model.missing) {
    const pages = m.page_ids.map((id) => model.byId.get(id)).filter((p): p is ModelNode => p !== undefined);
    if (pages.length === 0) continue;
    const home = pages[0];
    const id = missingId(m.name);
    // Built field by field: a spread of `home` would copy the simulation's own fields.
    const node: MissingNode = {
      id,
      label: m.name,
      shortLabel: clipLabel(m.name),
      pageType: 'missing',
      category: home.category,
      catIndex: home.catIndex,
      anchorX: home.anchorX,
      anchorY: home.anchorY,
      x: home.x,
      y: home.y,
      summary: null,
      sourceCount: m.source_count,
      lastUpdated: null,
      degree: pages.length,
      archived: false,
      isSource: false,
      ring: false,
      radius: nodeRadius(m.source_count),
      color: MISSING_HEX,
      fill: CANVAS_BG,
      fillFaded: CANVAS_BG,
      missing: true,
      homeId: home.id,
    };
    placeBeside(node, home);
    nodes.push(node);
    linksOf.set(
      id,
      pages.map((p) => ({
        source: id,
        target: p.id,
        a: id < p.id ? id : p.id,
        b: id < p.id ? p.id : id,
        relations: [],
        wikilink: false,
        weight: 0,
        kind: 'related',
        colorType: null,
        sameCategory: p.category === home.category,
        width: 1,
        color: MISSING_LINE,
        faded: MISSING_LINE_FADED,
        bright: LINE_LIT_HEX,
        missing: true,
      }))
    );
  }
  return { nodes, linksOf, byId: new Map(nodes.map((n) => [n.id, n])) };
}

/**
 * The visible graph plus each missing name that is named with a visible
 * page, joined to those pages. A new graph: `visible` is left as it was.
 * Missing names are named on the map like pages past the first few of an
 * island (zoomed in, or when lit).
 */
export function withMissing(visible: VisibleGraph, layer: MissingLayer): VisibleGraph {
  const nodes = [...visible.nodes];
  const links = [...visible.links];
  const neighbours = new Map(visible.neighbours);
  const linksOf = new Map(visible.linksOf);
  const labelOrder = [...visible.labelOrder];
  const labelRank = new Map(visible.labelRank);
  const copied = new Set<string>();
  for (const m of layer.nodes) {
    const shown = (layer.linksOf.get(m.id) ?? []).filter((l) => visible.neighbours.has(l.a === m.id ? l.b : l.a));
    if (shown.length === 0) continue;
    nodes.push(m);
    labelOrder.push(m);
    labelRank.set(m.id, OVERVIEW_NAMES);
    neighbours.set(m.id, new Set());
    linksOf.set(m.id, shown);
    for (const l of shown) {
      const page = l.a === m.id ? l.b : l.a;
      if (!copied.has(page)) {
        copied.add(page);
        neighbours.set(page, new Set(neighbours.get(page)));
        linksOf.set(page, [...(linksOf.get(page) ?? [])]);
      }
      links.push(l);
      (neighbours.get(m.id) as Set<string>).add(page);
      (neighbours.get(page) as Set<string>).add(m.id);
      (linksOf.get(page) as ModelLink[]).push(l);
    }
  }
  return { ...visible, nodes, links, neighbours, linksOf, labelOrder, labelRank };
}
