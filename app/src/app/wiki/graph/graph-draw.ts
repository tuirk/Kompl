/**
 * Canvas painting for the knowledge graph: page circles (rings, selection,
 * missing pages' dashed hollow circles) and names, a bridge page's with a
 * "BRIDGE" badge. A name never overlaps another name and, except for an
 * island's top page or the page in focus when crowded, no other page's
 * circle (lib/graph-labels.ts); it has a dark halo so it reads over lines,
 * and a leader line when placed far out. These run for every page on every
 * frame, so they only read fields the model prepared, the per-frame
 * FrameState and buffers made once per load; nothing is allocated per page.
 * Island names live in graph-islands.ts. Client-only.
 */

import type { Highlight } from '../../../lib/graph-focus';
import {
  addCircle, buildGrid, newLabelSpace, placeName, resetSpace, wantsName, OVERVIEW_NAMES, type LabelSpace,
} from '../../../lib/graph-labels';
import { isMissingNode, MISSING_HEX } from '../../../lib/graph-missing';
import { LINE_LABELS_MAX } from '../../../lib/graph-line-style';
import type { ModelNode } from '../../../lib/graph-model';
import { ACCENT_HEX, CANVAS_BG, withAlpha } from '../../../lib/graph-palette';

export const LABEL_PX = 12;
/** Most page names drawn in one frame. */
const MAX_LABELS = 400;
/** Grid cells for the label check, in screen pixels. */
const GRID_CELL_PX = 64;
const RING_COLOR = 'rgba(236,236,240,0.55)';
const RING_FADED = 'rgba(236,236,240,0.08)';
const LABEL_COLOR = '#E6EDF3';
const ARCHIVED_ALPHA = 0.35;
/** Names of faded pages, when zoomed in with something in focus. */
const FADED_NAME_ALPHA = 0.35;
/** Halo around a name, in screen pixels. */
const HALO_PX = 3.5;
/** Air at each end of a name's box, in screen pixels. */
const NAME_PAD_PX = 2;
/** The leader line from a circle to its far-placed name. */
const LEADER_COLOR = 'rgba(230,237,243,0.3)';
const MISSING_FADED = withAlpha(MISSING_HEX, 0.15);
/** A missing page's dashes, in screen pixels. */
const MISSING_DASH_PX = [3, 2.5] as const;
const NO_DASH: number[] = [];
/** Names of missing pages read quieter than page names. */
const MISSING_NAME_ALPHA = 0.75;
const BADGE_TEXT = 'BRIDGE';
/** Neutral, not the accent: on the canvas the accent only marks the selection, a clicked line or a path. */
const BADGE_COLOR = 'rgba(230,237,243,0.72)';
const BADGE_PX = 9;
/** Gap between a name and its badge, in screen pixels. */
const BADGE_GAP_PX = 5;

/** Values worked out once per frame (onRenderFramePre) and read by every draw call. */
export interface FrameState {
  scale: number;
  font: string;
  /** The label font at its on-screen size, for measuring. */
  measureFont: string;
  clusterFont: string;
  clusterMeasureFont: string;
  clusterSpacing: string;
  /** The visible area in graph units, with a margin. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Names stay between these: the legend's right edge and an open side panel's left edge, in graph units. */
  labelMinX: number;
  labelMaxX: number;
  bodyFamily: string;
  headingFamily: string;
  /** The bridge badge's font at this zoom, its font for measuring, and its on-screen width (NaN until measured). */
  badgeFont: string;
  badgeMeasureFont: string;
  badgeWidth: number;
  /** A missing page's dash pattern at this zoom (graph units); reused, never reallocated. */
  dash: number[];
}

export const CLUSTER_PX = 13;
export const CLUSTER_SPACING = 1.5;

export function newFrameState(bodyFamily: string, headingFamily: string): FrameState {
  return {
    scale: 1, font: '', measureFont: `500 ${LABEL_PX}px ${bodyFamily}`, clusterFont: '',
    clusterMeasureFont: `700 ${CLUSTER_PX}px ${headingFamily}`, clusterSpacing: '0px',
    minX: 0, minY: 0, maxX: 0, maxY: 0, labelMinX: -Infinity, labelMaxX: Infinity, bodyFamily, headingFamily,
    badgeFont: '', badgeMeasureFont: `700 ${BADGE_PX}px ${headingFamily}`, badgeWidth: NaN, dash: [...MISSING_DASH_PX],
  };
}

/**
 * Called before each frame: zoom, fonts for that zoom, the visible area, and
 * where names must stop when the legend covers `coveredLeft` and a side
 * panel `coveredRight` css pixels.
 */
export function beginFrame(
  frame: FrameState, ctx: CanvasRenderingContext2D, scale: number, coveredLeft = 0, coveredRight = 0
): void {
  if (scale !== frame.scale || frame.font === '') {
    frame.scale = scale;
    frame.font = `500 ${LABEL_PX / scale}px ${frame.bodyFamily}`;
    frame.clusterFont = `700 ${CLUSTER_PX / scale}px ${frame.headingFamily}`;
    frame.clusterSpacing = `${CLUSTER_SPACING / scale}px`;
    frame.badgeFont = `700 ${BADGE_PX / scale}px ${frame.headingFamily}`;
    frame.dash[0] = MISSING_DASH_PX[0] / scale;
    frame.dash[1] = MISSING_DASH_PX[1] / scale;
  }
  const m = ctx.getTransform();
  const margin = 120 / scale;
  frame.minX = -m.e / m.a - margin;
  frame.maxX = (ctx.canvas.width - m.e) / m.a + margin;
  frame.minY = -m.f / m.d - margin;
  frame.maxY = (ctx.canvas.height - m.f) / m.d + margin;
  const dpr = m.a / scale;
  frame.labelMinX = (coveredLeft * dpr - m.e) / m.a;
  frame.labelMaxX = (ctx.canvas.width - coveredRight * dpr - m.e) / m.a;
}

/** What the current hover or selection asks for. */
export interface DrawView {
  highlight: Highlight | null;
  selectedId: string | null;
  hoveredId: string | null;
  labelRank: Map<string, number>;
  /** Pages with the selection ring besides the selected one: a path's two ends, or the focused page. */
  marked: ReadonlySet<string> | null;
  /** Pages whose names carry the bridge badge. */
  bridges: ReadonlySet<string>;
}

export function drawNode(ctx: CanvasRenderingContext2D, n: ModelNode, frame: FrameState, view: DrawView): void {
  const k = frame.scale;
  const lit = view.highlight === null || view.highlight.nodes.has(n.id);
  const prevAlpha = ctx.globalAlpha;
  if (n.archived) ctx.globalAlpha = prevAlpha * ARCHIVED_ALPHA;

  ctx.beginPath();
  ctx.arc(n.x, n.y, n.radius, 0, 2 * Math.PI);
  ctx.fillStyle = lit ? n.fill : n.fillFaded;
  ctx.fill();
  if (isMissingNode(n)) {
    ctx.setLineDash(frame.dash);
    ctx.strokeStyle = lit ? MISSING_HEX : MISSING_FADED;
    ctx.lineWidth = 1.5 / k;
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
  } else if (n.isSource) {
    ctx.strokeStyle = lit ? n.color : n.fillFaded;
    ctx.lineWidth = 1 / k;
    ctx.stroke();
  }
  if (n.ring) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.radius + 3 / k, 0, 2 * Math.PI);
    ctx.strokeStyle = lit ? RING_COLOR : RING_FADED;
    ctx.lineWidth = 1.5 / k;
    ctx.stroke();
  }
  if (n.id === view.selectedId || view.marked?.has(n.id) === true) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.radius + 5 / k, 0, 2 * Math.PI);
    ctx.strokeStyle = ACCENT_HEX;
    ctx.lineWidth = 2.5 / k;
    ctx.stroke();
  } else if (n.id === view.hoveredId) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.radius + 4 / k, 0, 2 * Math.PI);
    ctx.strokeStyle = LABEL_COLOR;
    ctx.lineWidth = 2 / k;
    ctx.stroke();
  }
  ctx.globalAlpha = prevAlpha;
}

/** Name widths (on-screen pixels, measured once) and the label space every frame reuses. */
export interface LabelBuffer {
  widths: Map<string, number>;
  /** Per category; NaN until measured. */
  islandWidths: Float64Array;
  space: LabelSpace;
}

export function newLabelBuffer(nodeCount: number, categoryCount: number): LabelBuffer {
  return {
    widths: new Map(),
    islandWidths: new Float64Array(categoryCount).fill(NaN),
    space: newLabelSpace(nodeCount, MAX_LABELS + LINE_LABELS_MAX + categoryCount),
  };
}

/** The circle a name must keep clear of: the page plus its ring, with a little air. */
function clearRadius(n: ModelNode, k: number): number {
  return n.radius + (n.ring ? 5 : 2) / k;
}

/**
 * Starts a frame's label space: the circles on screen, sorted into the grid.
 * While something is in focus only the lit circles count; the faded ones are
 * background and may sit under a name.
 */
export function prepareLabels(buf: LabelBuffer, nodes: readonly ModelNode[], frame: FrameState, highlight: Highlight | null): void {
  const k = frame.scale;
  const space = buf.space;
  resetSpace(space, frame.minX, frame.minY, frame.maxX, frame.maxY, GRID_CELL_PX / k, frame.labelMinX, frame.labelMaxX);
  for (const n of nodes) {
    const inView = n.x >= frame.minX && n.x <= frame.maxX && n.y >= frame.minY && n.y <= frame.maxY;
    if (inView && (highlight === null || highlight.nodes.has(n.id))) {
      addCircle(space, n.x, n.y, clearRadius(n, k));
    }
  }
  buildGrid(space);
}

/**
 * Page names, after the island names (which claim their boxes first) and
 * after every circle, so no circle covers one. Three rounds, so the names
 * that matter most choose first and lower-ranked ones give way to them:
 *  0. the page in focus, then each island's top page (rank 0), placed even
 *     when crowded (placeName's `force`), never over another name;
 *  1. the other candidates, most sources and lines first (`order`);
 *  2. with a focus and zoomed past LABEL_ZOOM, the faded pages, drawn faded.
 * Who is a candidate is in wantsName (graph-labels.ts). A name placed far
 * from its circle gets a faint leader line back to it.
 */
export function drawLabels(
  ctx: CanvasRenderingContext2D, order: readonly ModelNode[], focusNode: ModelNode | null,
  frame: FrameState, view: DrawView, buf: LabelBuffer
): void {
  const k = frame.scale;
  const space = buf.space;
  const lineHeight = (LABEL_PX + 2) / k;
  const focused = view.highlight !== null;
  let named = 0;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.fillStyle = LABEL_COLOR;
  for (let round = 0; round < 3 && named < MAX_LABELS; round++) {
    if (round === 2 && !focused) break;
    const pass = round === 2 ? 1 : 0;
    for (let i = -1; i < order.length && named < MAX_LABELS; i++) {
      const n = i === -1 ? focusNode : order[i];
      if (n === null || (i >= 0 && n === focusNode) || (i === -1 && round !== 0)) continue;
      const rank = view.labelRank.get(n.id) ?? OVERVIEW_NAMES;
      const first = n === focusNode || rank === 0;
      if ((round === 0 && !first) || (round === 1 && first)) continue;
      const lit = !focused || (view.highlight as Highlight).nodes.has(n.id);
      if (!wantsName(pass, focused, lit, k, rank)) continue;
      if (n.x < frame.minX || n.x > frame.maxX || n.y < frame.minY || n.y > frame.maxY) continue;
      let width = buf.widths.get(n.id);
      if (width === undefined) {
        ctx.font = frame.measureFont;
        width = ctx.measureText(n.shortLabel).width;
        buf.widths.set(n.id, width);
      }
      const badge = view.bridges.has(n.id);
      if (badge && Number.isNaN(frame.badgeWidth)) {
        ctx.font = frame.badgeMeasureFont;
        frame.badgeWidth = ctx.measureText(BADGE_TEXT).width;
      }
      const extra = badge ? BADGE_GAP_PX + frame.badgeWidth : 0;
      const half = (width + extra) / 2 / k + NAME_PAD_PX / k;
      if (placeName(space, n.x, n.y, clearRadius(n, k) + 1 / k, half, lineHeight, round === 0) < 0) continue;
      named += 1;
      const box = space.last;
      ctx.globalAlpha =
        (pass === 1 ? FADED_NAME_ALPHA : 1) * (n.archived ? ARCHIVED_ALPHA : 1) * (isMissingNode(n) ? MISSING_NAME_ALPHA : 1);
      if (space.lastLeader) drawLeader(ctx, n, box, k);
      // The name, then the badge, centred together in the box.
      const x = (box[0] + box[2]) / 2 - extra / 2 / k;
      ctx.font = frame.font;
      ctx.lineWidth = HALO_PX / k;
      ctx.strokeStyle = CANVAS_BG;
      ctx.strokeText(n.shortLabel, x, box[1] + 1 / k);
      ctx.fillText(n.shortLabel, x, box[1] + 1 / k);
      if (badge) drawBadge(ctx, x + (width / 2 + BADGE_GAP_PX) / k, box[1] + 1 / k, frame);
    }
  }
  ctx.restore();
}

/** "BRIDGE" in small capitals, starting at x, vertically centred on a name drawn from y. */
function drawBadge(ctx: CanvasRenderingContext2D, x: number, y: number, frame: FrameState): void {
  const k = frame.scale;
  ctx.font = frame.badgeFont;
  ctx.textAlign = 'left';
  ctx.strokeText(BADGE_TEXT, x, y + (LABEL_PX - BADGE_PX) / 2 / k);
  ctx.fillStyle = BADGE_COLOR;
  ctx.fillText(BADGE_TEXT, x, y + (LABEL_PX - BADGE_PX) / 2 / k);
  ctx.fillStyle = LABEL_COLOR;
  ctx.textAlign = 'center';
}

/** A faint line from the circle's edge to the nearest point of its far-placed name. */
function drawLeader(ctx: CanvasRenderingContext2D, n: ModelNode, box: Float64Array, k: number): void {
  const tx = Math.min(Math.max(n.x, box[0]), box[2]);
  const ty = Math.min(Math.max(n.y, box[1]), box[3]);
  const dist = Math.hypot(tx - n.x, ty - n.y);
  if (dist <= n.radius) return;
  ctx.beginPath();
  ctx.moveTo(n.x + ((tx - n.x) / dist) * n.radius, n.y + ((ty - n.y) / dist) * n.radius);
  ctx.lineTo(tx, ty);
  ctx.lineWidth = 1 / k;
  ctx.strokeStyle = LEADER_COLOR;
  ctx.stroke();
}
