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

/** Records the names written; text is 6 px wide per character. */
function fakeCanvas() {
  const written: Array<{ text: string; x: number; y: number }> = [];
  const ctx = {
    canvas: { width: 2000, height: 2000 },
    getTransform: () => ({ a: 1, d: 1, e: 0, f: 0 }),
    measureText: (text: string) => ({ width: text.length * 6 }),
    fillText: (text: string, x: number, y: number) => written.push({ text, x, y }),
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeText() {},
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
  const view: DrawView = { highlight: null, selectedId: null, hoveredId: null, labelRank: new Map(Object.entries(ranks)) };
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
