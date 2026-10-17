/**
 * How the graph's text and lines grow with zoom (lib/graph-zoom.ts), the
 * layout's even 1.5x spread (lib/graph-layout.ts LAYOUT_SCALE), and when the
 * view fits itself (autoFit, pathKey).
 */

import { describe, expect, it } from 'vitest';
import { beginFrame, LABEL_PX, newFrameState } from '../app/wiki/graph/graph-draw';
import { beginLineFrame, newLineFrame } from '../app/wiki/graph/graph-lines';
import { autoFit, categoryAnchors, clusterRadius, LAYOUT, LAYOUT_SCALE, linkDistance } from '../lib/graph-layout';
import { buildGraphModel, DEFAULT_FILTERS, filterGraph } from '../lib/graph-model';
import { pathKey, shortestPath } from '../lib/graph-path';
import type { WikiGraph } from '../lib/wiki-graph';
import { LINE_PX } from '../lib/graph-line-style';
import { grownPx, LINE_GROWTH, LINE_LABEL_GROWTH, lineGrowth, NAME_GROWTH } from '../lib/graph-zoom';

describe('text growth', () => {
  it('keeps relation labels at 10 px up to zoom 2, then grows them to at most 16 px', () => {
    expect(LINE_LABEL_GROWTH.px).toBe(LINE_PX.labelFont);
    for (const k of [0.3, 1, 2]) expect(grownPx(LINE_LABEL_GROWTH, k)).toBe(10);
    expect(grownPx(LINE_LABEL_GROWTH, 2.5)).toBe(11); // 10 * sqrt(1.25) = 11.18, in half-pixel steps
    expect(grownPx(LINE_LABEL_GROWTH, 4)).toBe(14); // 14.14
    expect(grownPx(LINE_LABEL_GROWTH, 50)).toBe(16);
  });

  it('grows page names from 12 px a little earlier and further, so they stay the larger text', () => {
    expect(NAME_GROWTH.px).toBe(LABEL_PX);
    expect(grownPx(NAME_GROWTH, 1.6)).toBe(12);
    expect(grownPx(NAME_GROWTH, 4)).toBe(19); // 12 * sqrt(2.5) = 18.97
    expect(grownPx(NAME_GROWTH, 50)).toBe(20);
    for (let k = 0.5; k <= 12; k += 0.25) {
      expect(grownPx(NAME_GROWTH, k)).toBeGreaterThan(grownPx(LINE_LABEL_GROWTH, k));
      expect(grownPx(NAME_GROWTH, k) / NAME_GROWTH.px).toBeGreaterThanOrEqual(grownPx(LINE_LABEL_GROWTH, k) / LINE_LABEL_GROWTH.px - 0.05);
    }
  });

  it('steps in half pixels and never shrinks as you zoom in', () => {
    let last = 0;
    for (let k = 0.2; k <= 20; k *= 1.07) {
      const px = grownPx(LINE_LABEL_GROWTH, k);
      expect(px * 2).toBe(Math.round(px * 2));
      expect(px).toBeGreaterThanOrEqual(last);
      last = px;
    }
  });

  it('sets the frame fonts from the grown sizes, rebuilding a label font only when its size steps', () => {
    const ctx = { canvas: { width: 1000, height: 800 }, getTransform: () => ({ a: 4, d: 4, e: 0, f: 0 }) } as unknown as CanvasRenderingContext2D;
    const frame = newFrameState('Inter', 'Grotesk');
    beginFrame(frame, ctx, 4);
    expect(frame.namePx).toBe(19);
    expect(frame.nameScale).toBeCloseTo(19 / 12);
    // Screen pixels: names are drawn under scale(1/k), so the font is their true size.
    expect(frame.font).toBe('500 19px Inter');
    const nameFont = frame.font;
    beginFrame(frame, ctx, 4.05); // the same half-pixel step: the font is not rebuilt
    expect(frame.font).toBe(nameFont);
    const lf = newLineFrame('Inter');
    beginLineFrame(lf, 4);
    expect(lf.labelPx).toBe(14);
    expect(lf.font).toBe('500 14px Inter'); // screen pixels: labels are drawn in screen space
    const font = lf.font;
    beginLineFrame(lf, 4.05); // same half-pixel step
    expect(lf.font).toBe(font);
    expect(lf.grow).toBeCloseTo(lineGrowth(4.05));
  });
});

describe('line growth', () => {
  it('keeps widths, arrowheads and zigzags as drawn up to zoom 1.5, then grows them to at most x1.9', () => {
    expect(lineGrowth(1)).toBe(1);
    expect(lineGrowth(LINE_GROWTH.from)).toBe(1);
    expect(lineGrowth(3)).toBeCloseTo(Math.SQRT2);
    expect(lineGrowth(100)).toBe(LINE_GROWTH.max);
    expect(LINE_GROWTH.max).toBeGreaterThanOrEqual(1.8);
    expect(LINE_GROWTH.max).toBeLessThanOrEqual(2);
  });
});

describe('layout spread', () => {
  it('makes every length 1.5x and charge 1.5x squared, so the map spreads evenly', () => {
    expect(LAYOUT_SCALE).toBe(1.5);
    expect(LAYOUT.linkDistance).toBe(51);
    expect(LAYOUT.crossLinkDistance).toBe(165);
    expect(LAYOUT.chargeBase).toBeCloseTo(-67.5);
    expect(LAYOUT.chargeDistanceMax).toBe(420);
    expect(LAYOUT.collidePadding).toBe(15);
    expect(linkDistance(true, 6, 6)).toBe(51 + 12);
    expect(clusterRadius(25)).toBeCloseTo(33 * 5);
    // The island ring keeps islands apart in proportion.
    const ring = categoryAnchors([25, 9]);
    expect(Math.hypot(ring[0].x - ring[1].x, ring[0].y - ring[1].y)).toBeGreaterThan(2 * LAYOUT.minRingRadius - 1);
  });
});

describe('automatic fits', () => {
  it('fits only when armed, drawn and not moved by the viewer since', () => {
    expect(autoFit(true, false, 48)).toBe('fit');
    expect(autoFit(true, true, 48)).toBe('drop'); // the viewer zoomed, panned or dragged: their view wins
    expect(autoFit(true, false, 0)).toBe('wait'); // nothing drawn yet: keep it armed
    expect(autoFit(false, false, 48)).toBe('none');
    expect(autoFit(false, true, 48)).toBe('none');
  });

  it('keys a found path by its pages, so a filter change that rebuilds it does not fit it again', () => {
    const data: WikiGraph = {
      nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, group: 'entity', category: 'AI', source_count: 1, summary: null, last_updated: null, degree: 0 })),
      links: [
        { source: 'a', target: 'b', relations: [{ type: 'uses', direction: 'out', source_count: 1 }], wikilink: false, weight: 1 },
        { source: 'b', target: 'c', relations: [{ type: 'uses', direction: 'out', source_count: 1 }], wikilink: false, weight: 1 },
        { source: 'c', target: 'd', relations: [], wikilink: true, weight: 0 },
      ],
      missing: [],
    };
    const model = buildGraphModel(data);
    const before = shortestPath(filterGraph(model, DEFAULT_FILTERS), 'a', 'c');
    const after = shortestPath(filterGraph(model, { ...DEFAULT_FILTERS, showPlain: true }), 'a', 'c');
    expect(after).not.toBe(before); // a new object after the toggle...
    expect(pathKey(after)).toBe(pathKey(before)); // ...with the same pages: no new fit
    expect(pathKey(before)).not.toBe('');
    expect(pathKey(null)).toBe('');
    expect(pathKey(shortestPath(filterGraph(model, { ...DEFAULT_FILTERS, showPlain: true }), 'a', 'd'))).not.toBe(pathKey(before));
  });
});
