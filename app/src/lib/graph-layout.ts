/**
 * Layout rules for the knowledge graph (app/wiki/graph): which colour each
 * category gets, where each category's island sits, where each page starts,
 * and the force settings the canvas applies. Everything here is pure and
 * deterministic, so the map looks the same on every load. Client-safe.
 */

import { CATEGORY_HEX, NEUTRAL_HEX } from './graph-palette';

export const UNCATEGORIZED = 'Uncategorized';

/**
 * Force settings. Pages are pulled toward their category's anchor (cluster
 * strength, as d3 forceX/forceY), pushed apart by charge (capped in range so
 * islands do not repel each other across the map) and kept from overlapping
 * by collide. Lines across categories are long and weak, so a few bridges do
 * not drag two islands into one. The simulation stops by alpha, not by time.
 */
export const LAYOUT = {
  clusterStrength: 0.08,
  chargeBase: -30,
  chargePerRadius: -2.5,
  chargeDistanceMax: 280,
  linkDistance: 34,
  crossLinkDistance: 110,
  linkStrength: 0.5,
  crossLinkStrength: 0.04,
  collidePadding: 10,
  collideStrength: 1,
  collideIterations: 2,
  velocityDecay: 0.42,
  alphaDecay: 0.0228,
  alphaMin: 0.01,
  /** Ticks run before the first frame; fewer on big graphs so the page stays responsive. */
  warmupTicks: 120,
  warmupTicksLarge: 30,
  largeGraphNodes: 600,
  /** Island size: CLUSTER_SPACING * sqrt(pages); islands keep CLUSTER_GAP between them on the ring. */
  clusterSpacing: 22,
  clusterGap: 70,
  minRingRadius: 140,
} as const;

/** 32-bit FNV-1a of a string, offset by `seed` so one id gives independent values. */
export function hashString(s: string, seed = 0): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A number in [0, 1) from an id; the same id and seed always give the same number. */
export function unitHash(s: string, seed: number): number {
  return hashString(s, seed) / 4294967296;
}

export interface CategoryCount {
  name: string;
  /** Pages that are not archived: decides the colour rank. */
  live: number;
  /** All pages in the payload. */
  total: number;
}

/**
 * Category order and colours: biggest first (live pages, then all pages,
 * then name), the first eight take CATEGORY_HEX, the rest and
 * "Uncategorized" are neutral grey; "Uncategorized" always sorts last.
 */
export function rankCategories(counts: CategoryCount[]): Array<CategoryCount & { color: string; overflow: boolean }> {
  const named = counts
    .filter((c) => c.name !== UNCATEGORIZED)
    .sort((a, b) => b.live - a.live || b.total - a.total || a.name.localeCompare(b.name));
  const ranked = named.map((c, i) => ({
    ...c,
    color: i < CATEGORY_HEX.length ? CATEGORY_HEX[i] : NEUTRAL_HEX,
    overflow: i >= CATEGORY_HEX.length,
  }));
  const uncategorized = counts.find((c) => c.name === UNCATEGORIZED);
  if (uncategorized) ranked.push({ ...uncategorized, color: NEUTRAL_HEX, overflow: false });
  return ranked;
}

/**
 * Order of the islands around the ring. A chain grows from the first name:
 * each step adds the unplaced name with the most lines to either end of the
 * chain, at that end (ties: most lines to any placed name, then the given
 * order; the tail wins a tie between ends). Islands that share lines sit
 * side by side, so the lines between them stay short.
 */
export function ringOrder(names: readonly string[], affinity: (a: string, b: string) => number): string[] {
  if (names.length === 0) return [];
  const chain = [names[0]];
  const left = names.slice(1);
  const toPlaced = new Map(left.map((n) => [n, affinity(names[0], n)]));
  while (left.length > 0) {
    const [head, tail] = [chain[0], chain[chain.length - 1]];
    let pick = { i: 0, end: -1, all: -1, atHead: false };
    left.forEach((name, i) => {
      const toTail = affinity(tail, name);
      const toHead = chain.length > 1 ? affinity(head, name) : -1;
      const end = Math.max(toTail, toHead);
      const all = toPlaced.get(name) as number;
      if (end > pick.end || (end === pick.end && all > pick.all)) pick = { i, end, all, atHead: toHead > toTail };
    });
    const placed = left.splice(pick.i, 1)[0];
    if (pick.atHead) chain.unshift(placed);
    else chain.push(placed);
    for (const name of left) toPlaced.set(name, (toPlaced.get(name) as number) + affinity(placed, name));
  }
  return chain;
}

/** Expected island radius for a category of `pages` pages. */
export function clusterRadius(pages: number): number {
  return LAYOUT.clusterSpacing * Math.sqrt(Math.max(1, pages));
}

/**
 * Anchor points on a ring, in the given order, starting at the top and going
 * clockwise. Each island gets an arc as wide as it is (plus the gap), so big
 * and small islands sit the same distance apart. One category sits in the middle.
 */
export function categoryAnchors(sizes: number[]): Array<{ x: number; y: number }> {
  if (sizes.length === 0) return [];
  if (sizes.length === 1) return [{ x: 0, y: 0 }];
  const arcs = sizes.map((n) => 2 * clusterRadius(n) + LAYOUT.clusterGap);
  const total = arcs.reduce((s, a) => s + a, 0);
  const radius = Math.max(LAYOUT.minRingRadius, total / (2 * Math.PI));
  let walked = 0;
  return arcs.map((arc) => {
    const angle = -Math.PI / 2 + ((walked + arc / 2) / total) * 2 * Math.PI;
    walked += arc;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });
}

/** Start position of a page: inside its island, at a spot fixed by its id. */
export function seedPosition(id: string, anchor: { x: number; y: number }, islandRadius: number): { x: number; y: number } {
  const r = islandRadius * 0.85 * Math.sqrt(unitHash(id, 1));
  const a = 2 * Math.PI * unitHash(id, 2);
  return { x: anchor.x + r * Math.cos(a), y: anchor.y + r * Math.sin(a) };
}

/** Circle radius for a page, from its source count (as the old graph). */
export function nodeRadius(sourceCount: number): number {
  return Math.sqrt(Math.max(1, sourceCount)) * 4 + 2;
}

/** Line width in screen pixels: 1 + log2(1 + weight). */
export function edgeWidth(weight: number): number {
  return 1 + Math.log2(1 + Math.max(0, weight));
}

/** Charge per page: bigger pages push harder, leaving room for their labels. */
export function chargeStrength(radius: number): number {
  return LAYOUT.chargeBase + LAYOUT.chargePerRadius * radius;
}

export function linkDistance(sameCategory: boolean, radiusA: number, radiusB: number): number {
  return (sameCategory ? LAYOUT.linkDistance : LAYOUT.crossLinkDistance) + radiusA + radiusB;
}

/** As d3's default, weaker for pages with many lines, so hubs do not swing. */
export function linkStrength(sameCategory: boolean, degreeA: number, degreeB: number): number {
  const base = sameCategory ? LAYOUT.linkStrength : LAYOUT.crossLinkStrength;
  return base / Math.max(1, Math.min(degreeA, degreeB));
}

export function collideRadius(radius: number): number {
  return radius + LAYOUT.collidePadding;
}

export function warmupTicks(nodeCount: number): number {
  return nodeCount > LAYOUT.largeGraphNodes ? LAYOUT.warmupTicksLarge : LAYOUT.warmupTicks;
}

/** Canvas edges (screen pixels) covered by the legend, the side panel or the controls. */
export interface ViewInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The free part of the canvas: what is not under the legend or the panel. */
function freeArea(width: number, height: number, insets: ViewInsets): { w: number; h: number } {
  return { w: Math.max(80, width - insets.left - insets.right), h: Math.max(80, height - insets.top - insets.bottom) };
}

/**
 * The graph point to pass to centerAt (which puts it in the canvas middle)
 * so that graph point (px, py) lands in the middle of the free area at zoom k.
 */
export function centerFor(px: number, py: number, k: number, width: number, height: number, insets: ViewInsets): { x: number; y: number } {
  const free = freeArea(width, height, insets);
  return {
    x: px - (insets.left + free.w / 2 - width / 2) / k,
    y: py - (insets.top + free.h / 2 - height / 2) / k,
  };
}

/** Zoom and centre that fit a bounding box into the free area (zoomToFit with uneven edges). */
export function fitView(
  bbox: { x: [number, number]; y: [number, number] }, width: number, height: number, insets: ViewInsets, maxZoom = 4
): { k: number; x: number; y: number } {
  const free = freeArea(width, height, insets);
  const k = Math.min(maxZoom, free.w / Math.max(1, bbox.x[1] - bbox.x[0]), free.h / Math.max(1, bbox.y[1] - bbox.y[0]));
  return { k, ...centerFor((bbox.x[0] + bbox.x[1]) / 2, (bbox.y[0] + bbox.y[1]) / 2, k, width, height, insets) };
}
