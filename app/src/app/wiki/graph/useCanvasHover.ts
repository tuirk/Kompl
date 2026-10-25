'use client';

/**
 * The graph's hover: the page or line force-graph reports under the pointer,
 * shown only while the pointer is over the canvas itself (lib/graph-focus.ts
 * acceptHover). force-graph never clears its last pointer position, so on a
 * panel, the legend or a zoom button its reports are ignored. On the way
 * back in it reports only a change, so once it has tested the new point (its
 * next frame) the hover it holds is taken over. Missing names' lines are not
 * hovered. Client-only.
 */

import { useCallback, useRef, useState } from 'react';
import { acceptHover, type GraphFocus } from '../../../lib/graph-focus';
import { isMissingLink } from '../../../lib/graph-missing';
import type { ModelLink, ModelNode } from '../../../lib/graph-model';

export function useCanvasHover() {
  const [hovered, setHovered] = useState<GraphFocus | null>(null);
  /** force-graph's own hover, kept while it is ignored. */
  const reported = useRef<GraphFocus | null>(null);
  const overCanvas = useRef(false);

  const report = useCallback((focus: GraphFocus | null) => {
    reported.current = focus;
    setHovered(acceptHover(overCanvas.current, focus));
  }, []);
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
      setHovered(null);
      return;
    }
    requestAnimationFrame(() => {
      if (overCanvas.current) setHovered(acceptHover(true, reported.current));
    });
  }, []);

  return { hovered, hoverNode, hoverLink, track };
}
