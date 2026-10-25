/**
 * Relation names along the graph's lines: a dark pill turned along the
 * line, kept upright, drawn after the page names, which win any clash (a
 * label goes only where the label space is free). Labels grow with the zoom
 * up to a cap (graph-zoom.ts), drawn in screen pixels so their font is
 * rebuilt only when their size steps. Nothing is allocated per label.
 * Client-only.
 */

import { forcePlace, hitsPlaced, type LabelSpace } from '../../../lib/graph-labels';
import { LINE_LABEL_ZOOM, LINE_LABELS_MAX, LINE_PX, uprightAngle, type LineStyle } from '../../../lib/graph-line-style';
import { isMissingLink } from '../../../lib/graph-missing';
import type { ModelLink, ModelNode } from '../../../lib/graph-model';
import type { FrameState } from './graph-draw';
import { clearOf, outOfView, type LineFrame } from './graph-lines';

const LABEL_PILL = 'rgba(13,14,16,0.85)';
const LABEL_TEXT = 'rgba(230,237,243,0.9)';
/** Where along a line its label is tried, as fractions of the stretch between the circles. */
const LABEL_SPOTS = [0.5, 0.36, 0.64] as const;

/**
 * Relation names along lines, after the page names (which win any clash:
 * a label goes only where the label space is free). With something in focus,
 * its lines (`focus`) are named; with nothing in focus and zoomed in past
 * LINE_LABEL_ZOOM, every typed line long enough on screen, strongest first.
 * Never a plain link or a missing page's line; at most LINE_LABELS_MAX.
 */
export function drawLineLabels(
  ctx: CanvasRenderingContext2D, links: readonly ModelLink[], styles: ReadonlyMap<ModelLink, LineStyle>,
  focus: ReadonlySet<ModelLink> | null, lf: LineFrame, frame: FrameState, space: LabelSpace
): void {
  if (focus === null && frame.scale < LINE_LABEL_ZOOM) return;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (focus !== null) {
    for (const l of focus) {
      if (lf.labelled >= LINE_LABELS_MAX) break;
      labelLine(ctx, l, styles.get(l), 0, lf, frame, space);
    }
  } else {
    // Lines are sorted plain, related, typed, lighter first: walk back from the strongest.
    // Missing pages' lines (graph-missing.ts) come after them all: walk past those first.
    for (let i = links.length - 1; i >= 0 && lf.labelled < LINE_LABELS_MAX; i--) {
      const l = links[i];
      if (isMissingLink(l)) continue;
      if (l.kind !== 'typed') break;
      labelLine(ctx, l, styles.get(l), LINE_PX.minLabel, lf, frame, space);
    }
  }
  ctx.restore();
}

/**
 * Names one line: a pill turned along it, at its middle (a line in focus) or
 * at the first free of three spots (zoom labels, which must also fit between
 * the two circles and be at least `minPx` long on screen).
 */
function labelLine(
  ctx: CanvasRenderingContext2D, l: ModelLink, style: LineStyle | undefined, minPx: number,
  lf: LineFrame, frame: FrameState, space: LabelSpace
): void {
  if (!style?.label || l.kind === 'plain' || isMissingLink(l)) return;
  const s = l.source as ModelNode;
  const t = l.target as ModelNode;
  if (typeof s !== 'object' || typeof t !== 'object' || outOfView(s, t, frame)) return;
  const k = frame.scale;
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.hypot(dx, dy);
  const rs = clearOf(s, k);
  const rt = clearOf(t, k);
  const between = len - rs - rt;
  if (len === 0 || between * k < minPx) return;
  let width = lf.widths.get(style.label);
  if (width === undefined) {
    ctx.font = lf.measureFont;
    width = ctx.measureText(style.label).width;
    lf.widths.set(style.label, width);
  }
  // The label grows with the zoom (LineFrame.labelPx); widths were measured at LINE_PX.labelFont.
  const grow = lf.labelPx / LINE_PX.labelFont;
  const wPx = (width + 2 * LINE_PX.labelPadX) * grow;
  const hPx = LINE_PX.labelHeight * grow;
  const w = wPx / k;
  const h = hPx / k;
  const zoomLabel = minPx > 0;
  if (zoomLabel && between < w + 4 / k) return;
  const ux = dx / len;
  const uy = dy / len;
  const angle = uprightAngle(dx, dy);
  // The turned label's bounding box (turnedHalfExtents, inlined: nothing allocated per label).
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const hx = (cos * w + sin * h) / 2;
  const hy = (sin * w + cos * h) / 2;
  const spots = zoomLabel ? LABEL_SPOTS.length : 1;
  for (let i = 0; i < spots; i++) {
    const along = between > 0 ? rs + between * LABEL_SPOTS[i] : len / 2;
    const cx = s.x + ux * along;
    const cy = s.y + uy * along;
    if (!placeTurned(space, cx, cy, ux, uy, w / 2, h / 2, hx, hy, s, t)) continue;
    // Drawn in screen pixels, so the font string changes only when the label size steps.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.scale(1 / k, 1 / k);
    ctx.beginPath();
    ctx.roundRect(-wPx / 2, -hPx / 2, wPx, hPx, hPx / 2);
    ctx.fillStyle = LABEL_PILL;
    ctx.fill();
    ctx.font = lf.font;
    ctx.fillStyle = LABEL_TEXT;
    ctx.fillText(style.label, 0, 0.5);
    ctx.restore();
    lf.labelled += 1;
    return;
  }
}

/**
 * Claims the bounding box (half sizes hx, hy) of a label turned along a line
 * (direction ux, uy) when the box overlaps no placed box (island and page
 * names, other labels) and the label overlaps no circle but the line's own
 * two pages. For circles the label is taken as a capsule, its centre line
 * padded by half its height, not as its box, so a label on a steep line is
 * not blocked by circles its box merely reaches. Reads the label space's
 * grid as graph-labels.ts fills it each frame (circles sorted by cell).
 */
export function placeTurned(
  space: LabelSpace, cx: number, cy: number, ux: number, uy: number, halfW: number, halfH: number,
  hx: number, hy: number, s: { x: number; y: number }, t: { x: number; y: number }
): boolean {
  const x0 = cx - hx;
  const y0 = cy - hy;
  const x1 = cx + hx;
  const y1 = cy + hy;
  if (space.placed * 4 >= space.boxes.length || x0 < space.limitMinX || x1 > space.limitMaxX) return false;
  if (hitsPlaced(space, x0, y0, x1, y1)) return false;
  if (space.circles > 0) {
    const reach = Math.max(0, halfW - halfH);
    const c0 = gridCol(space, x0 - space.maxR);
    const c1 = gridCol(space, x1 + space.maxR);
    const r0 = gridRow(space, y0 - space.maxR);
    const r1 = gridRow(space, y1 + space.maxR);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = r * space.cols + c;
        for (let j = space.start[cell]; j < space.start[cell + 1]; j++) {
          const i = space.items[j];
          const px = space.cx[i];
          const py = space.cy[i];
          if ((px === s.x && py === s.y) || (px === t.x && py === t.y)) continue;
          // Distance from the circle's centre to the label's centre line.
          const along = Math.max(-reach, Math.min(reach, (px - cx) * ux + (py - cy) * uy));
          const gap = Math.hypot(px - (cx + ux * along), py - (cy + uy * along));
          if (gap < space.cr[i] + halfH) return false;
        }
      }
    }
  }
  forcePlace(space, x0, y0, x1, y1);
  return true;
}

function gridCol(space: LabelSpace, x: number): number {
  return Math.min(space.cols - 1, Math.max(0, Math.floor((x - space.x0) / space.cell)));
}

function gridRow(space: LabelSpace, y: number): number {
  return Math.min(space.rows - 1, Math.max(0, Math.floor((y - space.y0) / space.cell)));
}
