/**
 * How a knowledge-graph line shows the kind of relation it carries, beyond
 * its brightness tier and width (graph-model.ts, graph-palette.ts): an
 * arrowhead for a directed relation (part of / includes, uses, created by),
 * pointing the way the line reads ("A — Uses → B"); a zigzag for opposition
 * (competes with, contradicts); a straight line otherwise. Also the relation
 * name a line is labelled with, and the screen sizes the canvas draws these
 * at (app/wiki/graph/graph-lines.ts). Worked out once per load. Pure and
 * client-safe.
 */

import { readingOrder, namedRelation } from './graph-focus';
import type { ModelLink } from './graph-model';
import { relationLabel } from './relation-labels';

export type LineShape = 'straight' | 'arrow' | 'zigzag';

export interface LineStyle {
  shape: LineShape;
  /** The page the line reads from (where an arrow starts) and to (where it points). */
  from: string;
  to: string;
  /** The relation name read from `from` ("uses", "used by", "related"); null for a plain link. */
  label: string | null;
}

export const DIRECTED_TYPES: ReadonlySet<string> = new Set(['part_of', 'uses', 'created_by']);
export const OPPOSED_TYPES: ReadonlySet<string> = new Set(['competes_with', 'contradicts']);

/** Screen pixels. */
export const LINE_PX = {
  arrowLength: 7,
  arrowHalfWidth: 2.25,
  /** Between the arrow's tip and the circle it points at. */
  arrowGap: 2,
  /** Arrows and zigzags only on lines at least this long between the two circles. */
  minShape: 24,
  /** Labels on typed lines when zoomed in, on lines at least this long. */
  minLabel: 70,
  labelFont: 10,
  labelHeight: 14,
  labelPadX: 5,
} as const;

/** Zoom from which every long enough typed line is labelled. */
export const LINE_LABEL_ZOOM = 2;
/** Most line labels in one frame. */
export const LINE_LABELS_MAX = 150;

/** "Uses" -> "uses"; "related to" reads "related". */
export function lineLabelText(type: string, direction: 'out' | 'in'): string {
  return type === 'related_to' ? 'related' : relationLabel(type, direction).toLowerCase();
}

export function lineStyle(link: Pick<ModelLink, 'a' | 'b' | 'relations' | 'colorType'>): LineStyle {
  const [from, to] = readingOrder(link);
  const named = namedRelation(link);
  if (!named) return { shape: 'straight', from, to, label: null };
  const direction = from === link.a ? named.direction : named.direction === 'out' ? 'in' : 'out';
  const shape: LineShape = DIRECTED_TYPES.has(named.type) ? 'arrow' : OPPOSED_TYPES.has(named.type) ? 'zigzag' : 'straight';
  return { shape, from, to, label: lineLabelText(named.type, direction) };
}

export function buildLineStyles(links: readonly ModelLink[]): Map<ModelLink, LineStyle> {
  return new Map(links.map((l) => [l, lineStyle(l)]));
}

/** A zigzag's amplitude in screen pixels, for a line `widthPx` wide. */
export function zigzagAmplitude(widthPx: number): number {
  return 1.5 + 0.5 * widthPx;
}

/** A zigzag's period in screen pixels. */
export function zigzagPeriod(widthPx: number): number {
  return 8 + 2 * widthPx;
}

/** Half-periods of a zigzag over `lengthPx` (even, at least 2), so it starts and ends on the line. */
export function zigzagSteps(lengthPx: number, widthPx: number): number {
  return Math.max(2, 2 * Math.round(lengthPx / zigzagPeriod(widthPx)));
}

/** The angle of a line's label: along the line, turned so the text never reads upside down. */
export function uprightAngle(dx: number, dy: number): number {
  const a = Math.atan2(dy, dx);
  return a > Math.PI / 2 ? a - Math.PI : a < -Math.PI / 2 ? a + Math.PI : a;
}

/** Half the width and height of the axis-aligned box around a w x h box turned by `angle`. */
export function turnedHalfExtents(w: number, h: number, angle: number): { hx: number; hy: number } {
  const [c, s] = [Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle))];
  return { hx: (c * w + s * h) / 2, hy: (s * w + c * h) / 2 };
}
