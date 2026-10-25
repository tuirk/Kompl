'use client';

/**
 * The graph's hover: the page or line force-graph reports under the pointer,
 * shown only while the pointer is over the canvas itself (lib/graph-focus.ts
 * acceptHover). force-graph never clears its last pointer position, so on a
 * panel, the legend or a zoom button its reports are ignored. On the way
 * back in it reports only a change, so once it has tested the new point (its
 * next frame) the hover it holds is taken over. Missing names' lines are not
 * hovered. A click hides the hover card for what was clicked until the
 * pointer leaves it (`card`, lib/graph-focus.ts cardHover); the hover itself
 * stays lit. Client-only.
 */

import { useCallback, useRef, useState } from 'react';
import { acceptHover, cardHover, focusKey, type GraphFocus } from '../../../lib/graph-focus';
import { isMissingLink } from '../../../lib/graph-missing';
import type { ModelLink, ModelNode } from '../../../lib/graph-model';

export function useCanvasHover() {
  const [hovered, setHovered] = useState<GraphFocus | null>(null);
  /** The clicked page or line whose card stays hidden while the pointer is on it. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const dismissedRef = useRef<string | null>(null);
  /** force-graph's own hover, kept while it is ignored. */
  const reported = useRef<GraphFocus | null>(null);
  const overCanvas = useRef(false);

  const keepCard = useCallback((key: string | null) => {
    if (dismissedRef.current === key) return;
    dismissedRef.current = key;
    setDismissed(key);
  }, []);
  const report = useCallback((focus: GraphFocus | null) => {
    reported.current = focus;
    if (focusKey(focus) !== dismissedRef.current) keepCard(null);
    setHovered(acceptHover(overCanvas.current, focus));
  }, [keepCard]);
  const hoverNode = useCallback(
    (node: object | null) => report(node ? { kind: 'node', id: (node as ModelNode).id } : null),
    [report]
  );
  const hoverLink = useCallback(
    (link: object | null) => report(link && !isMissingLink(link as ModelLink) ? { kind: 'link', link: link as ModelLink } : null),
    [report]
  );
  /** Whether the pointer is over the canvas now (the wrapper's pointer move, down and leave). */
  const track = useCallback((over: boolean) => {
    if (over === overCanvas.current) return;
    overCanvas.current = over;
    if (!over) {
      keepCard(null);
      setHovered(null);
      return;
    }
    requestAnimationFrame(() => {
      if (overCanvas.current) setHovered(acceptHover(true, reported.current));
    });
  }, [keepCard]);
  /** A page or line was clicked: its card hides until the pointer moves off it. */
  const dismissCard = useCallback((focus: GraphFocus) => keepCard(focusKey(focus)), [keepCard]);

  return { hovered, card: cardHover(hovered, dismissed), hoverNode, hoverLink, track, dismissCard };
}
