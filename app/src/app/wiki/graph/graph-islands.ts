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
  /** Where each island name sits (graph units), and whether a larger neighbour's name covers it. */
  left: Float64Array;
  right: Float64Array;
  boxTop: Float64Array;
  baseline: Float64Array;
  hidden: Uint8Array;
  order: number[];
}

export function newClusterBuffer(size: number): ClusterBuffer {
  return {
    count: new Float64Array(size), sumX: new Float64Array(size), sumY: new Float64Array(size),
    sumSq: new Float64Array(size), top: new Float64Array(size),
    left: new Float64Array(size), right: new Float64Array(size), boxTop: new Float64Array(size),
    baseline: new Float64Array(size), hidden: new Uint8Array(size), order: [],
  };
}

/**
 * Marks in `hidden` every island name whose box overlaps the box of a name
 * kept before it, going from the island with most pages to the fewest (ties
 * by position). Only islands with `count` above 0 take part.
 */
export function hideOverlappingNames(
  count: ArrayLike<number>, left: ArrayLike<number>, right: ArrayLike<number>,
  top: ArrayLike<number>, bottom: ArrayLike<number>, hidden: Uint8Array, order: number[]
): void {
  hidden.fill(0);
  order.length = 0;
  for (let i = 0; i < count.length; i++) if (count[i] > 0) order.push(i);
  order.sort((a, b) => count[b] - count[a] || a - b);
  let kept = 0;
  for (let n = 0; n < order.length; n++) {
    const i = order[n];
    let covered = false;
    for (let m = 0; m < kept && !covered; m++) {
      const j = order[m];
      covered = left[i] < right[j] && right[i] > left[j] && top[i] < bottom[j] && bottom[i] > top[j];
    }
    if (covered) hidden[i] = 1;
    else order[kept++] = i;
  }
}

/** How strongly island names show at this zoom: 1 zoomed out, 0 zoomed in. */
export function clusterLabelAlpha(scale: number): number {
  return Math.min(1, Math.max(0, (CLUSTER_GONE - scale) / (CLUSTER_GONE - CLUSTER_FULL)));
}

/**
 * Each island's name, centred over its pages and just above the topmost one
 * (or two spreads above the centre, when one page strays far out). An
 * island of one page gets its name too: the page's own name says nothing of
 * its topic, and the page would pass for part of the island beside it
 * (topics past the eighth even share one grey). Missing names in `nodes`
 * are left out. A name that would cover a larger island's name is left out too. While clearly shown, the names claim their boxes in the
 * label space (call after prepareLabels).
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
    if (count === 0) continue;
    const mx = buf.sumX[i] / count;
    const my = buf.sumY[i] / count;
    const spread = Math.sqrt(Math.max(0, buf.sumSq[i] / count - mx * mx - my * my));
    const y = Math.max(buf.top[i], my - 2 * spread) - 8 / k;
    if (Number.isNaN(labels.islandWidths[i])) labels.islandWidths[i] = ctx.measureText(categories[i].mapLabel).width;
    const half = (labels.islandWidths[i] / 2 + 4) / k;
    buf.left[i] = mx - half;
    buf.right[i] = mx + half;
    buf.boxTop[i] = y - (CLUSTER_PX + 2) / k;
    buf.baseline[i] = y;
  }
  // Close islands would print their names over each other: the larger island keeps its name.
  hideOverlappingNames(buf.count, buf.left, buf.right, buf.boxTop, buf.baseline, buf.hidden, buf.order);
  for (let i = 0; i < categories.length; i++) {
    if (buf.count[i] === 0 || buf.hidden[i]) continue;
    if (claims) forcePlace(labels.space, buf.left[i], buf.boxTop[i], buf.right[i], buf.baseline[i]);
    const x = (buf.left[i] + buf.right[i]) / 2;
    ctx.fillStyle = categories[i].color;
    ctx.strokeText(categories[i].mapLabel, x * k, buf.baseline[i] * k);
    ctx.fillText(categories[i].mapLabel, x * k, buf.baseline[i] * k);
  }
  ctx.restore();
}
