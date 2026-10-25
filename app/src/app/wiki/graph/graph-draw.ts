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
  addCircle, addSegment, buildGrid, newLabelSpace, placeName, resetSpace, wantsName, OVERVIEW_NAMES, type LabelSpace,
} from '../../../lib/graph-labels';
import { isMissingNode, MISSING_HEX } from '../../../lib/graph-missing';
import { LINE_LABELS_MAX } from '../../../lib/graph-line-style';
import type { ModelLink, ModelNode } from '../../../lib/graph-model';
import { ACCENT_HEX, CANVAS_BG, withAlpha } from '../../../lib/graph-palette';
import { grownPx, NAME_GROWTH } from '../../../lib/graph-zoom';
import { BADGE_GAP_PX, BADGE_PX, BADGE_TEXT, drawBadge, drawLeader } from './graph-name-marks';

/** Page names' size up to the zoom where they start growing (graph-zoom.ts NAME_GROWTH). */
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
const MISSING_FADED = withAlpha(MISSING_HEX, 0.15);
/** A missing page's dashes, in screen pixels. */
const MISSING_DASH_PX = [3, 2.5] as const;
const NO_DASH: number[] = [];
/** Names of missing pages read quieter than page names. */
const MISSING_NAME_ALPHA = 0.75;

/** Values worked out once per frame (onRenderFramePre) and read by every draw call. */
export interface FrameState {
  scale: number;
  /** Page names' on-screen size at this zoom (graph-zoom.ts), and that over LABEL_PX (widths are measured at LABEL_PX). */
  namePx: number;
  nameScale: number;
  /**
   * Names are drawn in screen pixels (under scale(1/k)), so their font is a
   * true size: a tiny graph-unit font scaled up would stretch the letter and
   * word gaps (the browser rounds glyph advances at the tiny size).
   */
  font: string;
  /** The label font at its base size, for measuring. */
  measureFont: string;
  /** Island names, in screen pixels too. */
  clusterFont: string;
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
  /** The bridge badge's font (screen pixels), its font for measuring, and its base on-screen width (NaN until measured). */
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
    scale: 1, namePx: LABEL_PX, nameScale: 1, font: '', measureFont: `500 ${LABEL_PX}px ${bodyFamily}`,
    clusterFont: `700 ${CLUSTER_PX}px ${headingFamily}`,
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
    frame.dash[0] = MISSING_DASH_PX[0] / scale;
    frame.dash[1] = MISSING_DASH_PX[1] / scale;
    // Fonts are screen sizes: rebuilt only when the names' size steps (graph-zoom.ts).
    const px = grownPx(NAME_GROWTH, scale);
    if (px !== frame.namePx || frame.font === '') {
      frame.namePx = px;
      frame.nameScale = px / LABEL_PX;
      frame.font = `500 ${px}px ${frame.bodyFamily}`;
      frame.badgeFont = `700 ${BADGE_PX * frame.nameScale}px ${frame.headingFamily}`;
    }
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
 * Starts a frame's label space: the circles on screen, sorted into the grid,
 * and the lines on screen, which names keep off when they can (none at all
 * past NAME_LINES_MAX). While something is in focus only the lit circles and
 * lines count; the faded ones are background and may sit under a name.
 */
export function prepareLabels(
  buf: LabelBuffer, nodes: readonly ModelNode[], frame: FrameState, highlight: Highlight | null, links: Iterable<ModelLink> = []
): void {
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
  for (const l of highlight?.links ?? links) {
    const s = l.source;
    const t = l.target;
    if (typeof s !== 'object' || typeof t !== 'object') continue;
    if ((s.x < frame.minX && t.x < frame.minX) || (s.x > frame.maxX && t.x > frame.maxX)) continue;
    if ((s.y < frame.minY && t.y < frame.minY) || (s.y > frame.maxY && t.y > frame.maxY)) continue;
    if (!addSegment(space, s.x, s.y, t.x, t.y)) {
      space.segments = 0;
      break;
    }
  }
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
  const grow = frame.nameScale;
  const lineHeight = (frame.namePx + 2) / k;
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
      const shown = width * grow;
      const extra = badge ? (BADGE_GAP_PX + frame.badgeWidth) * grow : 0;
      const half = (shown + extra) / 2 / k + NAME_PAD_PX / k;
      if (placeName(space, n.x, n.y, clearRadius(n, k) + 1 / k, half, lineHeight, round === 0) < 0) continue;
      named += 1;
      const box = space.last;
      ctx.globalAlpha =
        (pass === 1 ? FADED_NAME_ALPHA : 1) * (n.archived ? ARCHIVED_ALPHA : 1) * (isMissingNode(n) ? MISSING_NAME_ALPHA : 1);
      if (space.lastLeader) drawLeader(ctx, n, box, k);
      // The name, then the badge, centred together in the box.
      const x = (box[0] + box[2]) / 2 - extra / 2 / k;
      // Screen space from here: true font sizes (see FrameState.font).
      ctx.save();
      ctx.translate(x, box[1] + 1 / k);
      ctx.scale(1 / k, 1 / k);
      ctx.font = frame.font;
      ctx.lineWidth = HALO_PX * grow;
      ctx.strokeStyle = CANVAS_BG;
      ctx.strokeText(n.shortLabel, 0, 0);
      ctx.fillText(n.shortLabel, 0, 0);
      if (badge) drawBadge(ctx, shown / 2 + BADGE_GAP_PX * grow, 0, frame);
      ctx.restore();
    }
  }
  ctx.restore();
}
