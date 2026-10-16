/**
 * Where the knowledge graph may write a name (app/wiki/graph/graph-draw.ts):
 * a box is placed only when it overlaps no name already placed and no circle
 * other than its own page's, trying places round the circle and then further
 * out (with a leader line); a name that must show (placeName's `force`) may
 * cover circles but never a name. The circles on screen go into a coarse grid,
 * rebuilt every frame, so a box only checks the circles near it. Every
 * buffer is sized once per load and reused, so a frame allocates nothing.
 * Pure (no canvas), so it is unit-tested directly.
 */

/** The grid never has more cells than this; with more, the cells grow. */
const MAX_CELLS = 4096;

export interface LabelSpace {
  /** Placed boxes as x0, y0, x1, y1. */
  boxes: Float64Array;
  placed: number;
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

function hitsBox(space: LabelSpace, x0: number, y0: number, x1: number, y1: number): boolean {
  const b = space.boxes;
  for (let i = 0; i < space.placed * 4; i += 4) {
    if (!(x1 < b[i] || x0 > b[i + 2] || y1 < b[i + 1] || y0 > b[i + 3])) return true;
  }
  return false;
}

/**
 * How many circles other than the one centred at (ownX, ownY) the box
 * overlaps; with `firstOnly`, stops at the first (0 or 1).
 */
function circleHits(
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

function inLimits(space: LabelSpace, x0: number, x1: number): boolean {
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
  if (hitsBox(space, x0, y0, x1, y1) || circleHits(space, x0, y0, x1, y1, ownX, ownY, true) > 0) return false;
  forcePlace(space, x0, y0, x1, y1);
  return true;
}

/** Claims a box whatever it overlaps (island names, which always show). */
export function forcePlace(space: LabelSpace, x0: number, y0: number, x1: number, y1: number): void {
  const at = space.placed * 4;
  if (at >= space.boxes.length) return;
  space.boxes[at] = x0;
  space.boxes[at + 1] = y0;
  space.boxes[at + 2] = x1;
  space.boxes[at + 3] = y1;
  space.placed += 1;
}

/** Past this zoom the faded pages are named too, after the lit ones, while something is in focus. */
export const LABEL_ZOOM = 1.6;
/** From this zoom every page whose name fits is named; below it only each island's first few. */
export const ALL_NAMES_ZOOM = 0.7;
export const OVERVIEW_NAMES = 3;

/**
 * Whether a page is a name candidate. Pass 0 is the main pass: with nothing
 * in focus, every page from ALL_NAMES_ZOOM (else each island's first
 * OVERVIEW_NAMES by `rank`); with a focus, the lit pages. Pass 1 adds the
 * faded pages, drawn faded, once zoomed in past LABEL_ZOOM.
 */
export function wantsName(pass: 0 | 1, focused: boolean, lit: boolean, scale: number, rank: number): boolean {
  if (!focused) return pass === 0 && (scale >= ALL_NAMES_ZOOM || rank < OVERVIEW_NAMES);
  return pass === 0 ? lit : !lit && scale > LABEL_ZOOM;
}

/** placeName's first four places, round its page's circle. */
export const NAME_BELOW = 0;
export const NAME_ABOVE = 1;
export const NAME_RIGHT = 2;
export const NAME_LEFT = 3;
export const NEAR_PLACES = 4;
/** Then a ring of 8 directions at 3 growing distances, each ring FAR_STEP line heights further out. */
const FAR_DIRECTIONS = 8;
const FAR_RINGS = 3;
const FAR_STEP = 1.25;
export const NAME_PLACES = NEAR_PLACES + FAR_DIRECTIONS * FAR_RINGS;
/** Far directions: south, north, east, west, then the diagonals. */
const DIR_X = [0, 0, 1, -1, Math.SQRT1_2, -Math.SQRT1_2, Math.SQRT1_2, -Math.SQRT1_2];
const DIR_Y = [1, -1, 0, 0, Math.SQRT1_2, Math.SQRT1_2, -Math.SQRT1_2, -Math.SQRT1_2];

function setBox(box: Float64Array, x0: number, y0: number, x1: number, y1: number): void {
  box[0] = x0;
  box[1] = y0;
  box[2] = x1;
  box[3] = y1;
}

/** Writes the box of place `i` for a name of half width `half` round (x, y) into space.cand. */
function placeBox(space: LabelSpace, i: number, x: number, y: number, gap: number, half: number, lineHeight: number): void {
  const mid = lineHeight / 2;
  if (i === NAME_BELOW) return setBox(space.cand, x - half, y + gap, x + half, y + gap + lineHeight);
  if (i === NAME_ABOVE) return setBox(space.cand, x - half, y - gap - lineHeight, x + half, y - gap);
  if (i === NAME_RIGHT) return setBox(space.cand, x + gap, y - mid, x + gap + 2 * half, y + mid);
  if (i === NAME_LEFT) return setBox(space.cand, x - gap - 2 * half, y - mid, x - gap, y + mid);
  const dir = (i - NEAR_PLACES) % FAR_DIRECTIONS;
  const reach = gap + (1 + Math.floor((i - NEAR_PLACES) / FAR_DIRECTIONS)) * FAR_STEP * lineHeight;
  // The box's near edge sits `reach` out along the direction.
  const cx = x + DIR_X[dir] * reach + Math.sign(DIR_X[dir]) * half;
  const cy = y + DIR_Y[dir] * reach + Math.sign(DIR_Y[dir]) * mid;
  setBox(space.cand, cx - half, cy - mid, cx + half, cy + mid);
}

function commit(space: LabelSpace, place: number): number {
  const c = space.cand;
  forcePlace(space, c[0], c[1], c[2], c[3]);
  space.last.set(c);
  space.lastLeader = place >= NEAR_PLACES;
  return place;
}

/**
 * Places a page name round its circle (`gap` from the centre, `half` the
 * box's half width): below, above, right or left, then further out in 8
 * directions (those need a leader line: space.lastLeader). The box lands in
 * space.last; returns the place used, or -1. A place must be free of other
 * names and of other pages' circles. With `force` (an island's top page or
 * the page in focus) and no free place, the name still goes where it covers
 * the fewest circles, but never over another name.
 */
export function placeName(
  space: LabelSpace, x: number, y: number, gap: number, half: number, lineHeight: number, force = false
): number {
  const c = space.cand;
  for (let i = 0; i < NAME_PLACES; i++) {
    placeBox(space, i, x, y, gap, half, lineHeight);
    if (!inLimits(space, c[0], c[2]) || hitsBox(space, c[0], c[1], c[2], c[3])) continue;
    if (circleHits(space, c[0], c[1], c[2], c[3], x, y, true) === 0) return commit(space, i);
  }
  if (!force) return -1;
  let best = -1;
  let fewest = Infinity;
  for (let i = 0; i < NAME_PLACES; i++) {
    placeBox(space, i, x, y, gap, half, lineHeight);
    if (!inLimits(space, c[0], c[2]) || hitsBox(space, c[0], c[1], c[2], c[3])) continue;
    const hits = circleHits(space, c[0], c[1], c[2], c[3], x, y, false);
    if (hits < fewest) {
      fewest = hits;
      best = i;
      space.best.set(c);
    }
  }
  if (best < 0) return -1;
  space.cand.set(space.best);
  return commit(space, best);
}
