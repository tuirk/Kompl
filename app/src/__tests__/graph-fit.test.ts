/**
 * Fitting the graph with its names (lib/graph-fit.ts): names and island
 * titles are screen pixels, so the fit leaves room for them inside the free
 * area between the legend and the side panel.
 */

import { describe, expect, it } from 'vitest';
import { fitItemsFor, fitWithNames, pagesFitKey, type FitItem } from '../lib/graph-fit';
import { fitView, type ViewInsets } from '../lib/graph-layout';

const W = 1280;
const H = 700;
const INSETS: ViewInsets = { left: 268, right: 424, top: 44, bottom: 40 };
const dot = (x: number, y: number, reach: Partial<FitItem> = {}): FitItem => ({ x, y, r: 5, left: 0, right: 0, up: 0, down: 0, ...reach });

/** Where an item's screen box lands for a view (force-graph puts view.x, view.y at the canvas middle). */
function screenBox(it: FitItem, v: { x: number; y: number; k: number }) {
  const sx = W / 2 + (it.x - v.x) * v.k;
  const sy = H / 2 + (it.y - v.y) * v.k;
  return {
    left: sx - Math.max(it.r * v.k, it.left), right: sx + Math.max(it.r * v.k, it.right),
    top: sy - Math.max(it.r * v.k, it.up), bottom: sy + Math.max(it.r * v.k, it.down),
  };
}

describe('fitWithNames', () => {
  it('keeps a wide island title at the left edge clear of the legend', () => {
    const items = [dot(-400, 0, { left: 110, right: 110, up: 20 }), dot(400, 0), dot(0, -300), dot(0, 300, { down: 18, left: 40, right: 40 })];
    const v = fitWithNames(items, W, H, INSETS)!;
    for (const it of items) {
      const box = screenBox(it, v);
      expect(box.left).toBeGreaterThanOrEqual(INSETS.left - 0.5);
      expect(box.right).toBeLessThanOrEqual(W - INSETS.right + 0.5);
      expect(box.top).toBeGreaterThanOrEqual(INSETS.top - 0.5);
      expect(box.bottom).toBeLessThanOrEqual(H - INSETS.bottom + 0.5);
    }
    // Circles alone would zoom in further and push the title under the legend.
    const circles = fitView({ x: [-405, 405], y: [-305, 305] }, W, H, INSETS);
    expect(v.k).toBeLessThan(circles.k);
    expect(screenBox(items[0], circles).left).toBeLessThan(INSETS.left);
  });

  it('fills the free area: a side of the names touches its edge', () => {
    const items = [dot(-200, 0, { left: 60 }), dot(200, 0, { right: 60 })];
    const v = fitWithNames(items, W, H, INSETS)!;
    expect(screenBox(items[0], v).left).toBeCloseTo(INSETS.left, 0);
    expect(screenBox(items[1], v).right).toBeCloseTo(W - INSETS.right, 0);
  });

  it('zooms in no further than the cap, and gives up when the names alone are wider than the free area', () => {
    expect(fitWithNames([dot(0, 0)], W, H, INSETS, 2.5)?.k).toBe(2.5);
    expect(fitWithNames([dot(0, 0, { left: 400, right: 400 })], W, H, INSETS)).toBeNull();
    expect(fitWithNames([], W, H, INSETS)).toBeNull();
  });
});

describe('pagesFitKey', () => {
  const base = { showSources: false, hiddenCategories: new Set<string>(), hiddenTypes: new Set<string>() };

  it('changes when a topic, a page type, source pages or missing names change what the map shows', () => {
    const key = pagesFitKey(base, false);
    expect(pagesFitKey({ ...base, hiddenCategories: new Set(['Travel']) }, false)).not.toBe(key);
    expect(pagesFitKey({ ...base, hiddenTypes: new Set(['concept']) }, false)).not.toBe(key);
    expect(pagesFitKey({ ...base, showSources: true }, false)).not.toBe(key);
    expect(pagesFitKey(base, true)).not.toBe(key);
  });

  it('ignores the order topics were hidden in', () => {
    expect(pagesFitKey({ ...base, hiddenCategories: new Set(['A', 'B']) }, false))
      .toBe(pagesFitKey({ ...base, hiddenCategories: new Set(['B', 'A']) }, false));
  });
});

describe('fitItemsFor', () => {
  const node = (id: string, x: number, y: number, catIndex: number, extra: { missing?: boolean } = {}) =>
    ({ id, x, y, radius: 6, shortLabel: id, catIndex, ...extra });

  it('gives each page its name under it, measured or estimated from its length', () => {
    const items = fitItemsFor([node('Vilnius', 0, 0, 0), node('Kaunas', 50, 0, 0)], ['TRAVEL'], new Map([['Vilnius', 40]]), [NaN]);
    expect(items[0]).toMatchObject({ x: 0, y: 0, r: 6, left: 20, right: 20, down: 22 });
    expect(items[1].left).toBeCloseTo(('Kaunas'.length * 6.6) / 2);
  });

  it('adds each island title above its topmost page, centred over the island; missing names make none', () => {
    const items = fitItemsFor(
      [node('a', 0, 10, 0), node('b', 100, -20, 0), node('m', 900, 900, 1, { missing: true })],
      ['TRAVEL', 'CRYPTO'], new Map(), [80, NaN]
    );
    expect(items).toHaveLength(4);
    expect(items[3]).toMatchObject({ x: 50, y: -26, r: 0, left: 44, right: 44, up: 24 });
  });
});
