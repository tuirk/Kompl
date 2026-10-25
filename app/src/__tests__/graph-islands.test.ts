/**
 * The category names over the knowledge graph's islands
 * (app/wiki/graph/graph-islands.ts drawClusterLabels): one per island of two
 * or more pages, over its pages. Missing names ("Show missing pages") carry
 * their home page's island but are not pages: they never give an island a
 * title nor move it. Runs against a recording stand-in for the canvas.
 */

import { describe, expect, it } from 'vitest';
import { beginFrame, newFrameState, newLabelBuffer, prepareLabels } from '../app/wiki/graph/graph-draw';
import { drawClusterLabels, newClusterBuffer } from '../app/wiki/graph/graph-islands';
import type { MissingNode } from '../lib/graph-missing';
import type { CategoryInfo, ModelNode } from '../lib/graph-model';

/** Records each island title written, at its graph position (titles are drawn in screen space). */
function fakeCanvas() {
  const written: Array<{ text: string; x: number; y: number }> = [];
  let s = 1;
  const stack: number[] = [];
  const ctx = {
    canvas: { width: 2000, height: 2000 },
    getTransform: () => ({ a: 1, d: 1, e: 0, f: 0 }),
    measureText: (text: string) => ({ width: text.length * 6 }),
    fillText(text: string, x: number, y: number) {
      written.push({ text, x: x * s, y: y * s });
    },
    strokeText() {},
    save() { stack.push(s); },
    restore() { s = stack.pop() ?? 1; },
    scale(a: number) { s *= a; },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, written };
}

function category(index: number, name: string): CategoryInfo {
  return { name, mapLabel: name.toUpperCase(), index, color: '#fff', overflow: false, total: 0, anchorX: 0, anchorY: 0 };
}

function page(id: string, catIndex: number, x: number, y: number): ModelNode {
  return { id, catIndex, x, y, radius: 6, ring: false, archived: false, shortLabel: id } as ModelNode;
}

function missing(id: string, home: ModelNode, x: number, y: number): MissingNode {
  return { ...page(id, home.catIndex, x, y), missing: true, homeId: home.id } as MissingNode;
}

const CATEGORIES = [category(0, 'Crypto'), category(1, 'Travel')];

function titles(nodes: ModelNode[]) {
  const { ctx, written } = fakeCanvas();
  const frame = newFrameState('sans-serif', 'sans-serif');
  beginFrame(frame, ctx, 1);
  const labels = newLabelBuffer(nodes.length, CATEGORIES.length);
  prepareLabels(labels, nodes, frame, null);
  drawClusterLabels(ctx, nodes, CATEGORIES, newClusterBuffer(CATEGORIES.length), frame, false, labels);
  return written;
}

describe('island titles', () => {
  const a = page('a', 0, 100, 100);
  const b = page('b', 0, 140, 100);
  const lone = page('lone', 1, 600, 600);

  it('titles every island, a one-page one too (its page alone would read as part of the island beside it)', () => {
    expect(titles([a, b, lone]).map((w) => w.text)).toEqual(['CRYPTO', 'TRAVEL']);
  });

  it('gives no title to an island of missing names only, and never moves one for a missing name', () => {
    expect(titles([a, b, missing('missing:x', a, 640, 620)]).map((w) => w.text)).toEqual(['CRYPTO']);
    const named = missing('missing:x', lone, 640, 620);
    expect(titles([a, b, lone, named])).toEqual(titles([a, b, lone]));
  });

  it('keeps an island title where it is when missing names are shown', () => {
    const before = titles([a, b, lone]);
    const after = titles([a, b, lone, missing('missing:y', a, 120, 20), missing('missing:z', b, 400, 300)]);
    expect(after).toEqual(before);
  });
});
