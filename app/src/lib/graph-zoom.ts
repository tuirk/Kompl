/**
 * How the knowledge graph's text and lines grow as you zoom in. Up to a
 * zoom they keep a fixed size on screen, as force-graph draws them; past it
 * they grow with the square root of the zoom (more slowly than the map, so
 * pages still gain room) up to a cap. Page names grow a little more than
 * relation labels, so names stay the dominant text. Text sizes step in half
 * pixels, so a font is rebuilt only when its step changes. Pure.
 */

export interface TextGrowth {
  /** On-screen size up to `from`. */
  px: number;
  /** Zoom where growing starts. */
  from: number;
  /** On-screen size never exceeds this. */
  maxPx: number;
}

/** Relation names along lines: 10 px up to zoom 2, at most 16 px. */
export const LINE_LABEL_GROWTH: TextGrowth = { px: 10, from: 2, maxPx: 16 };
/** Page names: 12 px up to zoom 1.6, at most 20 px. */
export const NAME_GROWTH: TextGrowth = { px: 12, from: 1.6, maxPx: 20 };
/** Line widths (and arrowheads and zigzags with them): x1 up to zoom 1.5, at most x1.9. */
export const LINE_GROWTH = { from: 1.5, max: 1.9 } as const;

/** The on-screen text size at zoom `scale`, in half-pixel steps. */
export function grownPx(growth: TextGrowth, scale: number): number {
  const px = growth.px * Math.sqrt(Math.max(1, scale / growth.from));
  return Math.min(growth.maxPx, Math.round(px * 2) / 2);
}

/** The factor line widths, arrowheads and zigzags are multiplied by at zoom `scale`. */
export function lineGrowth(scale: number): number {
  return Math.min(LINE_GROWTH.max, Math.sqrt(Math.max(1, scale / LINE_GROWTH.from)));
}
