/**
 * The label space behind the knowledge graph's names (graph-labels.ts):
 * the boxes already placed and the circles on screen, in one coarse grid
 * rebuilt every frame (circles at the start, each box as it is placed), so
 * a box only checks the circles and names near it. Every buffer is sized
 * once per load and reused, so a frame allocates nothing. Pure (no canvas).
 */

/** The grid never has more cells than this; with more, the cells grow. */
const MAX_CELLS = 4096;

export interface LabelSpace {
  /** Placed boxes as x0, y0, x1, y1. */
  boxes: Float64Array;
  placed: number;
  /** Placed boxes in the grid by their centre: cell c's are boxHead[c], then boxNext[box] until -1. */
  boxHead: Int32Array;
  boxNext: Int32Array;
  /** Half the width and height of the largest placed box: how far round a box hitsPlaced looks. */
  boxHalfW: number;
  boxHalfH: number;
  /** Circles on screen this frame. */
  cx: Float64Array;
  cy: Float64Array;
  cr: Float64Array;
  circles: number;
  maxR: number;
  /** Grid over the visible area: the circles of cell c are items[start[c] .. start[c + 1]). */
  start: Int32Array;
  items: Int32Array;
  cols: number;
  rows: number;
  cell: number;
  x0: number;
  y0: number;
  /** Boxes stay between these (the legend's edge and an open side panel's). */
  limitMinX: number;
  limitMaxX: number;
  /** Scratch boxes for placeName: the place being tried and the best forced place. */
  cand: Float64Array;
  best: Float64Array;
  /** The box placeName placed last, and whether it sits far enough out to need a leader line. */
  last: Float64Array;
  lastLeader: boolean;
}

export function newLabelSpace(maxCircles: number, maxBoxes: number): LabelSpace {
  return {
    boxes: new Float64Array(Math.max(1, maxBoxes) * 4),
    placed: 0,
    boxHead: new Int32Array(MAX_CELLS).fill(-1),
    boxNext: new Int32Array(Math.max(1, maxBoxes)),
    boxHalfW: 0,
    boxHalfH: 0,
    cx: new Float64Array(Math.max(1, maxCircles)),
    cy: new Float64Array(Math.max(1, maxCircles)),
    cr: new Float64Array(Math.max(1, maxCircles)),
    circles: 0,
    maxR: 0,
    start: new Int32Array(MAX_CELLS + 1),
    items: new Int32Array(Math.max(1, maxCircles)),
    cols: 1,
    rows: 1,
    cell: 1,
    x0: 0,
    y0: 0,
    limitMinX: -Infinity,
    limitMaxX: Infinity,
    cand: new Float64Array(4),
    best: new Float64Array(4),
    last: new Float64Array(4),
    lastLeader: false,
  };
}

/**
 * Empties the space for a new frame over the area [minX, maxX] x [minY, maxY],
 * cells about `cellSize` wide; boxes must stay within [limitMinX, limitMaxX].
 */
export function resetSpace(
  space: LabelSpace, minX: number, minY: number, maxX: number, maxY: number, cellSize: number,
  limitMinX = -Infinity, limitMaxX = Infinity
): void {
  const width = Math.max(1e-6, maxX - minX);
  const height = Math.max(1e-6, maxY - minY);
  let cell = Math.max(1e-6, cellSize);
  while (Math.ceil(width / cell) * Math.ceil(height / cell) > MAX_CELLS) cell *= 1.5;
  space.cell = cell;
  space.cols = Math.ceil(width / cell);
  space.rows = Math.ceil(height / cell);
  space.x0 = minX;
  space.y0 = minY;
  space.limitMinX = limitMinX;
  space.limitMaxX = limitMaxX;
  space.placed = 0;
  space.boxHead.fill(-1, 0, space.cols * space.rows);
  space.boxHalfW = 0;
  space.boxHalfH = 0;
  space.circles = 0;
  space.maxR = 0;
}

/** Adds a circle (before buildGrid). Circles past the buffer's size are ignored. */
export function addCircle(space: LabelSpace, x: number, y: number, r: number): void {
  const i = space.circles;
  if (i >= space.cx.length) return;
  space.cx[i] = x;
  space.cy[i] = y;
  space.cr[i] = r;
  space.circles = i + 1;
  if (r > space.maxR) space.maxR = r;
}

function cellOf(space: LabelSpace, x: number, y: number): number {
  const col = Math.min(space.cols - 1, Math.max(0, Math.floor((x - space.x0) / space.cell)));
  const row = Math.min(space.rows - 1, Math.max(0, Math.floor((y - space.y0) / space.cell)));
  return row * space.cols + col;
}

/** Sorts the added circles into the grid by their centres (a counting sort, no allocation). */
export function buildGrid(space: LabelSpace): void {
  const cells = space.cols * space.rows;
  const start = space.start;
  start.fill(0, 0, cells + 1);
  for (let i = 0; i < space.circles; i++) start[cellOf(space, space.cx[i], space.cy[i]) + 1] += 1;
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  // start[c + 1] is now the end of cell c. Fill each cell from its end, moving that cursor back.
  for (let i = 0; i < space.circles; i++) {
    const c = cellOf(space, space.cx[i], space.cy[i]);
    start[c + 1] -= 1;
    space.items[start[c + 1]] = i;
  }
  // start[c + 1] now holds the start of cell c: shift down by one and close the last cell.
  for (let c = 0; c < cells; c++) start[c] = start[c + 1];
  start[cells] = space.circles;
}

/**
 * Whether the box overlaps (or touches) a placed box. Placed boxes sit in
 * the grid by their centre, so only the cells within half the widest and
 * tallest placed box of this one are read.
 */
export function hitsPlaced(space: LabelSpace, x0: number, y0: number, x1: number, y1: number): boolean {
  if (space.placed === 0) return false;
  const b = space.boxes;
  const first = cellOf(space, x0 - space.boxHalfW, y0 - space.boxHalfH);
  const last = cellOf(space, x1 + space.boxHalfW, y1 + space.boxHalfH);
  const c0 = first % space.cols;
  const c1 = last % space.cols;
  const r1 = Math.floor(last / space.cols);
  for (let row = Math.floor(first / space.cols); row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      for (let i = space.boxHead[row * space.cols + col]; i >= 0; i = space.boxNext[i]) {
        const at = i * 4;
        if (!(x1 < b[at] || x0 > b[at + 2] || y1 < b[at + 1] || y0 > b[at + 3])) return true;
      }
    }
  }
  return false;
}

/**
 * How many circles other than the one centred at (ownX, ownY) the box
 * overlaps; with `firstOnly`, stops at the first (0 or 1).
 */
export function circleHits(
  space: LabelSpace, x0: number, y0: number, x1: number, y1: number, ownX: number, ownY: number, firstOnly: boolean
): number {
  if (space.circles === 0) return 0;
  let hits = 0;
  const pad = space.maxR;
  const first = cellOf(space, x0 - pad, y0 - pad);
  const last = cellOf(space, x1 + pad, y1 + pad);
  const c0 = first % space.cols;
  const c1 = last % space.cols;
  const r1 = Math.floor(last / space.cols);
  for (let row = Math.floor(first / space.cols); row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const c = row * space.cols + col;
      for (let j = space.start[c]; j < space.start[c + 1]; j++) {
        const i = space.items[j];
        const x = space.cx[i];
        const y = space.cy[i];
        if (x === ownX && y === ownY) continue;
        const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
        const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
        if (dx * dx + dy * dy < space.cr[i] * space.cr[i]) {
          hits += 1;
          if (firstOnly) return hits;
        }
      }
    }
  }
  return hits;
}

export function inLimits(space: LabelSpace, x0: number, x1: number): boolean {
  return space.placed * 4 < space.boxes.length && x0 >= space.limitMinX && x1 <= space.limitMaxX;
}

/**
 * Places the box when it is free of placed boxes and of every circle except
 * its own page's (centred at ownX, ownY); returns whether it was placed.
 */
export function tryPlace(
  space: LabelSpace, x0: number, y0: number, x1: number, y1: number, ownX: number, ownY: number
): boolean {
  if (!inLimits(space, x0, x1)) return false;
  if (hitsPlaced(space, x0, y0, x1, y1) || circleHits(space, x0, y0, x1, y1, ownX, ownY, true) > 0) return false;
  forcePlace(space, x0, y0, x1, y1);
  return true;
}

/** Claims a box whatever it overlaps (island names, which always show). */
export function forcePlace(space: LabelSpace, x0: number, y0: number, x1: number, y1: number): void {
  const i = space.placed;
  const at = i * 4;
  if (at >= space.boxes.length) return;
  space.boxes[at] = x0;
  space.boxes[at + 1] = y0;
  space.boxes[at + 2] = x1;
  space.boxes[at + 3] = y1;
  space.placed = i + 1;
  const c = cellOf(space, (x0 + x1) / 2, (y0 + y1) / 2);
  space.boxNext[i] = space.boxHead[c];
  space.boxHead[c] = i;
  if ((x1 - x0) / 2 > space.boxHalfW) space.boxHalfW = (x1 - x0) / 2;
  if ((y1 - y0) / 2 > space.boxHalfH) space.boxHalfH = (y1 - y0) / 2;
}
