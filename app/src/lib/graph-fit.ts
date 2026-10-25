/**
 * Fitting the knowledge graph so its names fit too. A page's circle grows
 * with the zoom, but its name and its island's title are drawn in screen
 * pixels, so fitting the circles alone (force-graph's bounding box) leaves
 * the names at the map's edges under the legend or the side panel, or off
 * the canvas. fitWithNames finds the largest zoom at which every circle and
 * the screen-pixel box around it fit into the free area. Pure.
 */

import { centerFor, type GraphView, type ViewInsets } from './graph-layout';

/** Something to keep in view: a point with a radius in graph units and a reach in screen pixels on each side. */
export interface FitItem {
  x: number;
  y: number;
  /** Graph units: the circle, which grows with the zoom. */
  r: number;
  /** Screen pixels past the circle's centre: a name or island title. */
  left: number;
  right: number;
  up: number;
  down: number;
}

/** Steps of the zoom search; 40 halvings are far below a pixel. */
const SEARCH_STEPS = 40;
const MIN_ZOOM = 0.01;

/** The screen span [min, max] of the items along one axis at zoom k, from the axis origin. */
function span(items: readonly FitItem[], k: number, axis: 'x' | 'y'): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const it of items) {
    const c = (axis === 'x' ? it.x : it.y) * k;
    const r = it.r * k;
    const a = c - Math.max(r, axis === 'x' ? it.left : it.up);
    const b = c + Math.max(r, axis === 'x' ? it.right : it.down);
    if (a < lo) lo = a;
    if (b > hi) hi = b;
  }
  return [lo, hi];
}

/**
 * The view that fits every item, names included, into the free area
 * (width x height less `insets`), zoomed in no further than `maxZoom`;
 * null when there is nothing to fit or the names alone are wider than the
 * free area (the caller then fits the circles only).
 */
export function fitWithNames(
  items: readonly FitItem[], width: number, height: number, insets: ViewInsets, maxZoom = 4
): GraphView | null {
  if (items.length === 0) return null;
  const freeW = Math.max(80, width - insets.left - insets.right);
  const freeH = Math.max(80, height - insets.top - insets.bottom);
  const fits = (k: number) => {
    const [x0, x1] = span(items, k, 'x');
    const [y0, y1] = span(items, k, 'y');
    return x1 - x0 <= freeW && y1 - y0 <= freeH;
  };
  if (!fits(MIN_ZOOM)) return null;
  // The spans are convex in k, so the zooms that fit run from the smallest up to one largest.
  let k = maxZoom;
  if (!fits(maxZoom)) {
    let lo = MIN_ZOOM;
    let hi = maxZoom;
    for (let i = 0; i < SEARCH_STEPS; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    k = lo;
  }
  const [x0, x1] = span(items, k, 'x');
  const [y0, y1] = span(items, k, 'y');
  return { k, ...centerFor((x0 + x1) / 2 / k, (y0 + y1) / 2 / k, k, width, height, insets) };
}

/**
 * The part of the legend's state that changes which pages the map shows
 * (topics, page types, source pages, missing names): the map fits again
 * when it changes, as when a focus changes. Lines and archived pages are
 * left out: showing lines moves no page, and archived pages reload the map,
 * which keeps the viewer's view.
 */
export function pagesFitKey(
  filters: { showSources: boolean; hiddenCategories: ReadonlySet<string>; hiddenTypes: ReadonlySet<string> },
  showMissing: boolean
): string {
  const sorted = (set: ReadonlySet<string>) => [...set].sort().join('\u0001');
  return [filters.showSources ? 's' : '', showMissing ? 'm' : '', sorted(filters.hiddenCategories), sorted(filters.hiddenTypes)].join('\u0002');
}

/** A page name sits under its circle: the circle's gap plus a line of 12 px text. */
const NAME_DOWN_PX = 22;
/** Rough on-screen widths for text not measured yet (12 px names; 13 px bold capitals, spaced, for titles). */
const NAME_CHAR_PX = 6.6;
const TITLE_CHAR_PX = 10;
/** An island's title sits above its topmost page. */
const TITLE_UP_PX = 24;

/** The bits of a page the fit reads. */
interface FitNode {
  id: string;
  x: number;
  y: number;
  radius: number;
  shortLabel: string;
  catIndex: number;
  missing?: boolean;
}

/**
 * What a fit keeps in view (graph-draw.ts, graph-islands.ts): each page's
 * circle with its name under it (`nameWidths`: measured screen widths, by
 * page id), and each island's title above its topmost page, centred over
 * the island (`titleWidths` by category index, NaN until measured). Names
 * not measured yet are estimated from their length.
 */
export function fitItemsFor(
  nodes: readonly FitNode[], titles: readonly string[],
  nameWidths: ReadonlyMap<string, number>, titleWidths: ArrayLike<number>
): FitItem[] {
  const items: FitItem[] = [];
  const count = new Array<number>(titles.length).fill(0);
  const sumX = new Array<number>(titles.length).fill(0);
  const top = new Array<number>(titles.length).fill(Infinity);
  for (const n of nodes) {
    const half = (nameWidths.get(n.id) ?? n.shortLabel.length * NAME_CHAR_PX) / 2;
    items.push({ x: n.x, y: n.y, r: n.radius, left: half, right: half, up: 0, down: NAME_DOWN_PX });
    if (n.missing || n.catIndex < 0 || n.catIndex >= titles.length) continue;
    count[n.catIndex] += 1;
    sumX[n.catIndex] += n.x;
    top[n.catIndex] = Math.min(top[n.catIndex], n.y - n.radius);
  }
  titles.forEach((title, i) => {
    if (count[i] === 0) return;
    const measured = titleWidths[i];
    const half = (Number.isNaN(measured) || measured === undefined ? title.length * TITLE_CHAR_PX : measured) / 2 + 4;
    items.push({ x: sumX[i] / count[i], y: top[i], r: 0, left: half, right: half, up: TITLE_UP_PX, down: 0 });
  });
  return items;
}
