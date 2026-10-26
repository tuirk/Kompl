/**
 * Where the knowledge graph writes page names (lib/graph-labels.ts): never
 * over another name or another page's circle, every name that fits gets a
 * place, and the rules for which pages are named at which zoom.
 */

import { describe, expect, it } from 'vitest';
import {
  addCircle, addSegment, buildGrid, crossesLine, forcePlace, hitsPlaced, newLabelSpace, placeName, resetSpace, segmentHitsBox, tryPlace,
  wantsName, NAME_LINES_MAX,
  ALL_NAMES_ZOOM, LABEL_ZOOM, NAME_ABOVE, NAME_BELOW, NAME_LEFT, NAME_RIGHT, NEAR_PLACES, OVERVIEW_NAMES, type LabelSpace,
} from '../lib/graph-labels';

type Circle = [x: number, y: number, r: number];

function space(circles: Circle[], cell = 64, limitMaxX = Infinity, limitMinX = -Infinity): LabelSpace {
  const s = newLabelSpace(circles.length, 60);
  resetSpace(s, -500, -500, 500, 500, cell, limitMinX, limitMaxX);
  for (const [x, y, r] of circles) addCircle(s, x, y, r);
  buildGrid(s);
  return s;
}

const overlapsCircle = (box: number[], [x, y, r]: Circle) => {
  const dx = Math.max(box[0] - x, 0, x - box[2]);
  const dy = Math.max(box[1] - y, 0, y - box[3]);
  return dx * dx + dy * dy < r * r;
};
const boxesOf = (s: LabelSpace) => Array.from({ length: s.placed }, (_, i) => Array.from(s.boxes.slice(i * 4, i * 4 + 4)));

describe('label space', () => {
  it('rejects a box over another page’s circle but not over its own', () => {
    const s = space([[0, 0, 10], [26, 18, 8]]);
    expect(tryPlace(s, -20, 12, 20, 26, 0, 0)).toBe(false); // reaches the circle at (26, 18)
    expect(tryPlace(s, -20, -8, 5, 4, 0, 0)).toBe(true); // over its own circle only
  });

  it('rejects a box over a placed box, and past the panel edge', () => {
    const s = space([], 64, 100);
    expect(tryPlace(s, 0, 0, 50, 10, NaN, NaN)).toBe(true);
    expect(tryPlace(s, 40, 5, 90, 15, NaN, NaN)).toBe(false);
    expect(tryPlace(s, 60, 0, 110, 10, NaN, NaN)).toBe(false); // ends right of the panel edge
    forcePlace(s, 200, 200, 260, 214);
    expect(s.placed).toBe(2);
    const left = space([], 64, Infinity, -100);
    expect(tryPlace(left, -120, 0, -60, 10, NaN, NaN)).toBe(false); // starts under the legend
    expect(tryPlace(left, -90, 0, -30, 10, NaN, NaN)).toBe(true);
  });

  it('finds circles in every grid cell a box spans, whatever the cell size', () => {
    const circles: Circle[] = [];
    for (let x = -400; x <= 400; x += 37) for (let y = -400; y <= 400; y += 41) circles.push([x, y, 6]);
    for (const cell of [8, 64, 2000]) {
      const s = space(circles, cell);
      const box = [-30, -30, 30, 30];
      const expected = circles.some((c) => overlapsCircle(box, c));
      expect(tryPlace(s, box[0], box[1], box[2], box[3], NaN, NaN)).toBe(!expected);
    }
  });

  it('finds every placed box a new box overlaps, wide or small, whatever the cell size', () => {
    // Boxes of mixed sizes (one very wide, like an island title) against brute force.
    let seed = 7;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (const cell of [8, 64, 2000]) {
      const s = newLabelSpace(1, 400);
      resetSpace(s, -500, -500, 500, 500, cell);
      buildGrid(s);
      const placed: number[][] = [[-480, -20, 480, 20]];
      forcePlace(s, -480, -20, 480, 20);
      for (let i = 0; i < 300; i++) {
        const [x, y, w, h] = [rand() * 1000 - 500, rand() * 1000 - 500, 4 + rand() * 120, 4 + rand() * 30];
        placed.push([x, y, x + w, y + h]);
        forcePlace(s, x, y, x + w, y + h);
      }
      let hits = 0;
      for (let k = 0; k < 400; k++) {
        const [x, y, w, h] = [rand() * 1100 - 550, rand() * 1100 - 550, 2 + rand() * 80, 2 + rand() * 20];
        const expected = placed.some((b) => !(x + w < b[0] || x > b[2] || y + h < b[1] || y > b[3]));
        expect(hitsPlaced(s, x, y, x + w, y + h)).toBe(expected);
        if (expected) hits += 1;
      }
      expect(hits).toBeGreaterThan(50); // both answers were tested
      expect(hits).toBeLessThan(350);
    }
  });

  it('checks a new name only against the names near it', () => {
    // 6,000 names over a crowded field, 5,000 of them placed. Scanning every placed name for every
    // place tried took 550-800 ms (2026-10-23); through the grid it takes 30-40 ms.
    const s = newLabelSpace(1, 6000);
    resetSpace(s, 0, 0, 2800, 2800, 32);
    buildGrid(s);
    let seed = 3;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const t0 = performance.now();
    for (let i = 0; i < 6000; i++) placeName(s, rand() * 2800, rand() * 2800, 6, 30, 12);
    const ms = performance.now() - t0;
    expect(s.placed).toBe(5012);
    expect(ms, `${ms.toFixed(0)} ms for 6,000 names (budget 200 ms)`).toBeLessThan(200);
  });

  it('places every name that fits, and none over a foreign circle or another name', () => {
    // A 6 x 6 field of pages far apart: every name fits below its circle.
    const circles: Circle[] = [];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) circles.push([-400 + i * 150, -400 + j * 140, 8 + (i % 3) * 3]);
    const s = space(circles);
    const placed = circles.map(([x, y, r]) => placeName(s, x, y, r + 2, 40, 14));
    expect(placed.every((p) => p === NAME_BELOW)).toBe(true);
    expect(s.placed).toBe(circles.length);

    // Crowd them: names move above, right or left, or are skipped, but never cover anything.
    const crowd: Circle[] = [];
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) crowd.push([-200 + i * 38, -200 + j * 30, 7]);
    const c = space(crowd);
    const owners: number[] = [];
    crowd.forEach(([x, y, r], i) => {
      if (placeName(c, x, y, r + 2, 30, 14) >= 0) owners.push(i);
    });
    const boxes = boxesOf(c);
    expect(boxes.length).toBe(owners.length);
    expect(boxes.length).toBeGreaterThan(0);
    boxes.forEach((box, b) => {
      crowd.forEach((circle, i) => {
        if (i !== owners[b]) expect(overlapsCircle(box, circle)).toBe(false);
      });
      for (const other of boxes.slice(b + 1)) {
        expect(box[2] < other[0] || box[0] > other[2] || box[3] < other[1] || box[1] > other[3]).toBe(true);
      }
    });
  });

  it('tries below, then above, right and left', () => {
    const s = space([[0, 0, 10]]);
    forcePlace(s, -50, 10, 50, 30); // takes below
    expect(placeName(s, 0, 0, 12, 20, 14)).toBe(NAME_ABOVE);
    forcePlace(s, -50, -60, 50, -12.5); // takes the rest of above
    expect(placeName(s, 0, 0, 12, 20, 14)).toBe(NAME_RIGHT);
    expect(placeName(s, 0, 0, 12, 20, 14)).toBe(NAME_LEFT);
    expect(s.lastLeader).toBe(false);
    // All four near places taken: the name moves further out, with a leader line.
    expect(placeName(s, 0, 0, 12, 20, 14)).toBeGreaterThanOrEqual(NEAR_PLACES);
    expect(s.lastLeader).toBe(true);
  });
});

/** A hub at the origin ringed by circles that block every place next to it. */
function ringed(field: boolean): Circle[] {
  const circles: Circle[] = [[0, 0, 12]];
  for (let a = 0; a < 16; a++) circles.push([Math.cos((a * Math.PI) / 8) * 34, Math.sin((a * Math.PI) / 8) * 34, 9]);
  if (field) {
    // Fill the whole area too, so no place anywhere is free.
    for (let x = -480; x <= 480; x += 18) {
      for (let y = -480; y <= 480; y += 18) if (Math.hypot(x, y) > 50) circles.push([x, y, 10]);
    }
  }
  return circles;
}

describe('names that must show', () => {
  it('moves a ringed hub’s name further out, with a leader line', () => {
    const circles = ringed(false);
    const s = space(circles);
    const where = placeName(s, 0, 0, 13, 40, 14);
    expect(where).toBeGreaterThanOrEqual(NEAR_PLACES);
    expect(s.lastLeader).toBe(true);
    for (const circle of circles.slice(1)) expect(overlapsCircle(Array.from(s.last), circle)).toBe(false);
  });

  it('places a fully surrounded hub’s name only when forced, and never over another name', () => {
    const circles = ringed(true);
    const s = space(circles);
    forcePlace(s, -40, 13, 40, 27); // another name already sits right below the hub
    expect(placeName(s, 0, 0, 13, 40, 14)).toBe(-1);
    const where = placeName(s, 0, 0, 13, 40, 14, true);
    expect(where).toBeGreaterThanOrEqual(0);
    const [box, other] = [Array.from(s.last), [-40, 13, 40, 27]];
    expect(box[2] < other[0] || box[0] > other[2] || box[3] < other[1] || box[1] > other[3]).toBe(true);
    expect(s.lastLeader).toBe(where >= NEAR_PLACES);
  });

  it('gives up even when forced if every place would cover a name', () => {
    const s = space(ringed(true));
    forcePlace(s, -400, -400, 400, 400);
    expect(placeName(s, 0, 0, 13, 40, 14, true)).toBe(-1);
  });
});

describe('wantsName', () => {
  it('names every fitting page from ALL_NAMES_ZOOM, else each island’s first few', () => {
    expect(wantsName(0, false, true, ALL_NAMES_ZOOM, 17)).toBe(true);
    expect(wantsName(0, false, true, ALL_NAMES_ZOOM - 0.1, OVERVIEW_NAMES - 1)).toBe(true);
    expect(wantsName(0, false, true, ALL_NAMES_ZOOM - 0.1, OVERVIEW_NAMES)).toBe(false);
    expect(wantsName(1, false, true, 3, 0)).toBe(false); // no second pass without a focus
  });

  it('with a focus names the lit pages, then the faded ones once zoomed past LABEL_ZOOM', () => {
    expect(wantsName(0, true, true, 1, 9)).toBe(true);
    expect(wantsName(0, true, false, 3, 0)).toBe(false);
    expect(wantsName(1, true, false, LABEL_ZOOM, 0)).toBe(false);
    expect(wantsName(1, true, false, LABEL_ZOOM + 0.1, 0)).toBe(true);
    expect(wantsName(1, true, true, 3, 0)).toBe(false); // lit pages were named in pass 0
  });
});

describe('names keep off the lines', () => {
  it('finds whether a line passes through a box', () => {
    expect(segmentHitsBox(-50, 5, 50, 5, -10, 0, 10, 10)).toBe(true); // straight through
    expect(segmentHitsBox(-50, -50, 50, 50, -10, 0, 10, 10)).toBe(true); // diagonal through
    expect(segmentHitsBox(-50, 20, 50, 20, -10, 0, 10, 10)).toBe(false); // passes below
    expect(segmentHitsBox(-50, -40, -5, 10, 0, 0, 20, 10)).toBe(false); // ends short of it
    expect(segmentHitsBox(5, 5, 6, 6, 0, 0, 10, 10)).toBe(true); // inside
  });

  it('puts a name round its circle where no line runs, before one that crosses a line', () => {
    const s = space([[0, 0, 6]]);
    expect(addSegment(s, 0, 0, 0, 200)).toBe(true); // the page's line straight down, through the name below
    expect(placeName(s, 0, 0, 8, 20, 14)).toBe(NAME_ABOVE);
    expect(crossesLine(s, s.last[0], s.last[1], s.last[2], s.last[3])).toBe(false);
  });

  it('still names the page beside its circle when every near place crosses a line', () => {
    const s = space([[0, 0, 6]]);
    addSegment(s, 0, -200, 0, 200);
    addSegment(s, -200, 0, 200, 0);
    expect(placeName(s, 0, 0, 8, 20, 14)).toBe(NAME_BELOW);
  });

  it('checks no lines once more are in view than it keeps', () => {
    const s = space([]);
    for (let i = 0; i < NAME_LINES_MAX; i++) expect(addSegment(s, 0, 0, 1, 1)).toBe(true);
    expect(addSegment(s, 0, 0, 1, 1)).toBe(false);
  });
});
