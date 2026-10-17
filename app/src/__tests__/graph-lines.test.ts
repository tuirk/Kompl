/**
 * The graph's line encoding (lib/graph-line-style.ts, app/wiki/graph/
 * graph-lines.ts): grey tiers (typed, related and the accent reach 3:1 on the
 * canvas; plain links are deliberately fainter), arrows for
 * directed relations pointing the way the line reads, zigzags for
 * opposition, relation labels (never on plain links, capped, kept clear of
 * page names), and which lines take the pointer.
 */

import { describe, expect, it } from 'vitest';
import { newFrameState } from '../app/wiki/graph/graph-draw';
import { drawLineLabels, placeTurned } from '../app/wiki/graph/graph-line-labels';
import {
  beginLineFrame, lineMode, newLineFrame, paintLineShape, pointerAreaFor,
} from '../app/wiki/graph/graph-lines';
import { buildGraphModel, DEFAULT_FILTERS, filterGraph, type ModelLink, type ModelNode } from '../lib/graph-model';
import { buildMissingLayer, withMissing } from '../lib/graph-missing';
import { buildLineStyles, LINE_LABELS_MAX, lineLabelText, lineStyle, turnedHalfExtents, uprightAngle, zigzagSteps } from '../lib/graph-line-style';
import { addCircle, buildGrid, forcePlace, newLabelSpace, resetSpace } from '../lib/graph-labels';
import { ACCENT_HEX, CANVAS_BG, LINE_ALPHA, LINE_FADED, LINE_HEX } from '../lib/graph-palette';
import type { RelationEdge } from '../lib/relation-edges';
import type { WikiGraph, WikiGraphNode } from '../lib/wiki-graph';

function page(id: string): WikiGraphNode {
  return { id, label: id, group: 'entity', category: 'Crypto', source_count: 1, summary: null, last_updated: null, degree: 0 };
}
const rel = (source: string, target: string, type: string, direction: 'out' | 'in' = 'out'): RelationEdge =>
  ({ source, target, relations: [{ type, direction, source_count: 1 }], wikilink: false, weight: 1 });
const DATA: WikiGraph = {
  nodes: ['bitcoin', 'eth', 'pow', 'vilnius', 'zz'].map(page),
  links: [
    rel('bitcoin', 'pow', 'uses'), // Bitcoin uses proof of work
    rel('bitcoin', 'eth', 'competes_with'),
    rel('eth', 'pow', 'uses', 'in'), // stored from eth's side: pow is used by... read as "pow — Uses → eth"
    rel('pow', 'vilnius', 'related_to'),
    { source: 'vilnius', target: 'zz', relations: [], wikilink: true, weight: 0 },
  ],
  missing: [{ name: 'Satoshi', source_count: 2, page_ids: ['bitcoin'] }],
};
const model = buildGraphModel(DATA);
const lineOf = (a: string, b: string) => model.links.find((l) => l.a === a && l.b === b) as ModelLink;

/** Contrast ratio of `hex` at `alpha` over the canvas (WCAG relative luminance). */
function contrast(hex: string, alpha: number): number {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (c: number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const bg = rgb(CANVAS_BG);
  const fg = rgb(hex).map((v, i) => Math.round(alpha * v + (1 - alpha) * bg[i]));
  return (lum(fg) + 0.05) / (lum(bg) + 0.05);
}

/** A canvas context that records what is drawn. */
function fakeCtx() {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const ctx = {
    calls, font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: 'left', textBaseline: 'top',
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'), closePath: rec('closePath'),
    fill: rec('fill'), stroke: rec('stroke'), save: rec('save'), restore: rec('restore'), translate: rec('translate'),
    rotate: rec('rotate'), scale: rec('scale'), roundRect: rec('roundRect'), fillText: rec('fillText'), setLineDash: rec('setLineDash'),
    measureText: (t: string) => ({ width: t.length * 6 }),
  };
  return ctx as unknown as CanvasRenderingContext2D & { calls: typeof calls };
}

/** Puts a line's two pages at fixed spots and swaps ids for nodes, as force-graph does. */
function place(l: ModelLink, ax: number, ay: number, bx: number, by: number): ModelLink {
  const [a, b] = [model.byId.get(l.a) as ModelNode, model.byId.get(l.b) as ModelNode];
  Object.assign(a, { x: ax, y: ay });
  Object.assign(b, { x: bx, y: by });
  l.source = a;
  l.target = b;
  return l;
}

function frameAt(scale: number) {
  const f = newFrameState('sans-serif', 'sans-serif');
  Object.assign(f, { scale, minX: -10_000, minY: -10_000, maxX: 10_000, maxY: 10_000 });
  return f;
}

describe('line tiers', () => {
  it('reach 3:1 against the canvas for typed and "related to" lines and the accent', () => {
    expect(contrast(LINE_HEX, LINE_ALPHA.typed)).toBeGreaterThanOrEqual(3);
    expect(contrast(LINE_HEX, LINE_ALPHA.related)).toBeGreaterThanOrEqual(3);
    expect(contrast(ACCENT_HEX, 1)).toBeGreaterThanOrEqual(3);
  });

  it('keep plain links deliberately faint (optional, off by default): below "related to", above faded', () => {
    expect(LINE_ALPHA.typed).toBeGreaterThan(LINE_ALPHA.related);
    expect(LINE_ALPHA.related).toBeGreaterThan(LINE_ALPHA.plain);
    expect(LINE_ALPHA.plain).toBeGreaterThan(LINE_FADED);
  });
});

describe('lineStyle', () => {
  it('gives directed relations an arrow pointing the way the line reads', () => {
    expect(lineStyle(lineOf('bitcoin', 'pow'))).toEqual({ shape: 'arrow', from: 'bitcoin', to: 'pow', label: 'uses' });
    // Stored from eth's side as "in": proof of work uses Ethereum, so the arrow points at eth.
    expect(lineStyle(lineOf('eth', 'pow'))).toEqual({ shape: 'arrow', from: 'pow', to: 'eth', label: 'uses' });
  });

  it('gives opposition a zigzag, "related to" a straight line, and a plain link no label', () => {
    expect(lineStyle(lineOf('bitcoin', 'eth'))).toMatchObject({ shape: 'zigzag', label: 'competes with' });
    expect(lineStyle(lineOf('pow', 'vilnius'))).toMatchObject({ shape: 'straight', label: 'related' });
    expect(lineStyle(lineOf('vilnius', 'zz'))).toMatchObject({ shape: 'straight', label: null });
    expect(lineLabelText('part_of', 'in')).toBe('includes');
    expect(lineLabelText('created_by', 'out')).toBe('created by');
    expect(lineLabelText('influenced_by', 'out')).toBe('influenced by');
  });

  it('draws zigzags and arrows in their own mode, everything else as force-graph does', () => {
    const styles = buildLineStyles(model.links);
    expect(lineMode(styles.get(lineOf('bitcoin', 'eth')))).toBe('replace');
    expect(lineMode(styles.get(lineOf('bitcoin', 'pow')))).toBe('after');
    expect(lineMode(styles.get(lineOf('pow', 'vilnius')))).toBeUndefined();
    expect(lineMode(undefined)).toBeUndefined();
  });

  it('keeps labels upright and zigzags even', () => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [-1, -1], [1, -1]]) {
      const a = uprightAngle(dx, dy);
      expect(a).toBeGreaterThanOrEqual(-Math.PI / 2);
      expect(a).toBeLessThanOrEqual(Math.PI / 2);
    }
    expect(uprightAngle(-1, 0)).toBeCloseTo(0);
    expect(zigzagSteps(100, 2) % 2).toBe(0);
    expect(zigzagSteps(1, 2)).toBe(2);
    expect(turnedHalfExtents(10, 2, Math.PI / 2)).toEqual({ hx: expect.closeTo(1), hy: expect.closeTo(5) });
  });
});

describe('paintLineShape', () => {
  const styles = buildLineStyles(model.links);

  it('draws the arrowhead at the edge of the circle it points to, and none on a short line', () => {
    const l = place(lineOf('bitcoin', 'pow'), 0, 0, 200, 0);
    const ctx = fakeCtx();
    paintLineShape(ctx, l, styles.get(l)!, '#fff', frameAt(1));
    const tip = ctx.calls.find((c) => c[0] === 'moveTo') as [string, number, number];
    const pow = model.byId.get('pow') as ModelNode;
    expect(tip[1]).toBeCloseTo(200 - pow.radius - 2);
    expect(ctx.calls.filter((c) => c[0] === 'fill')).toHaveLength(1);
    const short = fakeCtx();
    paintLineShape(short, place(l, 0, 0, 30, 0), styles.get(l)!, '#fff', frameAt(1));
    expect(short.calls).toHaveLength(0);
  });

  it('points back along the line when the line reads from its target', () => {
    const l = place(lineOf('eth', 'pow'), 0, 0, 200, 0); // reads pow -> eth: eth is the source end
    const ctx = fakeCtx();
    paintLineShape(ctx, l, styles.get(l)!, '#fff', frameAt(1));
    const tip = ctx.calls.find((c) => c[0] === 'moveTo') as [string, number, number];
    expect(tip[1]).toBeCloseTo((model.byId.get('eth') as ModelNode).radius + 2);
  });

  it('zigzags a long opposition line and keeps a short one straight', () => {
    const l = place(lineOf('bitcoin', 'eth'), 0, 0, 300, 0);
    const ctx = fakeCtx();
    paintLineShape(ctx, l, styles.get(l)!, '#fff', frameAt(1));
    const ys = ctx.calls.filter((c) => c[0] === 'lineTo').map((c) => c[2] as number);
    expect(ys.some((y) => y > 0) && ys.some((y) => y < 0)).toBe(true);
    const short = fakeCtx();
    paintLineShape(short, place(l, 0, 0, 30, 0), styles.get(l)!, '#fff', frameAt(1));
    expect(short.calls.filter((c) => c[0] === 'lineTo').every((c) => c[2] === 0)).toBe(true);
  });
});

describe('drawLineLabels', () => {
  const styles = buildLineStyles(model.links);
  const space = () => {
    const s = newLabelSpace(20, 20 + LINE_LABELS_MAX);
    resetSpace(s, -1000, -1000, 1000, 1000, 64, -Infinity, Infinity);
    buildGrid(s);
    return s;
  };
  const texts = (ctx: ReturnType<typeof fakeCtx>) => ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);

  it('names the lines in focus, never a plain link', () => {
    const lines = [place(lineOf('bitcoin', 'pow'), 0, 0, 200, 0), place(lineOf('vilnius', 'zz'), 0, 100, 200, 100)];
    const ctx = fakeCtx();
    const lf = newLineFrame('sans-serif');
    beginLineFrame(lf, 1);
    drawLineLabels(ctx, model.links, styles, new Set(lines), lf, frameAt(1), space());
    expect(texts(ctx)).toEqual(['uses']);
  });

  it('names typed lines only when zoomed in with nothing in focus', () => {
    place(lineOf('bitcoin', 'pow'), 0, 0, 200, 0);
    place(lineOf('bitcoin', 'eth'), 0, 0, 0, 200);
    // Typed lines bitcoin-pow, bitcoin-eth and eth-pow are all long here; the related line is never named by zoom.
    for (const [scale, expected] of [[1, 0], [2.2, 3]] as const) {
      const ctx = fakeCtx();
      const lf = newLineFrame('sans-serif');
      beginLineFrame(lf, scale);
      drawLineLabels(ctx, model.links, styles, null, lf, frameAt(scale), space());
      expect(texts(ctx)).toHaveLength(expected);
      expect(texts(ctx)).not.toContain('related');
    }
  });

  it('gives way to page names', () => {
    const l = place(lineOf('bitcoin', 'pow'), 0, 0, 200, 0);
    const s = space();
    forcePlace(s, 0, -20, 200, 20); // a page name over the whole line
    const ctx = fakeCtx();
    const lf = newLineFrame('sans-serif');
    beginLineFrame(lf, 1);
    drawLineLabels(ctx, model.links, styles, new Set([l]), lf, frameAt(1), s);
    expect(texts(ctx)).toHaveLength(0);
  });
});

describe('pointerAreaFor', () => {
  it('leaves force-graph its own pointer areas below the limit with no missing lines', () => {
    expect(pointerAreaFor(model.links, 8)).toBeUndefined();
  });

  it('skips gated and missing lines, painting typed ones', () => {
    const many = Array.from({ length: 3001 }, () => model.links).flat().slice(0, 3001);
    const painter = pointerAreaFor(many, 8);
    expect(painter).toBeDefined();
    const typedLine = place(lineOf('bitcoin', 'pow'), 0, 0, 100, 0);
    const plainLine = place(lineOf('vilnius', 'zz'), 0, 0, 100, 0);
    for (const [line, painted] of [[typedLine, true], [plainLine, false]] as const) {
      const ctx = fakeCtx();
      painter?.(line, '#010203', ctx, 1);
      expect(ctx.calls.some((c) => c[0] === 'stroke')).toBe(painted);
    }
    const layer = buildMissingLayer(buildGraphModel(DATA));
    const shown = withMissing(filterGraph(buildGraphModel(DATA), DEFAULT_FILTERS), layer);
    const missingPainter = pointerAreaFor(shown.links, 8);
    expect(missingPainter).toBeDefined();
    const missingLine = [...layer.linksOf.values()][0][0];
    missingLine.source = layer.nodes[0];
    missingLine.target = model.byId.get('bitcoin') as ModelNode;
    const ctx = fakeCtx();
    missingPainter?.(missingLine, '#010203', ctx, 1);
    expect(ctx.calls).toHaveLength(0);
  });
});

describe('placeTurned', () => {
  const ends = { s: { x: 0, y: -100 }, t: { x: 0, y: 100 } };
  const spaceWith = (circles: Array<[number, number, number]>) => {
    const s = newLabelSpace(10, 10);
    resetSpace(s, -500, -500, 500, 500, 64);
    for (const [x, y, r] of circles) addCircle(s, x, y, r);
    buildGrid(s);
    return s;
  };
  // A vertical label 60 long and 14 high: its box is 14 x 60, its capsule the segment x=0, y in [-23, 23] padded by 7.
  const place = (s: ReturnType<typeof spaceWith>) => placeTurned(s, 0, 0, 0, 1, 30, 7, 7, 30, ends.s, ends.t);

  it('ignores circles its bounding box only reaches past the capsule, and the line’s own pages', () => {
    expect(place(spaceWith([[12, 29, 4]]))).toBe(true); // touches the box corner area, clear of the capsule
    expect(place(spaceWith([[0, -100, 90], [0, 100, 90]]))).toBe(true); // the line's own two circles
  });

  it('is blocked by another circle on the label, or a placed box', () => {
    expect(place(spaceWith([[5, 10, 4]]))).toBe(false);
    const s = spaceWith([]);
    forcePlace(s, -3, -3, 3, 3);
    expect(place(s)).toBe(false);
  });
});

it('names a line in focus even when it is shorter than its label', () => {
  const styles = buildLineStyles(model.links);
  const l = place(lineOf('bitcoin', 'pow'), 0, 0, 30, 0);
  const s = newLabelSpace(20, 20);
  resetSpace(s, -1000, -1000, 1000, 1000, 64);
  buildGrid(s);
  const ctx = fakeCtx();
  const lf = newLineFrame('sans-serif');
  beginLineFrame(lf, 1);
  drawLineLabels(ctx, model.links, styles, new Set([l]), lf, frameAt(1), s);
  expect(ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1])).toEqual(['uses']);
});

it('still names zoomed-in typed lines when missing pages are shown (their lines come last)', () => {
  const styles = buildLineStyles(model.links);
  place(lineOf('bitcoin', 'pow'), 0, 0, 200, 0);
  place(lineOf('bitcoin', 'eth'), 0, 0, 0, 200);
  const layer = buildMissingLayer(model);
  const shown = withMissing(filterGraph(model, DEFAULT_FILTERS), layer);
  expect(shown.links[shown.links.length - 1]).toMatchObject({ missing: true, kind: 'related' });
  const s = newLabelSpace(20, 20 + LINE_LABELS_MAX);
  resetSpace(s, -1000, -1000, 1000, 1000, 64);
  buildGrid(s);
  const ctx = fakeCtx();
  const lf = newLineFrame('sans-serif');
  beginLineFrame(lf, 2.2);
  drawLineLabels(ctx, shown.links, styles, null, lf, frameAt(2.2), s);
  const names = ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  expect(names.length).toBeGreaterThanOrEqual(2);
  expect(names).toContain('uses');
});

it('ends an arrowhead outside the selection or hover ring of a picked page', () => {
  const styles = buildLineStyles(model.links);
  const l = place(lineOf('bitcoin', 'pow'), 0, 0, 200, 0);
  const pow = model.byId.get('pow') as ModelNode;
  const tipX = (picked: ReadonlySet<string> | null) => {
    const ctx = fakeCtx();
    paintLineShape(ctx, l, styles.get(l)!, '#fff', frameAt(1), picked);
    return (ctx.calls.find((c) => c[0] === 'moveTo') as [string, number])[1];
  };
  expect(tipX(null)).toBeCloseTo(200 - pow.radius - 2);
  expect(tipX(new Set(['pow']))).toBeCloseTo(200 - pow.radius - 6.5 - 2);
  expect(tipX(new Set(['bitcoin']))).toBeCloseTo(200 - pow.radius - 2); // only the page it points at matters
});

describe('growing with zoom', () => {
  const styles = buildLineStyles(model.links);

  it('grows the arrowhead with the line growth factor, keeping its tip outside the circle', () => {
    const l = place(lineOf('bitcoin', 'pow'), 0, 0, 400, 0);
    const pow = model.byId.get('pow') as ModelNode;
    const k = 3;
    const ctx = fakeCtx();
    paintLineShape(ctx, l, styles.get(l)!, '#fff', frameAt(k));
    const tip = ctx.calls.find((c) => c[0] === 'moveTo') as [string, number, number];
    const base = ctx.calls.find((c) => c[0] === 'lineTo') as [string, number, number];
    expect(tip[1]).toBeCloseTo(400 - pow.radius - 2 / k);
    expect(tip[1] - base[1]).toBeCloseTo((7 * Math.SQRT2) / k); // 7 px x sqrt(3 / 1.5)
  });

  it('grows a zigzag line and the pointer area with the zoom', () => {
    const z = place(lineOf('bitcoin', 'eth'), 0, 0, 600, 0);
    const ctx = fakeCtx() as ReturnType<typeof fakeCtx> & { lineWidth: number };
    paintLineShape(ctx, z, styles.get(z)!, '#fff', frameAt(6));
    expect(ctx.lineWidth).toBeCloseTo((z.width * 1.9) / 6);
    const many = Array.from({ length: 3001 }, () => model.links).flat().slice(0, 3001);
    const painter = pointerAreaFor(many, 8);
    const typedLine = place(lineOf('bitcoin', 'pow'), 0, 0, 100, 0);
    const hit = fakeCtx() as ReturnType<typeof fakeCtx> & { lineWidth: number };
    painter?.(typedLine, '#010203', hit, 6);
    expect(hit.lineWidth).toBeCloseTo((typedLine.width * 1.9 + 8 + 2) / 6);
  });

  it('draws a larger label pill when zoomed in, in screen pixels', () => {
    const l = place(lineOf('bitcoin', 'pow'), 0, 0, 1000, 0);
    const pill = (k: number) => {
      const s = newLabelSpace(20, 20);
      resetSpace(s, -2000, -2000, 2000, 2000, 64);
      buildGrid(s);
      const ctx = fakeCtx();
      const lf = newLineFrame('sans-serif');
      beginLineFrame(lf, k);
      drawLineLabels(ctx, model.links, styles, new Set([l]), lf, frameAt(k), s);
      return ctx.calls.find((c) => c[0] === 'roundRect') as [string, number, number, number, number];
    };
    const [, , , w1, h1] = pill(1);
    const [, , , w4, h4] = pill(4);
    expect([w1, h1]).toEqual(['uses'.length * 6 + 10, 14]); // 10 px text: width + padding, 14 px high
    expect(w4).toBeCloseTo(w1 * 1.4); // 14 px at zoom 4
    expect(h4).toBeCloseTo(h1 * 1.4);
  });
});
