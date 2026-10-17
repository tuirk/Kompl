/**
 * What a page name may carry on the graph canvas (graph-draw.ts drawLabels):
 * the "BRIDGE" badge after a bridge page's name, and the faint leader line
 * from a circle to its name when the name had to go far out. Sizes grow with
 * the names (FrameState.nameScale). Nothing is allocated per name.
 * Client-only.
 */

import type { ModelNode } from '../../../lib/graph-model';
import type { FrameState } from './graph-draw';

export const BADGE_TEXT = 'BRIDGE';
/** The badge's size at the names' base size, in screen pixels. */
export const BADGE_PX = 9;
/** Gap between a name and its badge, at the names' base size. */
export const BADGE_GAP_PX = 5;
/** Neutral, not the accent: on the canvas the accent only marks the selection, a clicked line or a path. */
const BADGE_COLOR = 'rgba(230,237,243,0.72)';
const LEADER_COLOR = 'rgba(230,237,243,0.3)';

/**
 * "BRIDGE" in small capitals, starting at x, vertically centred on a name
 * drawn from y. Screen space: called under the name's scale(1/k), so x, y
 * and the font are in screen pixels. The text style is restored.
 */
export function drawBadge(ctx: CanvasRenderingContext2D, x: number, y: number, frame: FrameState): void {
  const fill = ctx.fillStyle;
  const align = ctx.textAlign;
  ctx.font = frame.badgeFont;
  ctx.textAlign = 'left';
  const dy = (frame.namePx - BADGE_PX * frame.nameScale) / 2;
  ctx.strokeText(BADGE_TEXT, x, y + dy);
  ctx.fillStyle = BADGE_COLOR;
  ctx.fillText(BADGE_TEXT, x, y + dy);
  ctx.fillStyle = fill;
  ctx.textAlign = align;
}

/** A faint line from the circle's edge to the nearest point of its far-placed name. */
export function drawLeader(ctx: CanvasRenderingContext2D, n: ModelNode, box: Float64Array, k: number): void {
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
