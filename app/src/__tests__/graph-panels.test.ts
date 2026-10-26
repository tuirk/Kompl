/**
 * The graph page's resizable legend and details panel (lib/graph-panels.ts):
 * limits, arrow-key steps, stored sizes that may be missing or corrupt, and
 * the free part of the canvas the map fits into for any sizes, and whether
 * the legend is expanded (collapsed on a first visit).
 */

import { describe, expect, it } from 'vitest';
import { fitView, panView, recentrePan } from '../lib/graph-layout';
import {
  canvasInsets, clampLegend, clampPanel, clampSizes, DEFAULT_SIZES, FILTERS_BUTTON_HEIGHT, LEGEND_MAX_WIDTH, LEGEND_MIN, LEGEND_OPEN_KEY, LEGEND_TOP,
  PANEL_MIN_WIDTH, parseSizes, readStoredOpen, RESIZE_STEP, resizeStep, serializeSizes, writeStoredOpen,
} from '../lib/graph-panels';

describe('limits', () => {
  it('keeps the legend between 200 x 160 and 420 x (canvas height - 32)', () => {
    expect(clampLegend({ width: 50, height: 20 }, 900)).toEqual({ width: LEGEND_MIN.width, height: LEGEND_MIN.height });
    expect(clampLegend({ width: 9000, height: 9000 }, 900)).toEqual({ width: LEGEND_MAX_WIDTH, height: 868 });
    expect(clampLegend({ width: 300, height: null }, 900)).toEqual({ width: 300, height: null });
    // A canvas shorter than the minimum still gives the minimum, never a negative size.
    expect(clampLegend({ width: 300, height: 500 }, 100).height).toBe(LEGEND_MIN.height);
  });

  it('keeps the details panel between 300 px and half the canvas', () => {
    expect(clampPanel(100, 1600)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanel(1200, 1600)).toBe(800);
    expect(clampPanel(500, 1600)).toBe(500);
    expect(clampPanel(500, 400)).toBe(PANEL_MIN_WIDTH); // a narrow window: the minimum wins
    expect(clampSizes({ legend: { width: 999, height: 999 }, panel: 999 }, 1000, 600)).toEqual({
      legend: { width: 420, height: 568 }, panel: 500,
    });
  });
});

describe('keyboard', () => {
  it('moves a grip 16 px per arrow key; the panel widens to the left', () => {
    expect(resizeStep('ArrowRight', 'legend')).toEqual([RESIZE_STEP, 0]);
    expect(resizeStep('ArrowDown', 'legend')).toEqual([0, RESIZE_STEP]);
    expect(resizeStep('ArrowUp', 'legend')).toEqual([0, -RESIZE_STEP]);
    expect(resizeStep('ArrowLeft', 'panel')).toEqual([RESIZE_STEP, 0]);
    expect(resizeStep('ArrowRight', 'panel')).toEqual([-RESIZE_STEP, 0]);
    expect(resizeStep('ArrowDown', 'panel')).toBeNull();
    expect(resizeStep('Enter', 'legend')).toBeNull();
  });
});

describe('stored sizes', () => {
  it('reads what it wrote', () => {
    const sizes = { legend: { width: 300, height: 500 }, panel: 420 };
    expect(parseSizes(serializeSizes(sizes))).toEqual(sizes);
  });

  it('falls back to the defaults for missing, corrupt or absurd values', () => {
    expect(parseSizes(null)).toEqual(DEFAULT_SIZES);
    expect(parseSizes('')).toEqual(DEFAULT_SIZES);
    expect(parseSizes('{not json')).toEqual(DEFAULT_SIZES);
    expect(parseSizes('42')).toEqual(DEFAULT_SIZES);
    expect(parseSizes('null')).toEqual(DEFAULT_SIZES);
    expect(parseSizes(JSON.stringify({ legend: { width: 'wide', height: -5 }, panel: 1e9 }))).toEqual(DEFAULT_SIZES);
    // Good parts survive next to bad ones.
    expect(parseSizes(JSON.stringify({ legend: { width: 310 }, panel: 'x' }))).toEqual({
      legend: { width: 310, height: null }, panel: DEFAULT_SIZES.panel,
    });
  });
});

describe('free area', () => {
  it('keeps the map clear of the legend and panel at their current sizes', () => {
    const [W, H] = [1600, 900];
    for (const [legendW, panelW] of [[236, 360], [400, 700], [200, 300]]) {
      const insets = canvasInsets(true, legendW, true, panelW);
      expect(insets.left).toBe(16 + legendW + 16);
      expect(insets.right).toBe(panelW + 64);
      const view = fitView({ x: [-300, 300], y: [-200, 200] }, W, H, insets);
      // The box's centre lands in the middle of the free area.
      const sx = W / 2 + (0 - view.x) * view.k;
      expect(sx).toBeCloseTo(insets.left + (W - insets.left - insets.right) / 2);
      // And the whole box fits between the legend and the panel.
      expect(sx - 300 * view.k).toBeGreaterThanOrEqual(insets.left - 0.001);
      expect(sx + 300 * view.k).toBeLessThanOrEqual(W - insets.right + 0.001);
    }
    expect(canvasInsets(false, 400, false, 700)).toEqual({ left: 24, top: 64, right: 64, bottom: 40 });
  });
});

describe('legend expanded or collapsed, kept per viewer', () => {
  function store(initial: Record<string, string> = {}, broken = false) {
    const data = new Map(Object.entries(initial));
    return () => ({
      getItem: (k: string) => { if (broken) throw new Error('denied'); return data.get(k) ?? null; },
      setItem: (k: string, v: string) => { if (broken) throw new Error('denied'); data.set(k, v); },
    });
  }

  it('starts collapsed on a first visit, then keeps what the viewer chose across a reload', () => {
    const s = store();
    expect(readStoredOpen(LEGEND_OPEN_KEY, s)).toBe(false); // first visit: the small "Filters" button
    writeStoredOpen(LEGEND_OPEN_KEY, true, s);
    expect(readStoredOpen(LEGEND_OPEN_KEY, s)).toBe(true); // reload: still expanded ('1')
    writeStoredOpen(LEGEND_OPEN_KEY, false, s);
    expect(readStoredOpen(LEGEND_OPEN_KEY, s)).toBe(false); // reload: still collapsed ('0')
    expect(readStoredOpen(LEGEND_OPEN_KEY, store({ [LEGEND_OPEN_KEY]: '1' }))).toBe(true);
    expect(readStoredOpen(LEGEND_OPEN_KEY, store({ [LEGEND_OPEN_KEY]: '0' }))).toBe(false);
  });

  it('collapses when storage is missing, corrupt or unavailable', () => {
    for (const bad of ['', 'yes?', 'true', 'open']) expect(readStoredOpen(LEGEND_OPEN_KEY, store({ [LEGEND_OPEN_KEY]: bad }))).toBe(false);
    expect(readStoredOpen(LEGEND_OPEN_KEY, store({}, true))).toBe(false);
    expect(() => writeStoredOpen(LEGEND_OPEN_KEY, true, store({}, true))).not.toThrow();
  });

  it('keeps the map clear of only the "Filters" button when collapsed, and of the panel when expanded', () => {
    const collapsed = canvasInsets(false, 236, false, 360);
    expect(collapsed).toEqual({ left: 24, top: LEGEND_TOP + FILTERS_BUTTON_HEIGHT + 16, right: 64, bottom: 40 });
    expect(collapsed.top).toBe(64);
    expect(canvasInsets(true, 236, false, 360)).toEqual({ left: 16 + 236 + 16, top: 44, right: 64, bottom: 40 });
    expect(canvasInsets(true, 400, true, 500)).toEqual({ left: 432, top: 44, right: 564, bottom: 40 });
  });

  it('fits the map with the restored state: a first visit fits into the larger, collapsed free area', () => {
    const [W, H] = [1600, 874];
    const bbox = { x: [-500, 500] as [number, number], y: [-450, 450] as [number, number] };
    const fitFor = (stored: Record<string, string>) => {
      const open = readStoredOpen(LEGEND_OPEN_KEY, store(stored));
      const insets = canvasInsets(open, 236, false, 360);
      return { insets, view: fitView(bbox, W, H, insets) };
    };
    const first = fitFor({});
    const collapsed = fitFor({ [LEGEND_OPEN_KEY]: '0' });
    const expanded = fitFor({ [LEGEND_OPEN_KEY]: '1' });
    expect(first).toEqual(collapsed);
    expect(collapsed.insets.left).toBe(24);
    expect(expanded.insets.left).toBe(16 + 236 + 16);
    // Collapsed: the map is centred further left, in the wider free area, and a wide map is drawn larger.
    // (The button keeps a band along the top, so a tall map gains no height.)
    const centre = (f: typeof collapsed) => W / 2 + (0 - f.view.x) * f.view.k;
    expect(centre(collapsed)).toBeLessThan(centre(expanded));
    expect(centre(collapsed)).toBeCloseTo(24 + (W - 24 - 64) / 2);
    const wide = { x: [-900, 900] as [number, number], y: [-100, 100] as [number, number] };
    expect(fitView(wide, W, H, collapsed.insets).k).toBeGreaterThan(fitView(wide, W, H, expanded.insets).k);
  });
});

describe('recentre when the filter panel changes (pan only, never after the viewer moved the map)', () => {
  const [W, H] = [1600, 874];
  const screenX = (graphX: number, v: { x: number; k: number }) => W / 2 + (graphX - v.x) * v.k;

  it('pans by half the change in the left edge, and not at all once the viewer has moved the map', () => {
    expect(recentrePan(24, 268, false)).toBe(122); // expand: right
    expect(recentrePan(268, 24, false)).toBe(-122); // collapse: back left
    expect(recentrePan(268, 332, false)).toBe(32); // the grip widens the panel by 64 px
    expect(recentrePan(268, 268, false)).toBe(0); // e.g. only the details panel changed
    for (const [from, to] of [[24, 268], [268, 24], [268, 332]]) expect(recentrePan(from, to, true)).toBe(0);
  });

  it('keeps a fitted map centred in the new free area, zoom unchanged, clear of the panel', () => {
    const bbox = { x: [-500, 500] as [number, number], y: [-450, 450] as [number, number] };
    const collapsed = canvasInsets(false, 236, false, 360);
    const expanded = canvasInsets(true, 236, false, 360);
    const fitted = fitView(bbox, W, H, collapsed);
    const moved = panView(fitted, recentrePan(collapsed.left, expanded.left, false));
    expect(moved.k).toBe(fitted.k);
    expect(moved.y).toBe(fitted.y);
    const freeCentre = expanded.left + (W - expanded.left - expanded.right) / 2; // 902
    expect(screenX(0, moved)).toBeCloseTo(freeCentre);
    expect(screenX(0, moved) - screenX(0, fitted)).toBeCloseTo(122);
    // The map fits the narrower free area across, so nothing is left under the panel.
    expect((bbox.x[1] - bbox.x[0]) * moved.k).toBeLessThanOrEqual(W - expanded.left - expanded.right);
    expect(screenX(bbox.x[0], moved)).toBeGreaterThanOrEqual(expanded.left - 0.001);
    // Collapsing again puts it back exactly.
    const back = panView(moved, recentrePan(expanded.left, collapsed.left, false));
    expect(back.x).toBeCloseTo(fitted.x);
    expect(back.k).toBe(fitted.k);
  });

  it('leaves a moved map exactly where the viewer put it', () => {
    const view = { x: 123, y: -45, k: 1.7 };
    expect(panView(view, recentrePan(24, 268, true))).toEqual(view);
  });
});
