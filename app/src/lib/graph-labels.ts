/**
 * Where the knowledge graph may write a name (app/wiki/graph/graph-draw.ts):
 * a box is placed only when it overlaps no name already placed and no circle
 * other than its own page's, trying places round the circle and then further
 * out (with a leader line); a name that must show (placeName's `force`) may
 * cover circles but never a name. The checks run in the label space
 * (graph-label-space.ts), re-exported here. Pure (no canvas), so it is
 * unit-tested directly.
 */

import { circleHits, forcePlace, hitsPlaced, inLimits, type LabelSpace } from './graph-label-space';

export {
  addCircle, buildGrid, forcePlace, hitsPlaced, newLabelSpace, resetSpace, tryPlace, type LabelSpace,
} from './graph-label-space';

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
    if (!inLimits(space, c[0], c[2]) || hitsPlaced(space, c[0], c[1], c[2], c[3])) continue;
    if (circleHits(space, c[0], c[1], c[2], c[3], x, y, true) === 0) return commit(space, i);
  }
  if (!force) return -1;
  let best = -1;
  let fewest = Infinity;
  for (let i = 0; i < NAME_PLACES; i++) {
    placeBox(space, i, x, y, gap, half, lineHeight);
    if (!inLimits(space, c[0], c[2]) || hitsPlaced(space, c[0], c[1], c[2], c[3])) continue;
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
