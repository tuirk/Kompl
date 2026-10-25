/**
 * The category names over each island of the knowledge graph, drawn when
 * zoomed out and faded as you zoom in. They claim their place in the label
 * space before any page name, so page names keep clear of them. Per-island
 * sums use buffers made once per load; nothing is allocated per page.
 * Client-only.
 */

import { forcePlace } from '../../../lib/graph-labels';
import { isMissingNode } from '../../../lib/graph-missing';
import type { CategoryInfo, ModelNode } from '../../../lib/graph-model';
import { CANVAS_BG } from '../../../lib/graph-palette';
import { CLUSTER_PX, CLUSTER_SPACING, type FrameState, type LabelBuffer } from './graph-draw';

/** Island names are fully shown up to CLUSTER_FULL and gone by CLUSTER_GONE. */
const CLUSTER_FULL = 1.3;
const CLUSTER_GONE = 2.4;
const CLUSTER_SPACING_PX = `${CLUSTER_SPACING}px`;
/** Island names this visible keep page names out of their way. */
const ISLAND_CLAIM_ALPHA = 0.3;

/** Per-island sums for the island names; sized once per model, reused every frame. */
export interface ClusterBuffer {
  count: Float64Array;
  sumX: Float64Array;
  sumY: Float64Array;
  sumSq: Float64Array;
  top: Float64Array;
}

export function newClusterBuffer(size: number): ClusterBuffer {
  return {
    count: new Float64Array(size), sumX: new Float64Array(size), sumY: new Float64Array(size),
    sumSq: new Float64Array(size), top: new Float64Array(size),
  };
}

/** How strongly island names show at this zoom: 1 zoomed out, 0 zoomed in. */
export function clusterLabelAlpha(scale: number): number {
  return Math.min(1, Math.max(0, (CLUSTER_GONE - scale) / (CLUSTER_GONE - CLUSTER_FULL)));
}

/**
 * Each island's name, centred over its pages and just above the topmost one
 * (or two spreads above the centre, when one page strays far out). Islands
 * of one page are left to that page's own name; missing names in `nodes`
 * are left out. While clearly shown, the
 * names claim their boxes in the label space (call after prepareLabels).
 */
export function drawClusterLabels(
  ctx: CanvasRenderingContext2D, nodes: readonly ModelNode[], categories: readonly CategoryInfo[],
  buf: ClusterBuffer, frame: FrameState, dimmed: boolean, labels: LabelBuffer
): void {
  const k = frame.scale;
  const alpha = clusterLabelAlpha(k) * (dimmed ? 0.35 : 1);
  if (alpha <= 0) return;
  const claims = !dimmed && alpha >= ISLAND_CLAIM_ALPHA;
  buf.count.fill(0); buf.sumX.fill(0); buf.sumY.fill(0); buf.sumSq.fill(0); buf.top.fill(Infinity);
  for (const n of nodes) {
    // A missing name wears its home page's island but is not a page: it never titles or moves one.
    if (isMissingNode(n)) continue;
    const i = n.catIndex;
    buf.count[i] += 1;
    buf.sumX[i] += n.x;
    buf.sumY[i] += n.y;
    buf.sumSq[i] += n.x * n.x + n.y * n.y;
    if (n.y - n.radius < buf.top[i]) buf.top[i] = n.y - n.radius;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  // Screen space: true font sizes (a tiny graph-unit font scaled up stretches the letters).
  ctx.scale(1 / k, 1 / k);
  ctx.font = frame.clusterFont;
  ctx.letterSpacing = CLUSTER_SPACING_PX;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = CANVAS_BG;
  for (let i = 0; i < categories.length; i++) {
    const count = buf.count[i];
    if (count < 2) continue;
    const mx = buf.sumX[i] / count;
    const my = buf.sumY[i] / count;
    const spread = Math.sqrt(Math.max(0, buf.sumSq[i] / count - mx * mx - my * my));
    const y = Math.max(buf.top[i], my - 2 * spread) - 8 / k;
    if (claims) {
      if (Number.isNaN(labels.islandWidths[i])) labels.islandWidths[i] = ctx.measureText(categories[i].mapLabel).width;
      const half = (labels.islandWidths[i] / 2 + 4) / k;
      forcePlace(labels.space, mx - half, y - (CLUSTER_PX + 2) / k, mx + half, y);
    }
    ctx.fillStyle = categories[i].color;
    ctx.strokeText(categories[i].mapLabel, mx * k, y * k);
    ctx.fillText(categories[i].mapLabel, mx * k, y * k);
  }
  ctx.restore();
}
