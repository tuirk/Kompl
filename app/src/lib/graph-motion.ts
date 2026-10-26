/**
 * How the knowledge graph's view moves: one eased glide from the current
 * view to a target (the centre in a straight line, the zoom on a log scale),
 * and what changes when the viewer asks for reduced motion
 * (prefers-reduced-motion): view moves jump, and the layout runs to rest
 * before the first paint, then stays still. Pure.
 */

import { LAYOUT, warmupTicks, type GraphView } from './graph-layout';

/** Quadratic ease in and out, for t in [0, 1]. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/** The view a fraction `t` of the way from `from` to `to`. */
export function tweenView(from: GraphView, to: GraphView, t: number): GraphView {
  if (t >= 1) return to;
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    k: from.k * (to.k / from.k) ** t,
  };
}

/** A view move's duration: none with reduced motion. */
export function motionMs(ms: number, reduced: boolean): number {
  return reduced ? 0 : ms;
}

/** Simulation ticks from a fresh layout (alpha 1) until it stops (alpha below LAYOUT.alphaMin). */
export const SETTLE_TICKS = Math.ceil(Math.log(LAYOUT.alphaMin) / Math.log(1 - LAYOUT.alphaDecay));

/**
 * Warm-up ticks (run before the first paint) with reduced motion: the whole
 * layout up to LAYOUT.largeGraphNodes pages; past that a share that keeps
 * the work near a full large map's, never fewer than the usual warm-up.
 * The layout then stops where it is, so the map never drifts.
 */
export function reducedMotionTicks(nodeCount: number): number {
  if (nodeCount <= LAYOUT.largeGraphNodes) return SETTLE_TICKS;
  return Math.max(warmupTicks(nodeCount), Math.round((SETTLE_TICKS * LAYOUT.largeGraphNodes) / nodeCount));
}
