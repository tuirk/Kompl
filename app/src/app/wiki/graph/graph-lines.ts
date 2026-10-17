/**
 * The graph's lines beyond force-graph's own straight strokes: the arrowhead
 * of a directed relation and the zigzag of an opposition
 * (lib/graph-line-style.ts), the dashes of a missing page's line, the
 * per-canvas line state, and which lines answer the pointer (relation
 * names along lines: graph-line-labels.ts). Lines never use
 * topic colours: the caller passes each line's grey tier, lit or accent
 * colour.
 *
 * force-graph finds what is under the pointer by repainting every
 * pointer-aware line, each in its own colour, on a hidden canvas after each
 * redraw. Past POINTER_LINES_MAX visible lines only typed lines go on it, and
 * a missing page's lines never do (lib/graph-focus.ts takesPointer).
 *
 * These run per line per frame: they read the frame state and caches made
 * once, and allocate nothing. Client-only.
 */

import { limitsLinePointer, takesPointer } from '../../../lib/graph-focus';
import {
  LINE_PX, zigzagAmplitude, zigzagSteps, type LineStyle,
} from '../../../lib/graph-line-style';
import { isMissingLink } from '../../../lib/graph-missing';
import type { ModelLink, ModelNode } from '../../../lib/graph-model';
import type { FrameState } from './graph-draw';

/** The outer edge of the selection and hover rings (graph-draw.ts drawNode), in screen pixels past the radius. */
const PICKED_RING_PX = 6.5;
/** A missing page's line dashes, in screen pixels. */
const DASH_PX = 3;

/** Per-canvas line state: the dash pattern and label font at this zoom, label widths measured once. */
export interface LineFrame {
  scale: number;
  dash: number[];
  font: string;
  measureFont: string;
  bodyFamily: string;
  /** Label text -> on-screen width. */
  widths: Map<string, number>;
  labelled: number;
}

export function newLineFrame(bodyFamily: string): LineFrame {
  return {
    scale: 0, dash: [DASH_PX, DASH_PX], font: '', measureFont: `500 ${LINE_PX.labelFont}px ${bodyFamily}`, bodyFamily,
    widths: new Map(), labelled: 0,
  };
}

/** Called before each frame: zoom-dependent sizes, and the label count reset. */
export function beginLineFrame(lf: LineFrame, scale: number): void {
  lf.labelled = 0;
  if (scale === lf.scale) return;
  lf.scale = scale;
  lf.dash[0] = DASH_PX / scale;
  lf.dash[1] = DASH_PX / scale;
  lf.font = `500 ${LINE_PX.labelFont / scale}px ${lf.bodyFamily}`;
}

export type PointerAreaPaint = (link: object, color: string, ctx: CanvasRenderingContext2D, scale: number) => void;

/**
 * force-graph's linkPointerAreaPaint for these lines: undefined (its own,
 * every line) when every line may take the pointer, else a painter that
 * leaves the others off. `hoverPx` widens a line's target as
 * linkHoverPrecision does.
 */
export function pointerAreaFor(links: readonly ModelLink[], hoverPx: number): PointerAreaPaint | undefined {
  const limited = limitsLinePointer(links.length);
  if (!limited && !links.some(isMissingLink)) return undefined;
  return (link, color, ctx, scale) => {
    const l = link as ModelLink;
    if (!takesPointer(l, limited)) return;
    const s = l.source as ModelNode;
    const t = l.target as ModelNode;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = (l.width + hoverPx + 2) / scale;
    ctx.stroke();
  };
}

/** force-graph's linkCanvasObjectMode: the zigzag replaces the straight stroke; the arrow is added after it. */
export function lineMode(style: LineStyle | undefined): 'replace' | 'after' | undefined {
  return style?.shape === 'zigzag' ? 'replace' : style?.shape === 'arrow' ? 'after' : undefined;
}

/** The distance from a page's centre that lines and labels keep clear of (its circle and ring). */
export function clearOf(n: ModelNode, k: number): number {
  return n.radius + (n.ring ? 4.5 / k : 0);
}

export function outOfView(s: ModelNode, t: ModelNode, f: FrameState): boolean {
  return (s.x < f.minX && t.x < f.minX) || (s.x > f.maxX && t.x > f.maxX) || (s.y < f.minY && t.y < f.minY) || (s.y > f.maxY && t.y > f.maxY);
}

/**
 * force-graph's linkCanvasObject for a styled line: the zigzag of an
 * opposition (in place of the straight stroke; straight when short), or the
 * arrowhead of a directed relation at the edge of the circle it points to,
 * outside its ring when the page is `picked` (none when short). `color` is
 * the line's colour this frame.
 */
export function paintLineShape(
  ctx: CanvasRenderingContext2D, link: ModelLink, style: LineStyle, color: string, frame: FrameState,
  picked: ReadonlySet<string> | null = null
): void {
  const s = link.source as ModelNode;
  const t = link.target as ModelNode;
  if (typeof s !== 'object' || typeof t !== 'object' || outOfView(s, t, frame)) return;
  const k = frame.scale;
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const ux = dx / len;
  const uy = dy / len;
  const rs = clearOf(s, k);
  const rt = clearOf(t, k);
  const between = len - rs - rt;
  const long = between * k >= LINE_PX.minShape;
  if (style.shape === 'zigzag') {
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    if (long) {
      const steps = zigzagSteps(between * k, link.width);
      const amp = zigzagAmplitude(link.width) / k;
      const step = between / steps;
      const x0 = s.x + ux * rs;
      const y0 = s.y + uy * rs;
      ctx.lineTo(x0, y0);
      for (let i = 1; i < steps; i++) {
        const side = i % 2 === 1 ? amp : -amp;
        ctx.lineTo(x0 + ux * step * i - uy * side, y0 + uy * step * i + ux * side);
      }
    }
    ctx.lineTo(t.x, t.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = link.width / k;
    ctx.stroke();
    return;
  }
  if (style.shape !== 'arrow' || !long) return;
  // The arrow points at `to`: t when it is the line's target, else s (pointing back along the line).
  const dir = style.to === t.id ? 1 : -1;
  // A picked page (selected, hovered, a path end, the focus) wears a wider ring: stop outside it.
  const toNode = dir === 1 ? t : s;
  const edge = picked?.has(toNode.id) ? toNode.radius + PICKED_RING_PX / k : dir === 1 ? rt : rs;
  const reach = edge + LINE_PX.arrowGap / k;
  const tx = dir === 1 ? t.x - ux * reach : s.x + ux * reach;
  const ty = dir === 1 ? t.y - uy * reach : s.y + uy * reach;
  const lx = dir * ux * (LINE_PX.arrowLength / k);
  const ly = dir * uy * (LINE_PX.arrowLength / k);
  const half = LINE_PX.arrowHalfWidth / k;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx - lx - uy * half, ty - ly + ux * half);
  ctx.lineTo(tx - lx + uy * half, ty - ly - ux * half);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** force-graph's linkLineDash: a missing page's line is dashed (screen-constant, per LineFrame). */
export function lineDash(link: object, lf: LineFrame): number[] | null {
  return isMissingLink(link as ModelLink) ? lf.dash : null;
}
