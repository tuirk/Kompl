/**
 * How the knowledge graph's view moves (lib/graph-motion.ts): one glide
 * from view to view that any later move replaces, and reduced motion,
 * where moves jump and the layout settles before the first paint.
 */

import { describe, expect, it } from 'vitest';
import { LAYOUT, warmupTicks } from '../lib/graph-layout';
import { easeInOut, motionMs, reducedMotionTicks, SETTLE_TICKS, tweenView } from '../lib/graph-motion';

describe('view glides', () => {
  const from = { x: 0, y: 100, k: 0.5 };
  const to = { x: 400, y: -100, k: 2 };

  it('starts at the current view and ends exactly at the target', () => {
    expect(tweenView(from, to, 0)).toEqual(from);
    expect(tweenView(from, to, 1)).toEqual(to);
  });

  it('moves the centre in a straight line and the zoom on a log scale', () => {
    const mid = tweenView(from, to, 0.5);
    expect(mid.x).toBeCloseTo(200);
    expect(mid.y).toBeCloseTo(0);
    expect(mid.k).toBeCloseTo(1); // halfway between x0.5 and x2 is x1
  });

  it('eases in and out', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.1)).toBeLessThan(0.1);
    expect(easeInOut(0.9)).toBeGreaterThan(0.9);
  });
});

describe('reduced motion', () => {
  it('turns every view move into a jump', () => {
    expect(motionMs(600, false)).toBe(600);
    expect(motionMs(600, true)).toBe(0);
  });

  it('counts the ticks from a fresh layout until the simulation stops', () => {
    let alpha = 1;
    for (let i = 0; i < SETTLE_TICKS; i++) alpha += (0 - alpha) * LAYOUT.alphaDecay;
    expect(alpha).toBeLessThan(LAYOUT.alphaMin);
    expect(alpha / (1 - LAYOUT.alphaDecay)).toBeGreaterThanOrEqual(LAYOUT.alphaMin); // one tick fewer is not enough
  });

  it('settles the whole layout before the first paint, sharing the work out on large maps', () => {
    expect(reducedMotionTicks(10)).toBe(SETTLE_TICKS);
    expect(reducedMotionTicks(LAYOUT.largeGraphNodes)).toBe(SETTLE_TICKS);
    expect(reducedMotionTicks(LAYOUT.largeGraphNodes * 2)).toBe(Math.round(SETTLE_TICKS / 2));
    // Never fewer than the usual warm-up of a large map.
    expect(reducedMotionTicks(50_000)).toBe(warmupTicks(50_000));
  });
});
