'use client';

/**
 * The callbacks force-graph draws the graph's lines with (graph-lines.ts):
 * each line's colour this frame, its arrowhead or zigzag, a missing page's
 * dashes and the pointer areas. Colour: the grey tier of the line's kind;
 * the lines of the hovered or selected page, or the hovered line, lit (a
 * plain link stays at its own tier); the
 * clicked line and a found path in the accent; everything else faded while
 * something is in focus. New callbacks whenever that changes, which is what
 * makes force-graph redraw. Client-only.
 */

import { useCallback, useMemo, useRef, type MutableRefObject } from 'react';
import type { GraphFocus, Highlight } from '../../../lib/graph-focus';
import { buildLineStyles } from '../../../lib/graph-line-style';
import type { GraphModel, ModelLink, VisibleGraph } from '../../../lib/graph-model';
import { ACCENT_HEX } from '../../../lib/graph-palette';
import type { FrameState } from './graph-draw';
import { lineDash, lineMode, newLineFrame, paintLineShape, pointerAreaFor, type LineFrame } from './graph-lines';

/** Extra pixels around a line that still count as hovering it. */
export const LINK_HOVER_PX = 8;


export function useLinePaint(
  model: GraphModel, visible: VisibleGraph, highlight: Highlight | null, pinned: Highlight | null,
  selected: GraphFocus | null, frame: MutableRefObject<FrameState>, picked: ReadonlySet<string> | null = null
) {
  const styles = useMemo(() => buildLineStyles(model.links), [model]);
  const lines = useRef<LineFrame>(newLineFrame('Inter, system-ui, sans-serif'));
  const accent = useMemo(() => {
    const set = new Set<ModelLink>(pinned?.links ?? []);
    if (selected?.kind === 'link') set.add(selected.link);
    return set;
  }, [pinned, selected]);

  const linkColor = useCallback(
    (link: object) => {
      const l = link as ModelLink;
      if (highlight !== null && !highlight.links.has(l)) return l.faded;
      if (accent.has(l)) return ACCENT_HEX;
      // Lit lines brighten, but a plain link keeps its own faint tier so typed lines stay stronger.
      return highlight !== null && l.kind !== 'plain' ? l.bright : l.color;
    },
    [highlight, accent]
  );
  const linkMode = useCallback((link: object) => lineMode(styles.get(link as ModelLink)) ?? '', [styles]);
  const linkObject = useCallback(
    (link: object, ctx: CanvasRenderingContext2D) => {
      const l = link as ModelLink;
      const style = styles.get(l);
      if (style) paintLineShape(ctx, l, style, linkColor(l), frame.current, picked);
    },
    [styles, linkColor, frame, picked]
  );
  const dash = useCallback((link: object) => lineDash(link, lines.current), []);
  // Width means sources only: never changed by the focus, only grown with the zoom (LineFrame.grow).
  const width = useCallback((link: object) => (link as ModelLink).width * lines.current.grow, []);
  // Many lines: only typed ones go on force-graph's hit-test canvas.
  const pointerArea = useMemo(() => pointerAreaFor(visible.links, LINK_HOVER_PX), [visible]);

  return { styles, lines, linkColor, width, linkMode, linkObject, dash, pointerArea };
}
