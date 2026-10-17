/**
 * The order the knowledge graph names pages in (app/wiki/graph/graph-draw.ts
 * drawLabels): the page in focus and each island's top page choose first,
 * so lower-ranked names give way to them, and a crowded hub is still named.
 * Runs drawLabels against a recording stand-in for the canvas.
 */

import { describe, expect, it } from 'vitest';
import {
  beginFrame, drawLabels, newFrameState, newLabelBuffer, prepareLabels, type DrawView,
} from '../app/wiki/graph/graph-draw';
import type { ModelNode } from '../lib/graph-model';

/**
 * Records the names written, at their graph position (tracking translate and
 * scale, as names are drawn in screen space), with the font and the scale in
 * force; text is 6 px wide per character.
 */
function fakeCanvas() {
  const written: Array<{ text: string; x: number; y: number; font: string; scale: number }> = [];
  let m = { tx: 0, ty: 0, s: 1 };
  const stack: Array<typeof m> = [];
  const ctx = {
    canvas: { width: 2000, height: 2000 },
    font: '',
    getTransform: () => ({ a: 1, d: 1, e: 0, f: 0 }),
    measureText: (text: string) => ({ width: text.length * 6 }),
    fillText(text: string, x: number, y: number) {
      written.push({ text, x: m.tx + x * m.s, y: m.ty + y * m.s, font: this.font, scale: m.s });
    },
    save() { stack.push({ ...m }); },
    restore() { m = stack.pop() ?? { tx: 0, ty: 0, s: 1 }; },
    translate(x: number, y: number) { m = { ...m, tx: m.tx + x * m.s, ty: m.ty + y * m.s }; },
    scale(a: number) { m = { ...m, s: m.s * a }; },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeText() {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, written };
}

function page(id: string, x: number, y: number, radius = 6): ModelNode {
  return { id, x, y, radius, ring: false, archived: false, shortLabel: id.toUpperCase() } as ModelNode;
}

function draw(nodes: ModelNode[], order: ModelNode[], ranks: Record<string, number>) {
  const { ctx, written } = fakeCanvas();
  const frame = newFrameState('sans-serif', 'sans-serif');
  beginFrame(frame, ctx, 1);
  const buf = newLabelBuffer(nodes.length, 0);
  const view: DrawView = {
    highlight: null, selectedId: null, hoveredId: null, labelRank: new Map(Object.entries(ranks)), marked: null, bridges: new Set(),
  };
  prepareLabels(buf, nodes, frame, null);
  drawLabels(ctx, order, null, frame, view, buf);
  return written;
}

describe('drawLabels order', () => {
  it('lets an island’s top page choose before a more important page of another island', () => {
    // B0 tops island B; A1 is second in island A but comes earlier in the overall order.
    // A1's place below is blocked, and its place above is exactly B0's place below.
    const b0 = page('b0', 500, 500);
    const a1 = page('a1', 500, 532);
    const blocker = page('blocker', 500, 560);
    const a0 = page('a0', 1500, 1500);
    const written = draw([a0, a1, b0, blocker], [a0, a1, b0], { a0: 0, a1: 1, b0: 0 });
    const b0Name = written.find((w) => w.text === 'B0');
    const a1Name = written.find((w) => w.text === 'A1');
    expect(b0Name).toMatchObject({ x: 500, y: 500 + 9 + 1 }); // straight below B0 (gap 9, 1 px inset)
    expect(a1Name).toBeDefined();
    expect(a1Name?.y).not.toBe(b0Name?.y); // A1 gave way and went beside its circle
  });

  it('names a hub that is crowded on every side', () => {
    const hub = page('hub', 500, 500, 12);
    const crowd: ModelNode[] = [];
    for (let x = 300; x <= 700; x += 20) {
      for (let y = 300; y <= 700; y += 20) if (Math.hypot(x - 500, y - 500) > 30) crowd.push(page(`c${x}-${y}`, x, y, 8));
    }
    const ranks = Object.fromEntries(crowd.map((c) => [c.id, 5]));
    const written = draw([hub, ...crowd], [...crowd, hub], { ...ranks, hub: 0 });
    expect(written.some((w) => w.text === 'HUB')).toBe(true);
  });
});

describe('bridge badge', () => {
  it('widens the name by the badge, draws BRIDGE after it and restores the text style', () => {
    const { ctx, written } = fakeCanvas();
    const styled = ctx as unknown as { textAlign: string; fillStyle: string };
    const frame = newFrameState('sans-serif', 'sans-serif');
    beginFrame(frame, ctx, 1);
    const bridge = page('eth', 500, 500);
    const plain = page('btc', 500, 800);
    const buf = newLabelBuffer(2, 0);
    const view: DrawView = {
      highlight: null, selectedId: null, hoveredId: null, labelRank: new Map([['eth', 0], ['btc', 0]]),
      marked: null, bridges: new Set(['eth']),
    };
    prepareLabels(buf, [bridge, plain], frame, null);
    drawLabels(ctx, [bridge, plain], null, frame, view, buf);
    const name = written.find((w) => w.text === 'ETH');
    const badge = written.find((w) => w.text === 'BRIDGE');
    const other = written.find((w) => w.text === 'BTC');
    expect(name && badge && other).toBeTruthy();
    // The name shifts left so name + badge sit centred over the circle; the badge follows it.
    // ETH is 18 px wide, the gap 5, BRIDGE 36: the whole 59 px is centred on x = 500.
    expect((name?.x ?? 0) - 9 + 59 / 2).toBeCloseTo(500);
    expect(badge?.x).toBeCloseTo((name?.x ?? 0) + 9 + 5);
    expect(other?.x).toBe(500);
    // Two boxes were placed; the bridge's is wider than its name alone (18 px + 5 px gap + 36 px badge).
    const boxes = buf.space.boxes;
    const widths = [boxes[2] - boxes[0], boxes[6] - boxes[4]].sort((a, b) => a - b);
    expect(widths[1] - widths[0]).toBeCloseTo(5 + 6 * 'BRIDGE'.length, 0);
    expect(styled.textAlign).toBe('center');
  });
});

describe('names in screen space', () => {
  it('draws names under scale(1/k) with a true, at least 12 px font, at their graph position', () => {
    const { ctx, written } = fakeCanvas();
    (ctx as unknown as { getTransform(): object }).getTransform = () => ({ a: 4, d: 4, e: 0, f: 0 });
    const frame = newFrameState('Inter', 'Grotesk');
    beginFrame(frame, ctx, 4);
    const hub = page('hub', 200, 200); // well inside the 500 x 500 graph units on screen at k = 4
    const buf = newLabelBuffer(1, 0);
    const view: DrawView = {
      highlight: null, selectedId: null, hoveredId: null, labelRank: new Map([['hub', 0]]), marked: null, bridges: new Set(),
    };
    prepareLabels(buf, [hub], frame, null);
    drawLabels(ctx, [hub], null, frame, view, buf);
    const name = written.find((w) => w.text === 'HUB');
    expect(name).toBeDefined();
    expect(name?.scale).toBeCloseTo(1 / 4);
    expect(name?.font).toBe('500 19px Inter');
    expect(parseFloat((name?.font ?? '').split(' ')[1])).toBeGreaterThanOrEqual(12);
    expect(name?.x).toBeCloseTo(200); // centred over the circle, in graph units
  });
});
