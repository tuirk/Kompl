'use client';

/**
 * Moving the graph's view: fit the map (or some pages) into the free part of
 * the canvas between the legend and the panel, centre a page, and the zoom
 * buttons, which zoom about the selection when it shows in the free area,
 * else about the free area's middle (lib/graph-layout.ts zoomAnchor). A zoom
 * press glides with that point held still on screen. Client-only.
 */

import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraphMethods } from 'react-force-graph-2d';
import { centerFor, fitView, zoomAnchor, zoomAround, type GraphView, type ViewInsets } from '../../../lib/graph-layout';
import type { GraphModel, ModelNode } from '../../../lib/graph-model';

/** What the page can ask of the canvas. */
export interface GraphControls {
  /** Centre a page in the free part of the canvas and zoom in to it. */
  focusNode(id: string): void;
  /** Fit these pages into the free part of the canvas (a found path). */
  fitNodes(ids: readonly string[]): void;
}

const FOCUS_ZOOM = 2;
/** Fitting a few pages never zooms in closer than this. */
const FIT_NODES_MAX_ZOOM = 2.5;
/** Room around fitted pages, in graph units. */
const FIT_NODES_PAD = 40;
const ZOOM_MS = 300;

type ViewRef = MutableRefObject<{ width: number; height: number; insets: ViewInsets }>;
type Point = { x: number; y: number };

export function useCanvasControls(
  fgRef: MutableRefObject<ForceGraphMethods | undefined>,
  viewRef: ViewRef,
  model: GraphModel,
  controlsRef: MutableRefObject<GraphControls | null>,
  /** The point zoom buttons zoom about (the selection), read when pressed. */
  aboutRef: MutableRefObject<() => Point | null>
) {
  const glide = useRef(0);
  useEffect(() => () => cancelAnimationFrame(glide.current), []);

  /** zoomToFit, but into the free area between the legend and the panel. */
  const fitMap = useCallback((ms: number) => {
    const fg = fgRef.current;
    const bbox = fg?.getGraphBbox();
    if (!fg || !bbox) return;
    const { width: w, height: h, insets } = viewRef.current;
    const view = fitView(bbox, w, h, insets);
    fg.centerAt(view.x, view.y, ms);
    fg.zoom(view.k, ms);
  }, [fgRef, viewRef]);

  useEffect(() => {
    controlsRef.current = {
      focusNode(id) {
        const node = model.byId.get(id);
        const fg = fgRef.current;
        if (!node || !fg) return;
        const { width: w, height: h, insets } = viewRef.current;
        const k = Math.max(fg.zoom(), FOCUS_ZOOM);
        const at = centerFor(node.x, node.y, k, w, h, insets);
        fg.centerAt(at.x, at.y, 600);
        fg.zoom(k, 600);
      },
      fitNodes(ids) {
        const fg = fgRef.current;
        const nodes = ids.map((id) => model.byId.get(id)).filter((n): n is ModelNode => n !== undefined);
        if (!fg || nodes.length === 0) return;
        const xs = nodes.map((n) => n.x);
        const ys = nodes.map((n) => n.y);
        const bbox = {
          x: [Math.min(...xs) - FIT_NODES_PAD, Math.max(...xs) + FIT_NODES_PAD] as [number, number],
          y: [Math.min(...ys) - FIT_NODES_PAD, Math.max(...ys) + FIT_NODES_PAD] as [number, number],
        };
        const { width: w, height: h, insets } = viewRef.current;
        const view = fitView(bbox, w, h, insets, FIT_NODES_MAX_ZOOM);
        fg.centerAt(view.x, view.y, 600);
        fg.zoom(view.k, 600);
      },
    };
    return () => {
      controlsRef.current = null;
    };
  }, [controlsRef, model, fgRef, viewRef]);

  const zoomBy = useCallback((factor: number) => {
    const fg = fgRef.current;
    if (!fg) return;
    cancelAnimationFrame(glide.current);
    const center = fg.centerAt();
    const from: GraphView = { x: center.x, y: center.y, k: fg.zoom() };
    const { width: w, height: h, insets } = viewRef.current;
    const about = zoomAnchor(from, w, h, insets, aboutRef.current());
    const to = zoomAround(from, about, from.k * factor);
    const start = performance.now();
    // Zoom on a log scale with the anchor held still; centerAt and zoom each animated alone would drift.
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ZOOM_MS);
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const view = zoomAround(from, about, from.k * (to.k / from.k) ** eased);
      fg.zoom(view.k);
      fg.centerAt(view.x, view.y);
      if (t < 1) glide.current = requestAnimationFrame(step);
    };
    glide.current = requestAnimationFrame(step);
  }, [fgRef, viewRef, aboutRef]);

  return { fitMap, zoomBy };
}
