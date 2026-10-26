'use client';

/**
 * Moving the graph's view: fit the map (or some pages) into the free part of
 * the canvas between the legend and the panel, centre a page, and the zoom
 * buttons, which zoom about the selection when it shows in the free area,
 * else about the free area's middle (lib/graph-layout.ts zoomAnchor). A zoom
 * press glides with that point held still on screen.
 *
 * Automatic fits happen only on the first load, on a change of focus or
 * depth or of which pages the legend shows (`fitKey`), for a found path, on
 * the fit button and, while the viewer has not moved the map, when the
 * canvas is resized: an early fit once
 * the warm-up has placed the pages, then a refinement when the layout
 * settles. Once the viewer zooms, pans, drags or picks a page or line
 * (`markMoved`), a pending automatic fit is dropped: their view wins. Until
 * then, when the filter panel expands, collapses or is resized, the map
 * glides sideways (pan only) to stay centred in the new free area; after a
 * viewer's move it stays put.
 *
 * Every view move runs here, one at a time: a new one (or the viewer taking
 * over) stops the one running, so a fit's glide never undoes a later zoom
 * press. With reduced motion the moves jump (lib/graph-motion.ts).
 * Client-only.
 */

import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { ForceGraphMethods } from 'react-force-graph-2d';
import {
  autoFit, centerFor, fitView, LAYOUT_SCALE, panView, recentrePan, zoomAnchor, zoomAround, type GraphView, type ViewInsets,
} from '../../../lib/graph-layout';
import { fitWithNames, type FitItem } from '../../../lib/graph-fit';
import type { GraphModel, ModelNode } from '../../../lib/graph-model';
import { easeInOut, motionMs, tweenView } from '../../../lib/graph-motion';

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
const FIT_NODES_PAD = 40 * LAYOUT_SCALE;
const ZOOM_MS = 300;
/** The sideways glide that keeps a fitted map centred when the filter panel changes. */
const RECENTRE_MS = 300;
/** After a change of scope, the first fit once the new layout's warm-up has run (ms). */
const EARLY_FIT_MS = 80;

type ViewRef = MutableRefObject<{ width: number; height: number; insets: ViewInsets }>;
type Point = { x: number; y: number };

export function useCanvasControls(
  fgRef: MutableRefObject<ForceGraphMethods | undefined>,
  viewRef: ViewRef,
  model: GraphModel,
  controlsRef: MutableRefObject<GraphControls | null>,
  /** The point zoom buttons zoom about (the selection), read when pressed. */
  aboutRef: MutableRefObject<() => Point | null>,
  /**
   * When the canvas has its forces in, the scope key, how many pages it draws, what a fit keeps in view, the
   * free area's left edge, the canvas size, and reduced motion.
   */
  auto: {
    ready: boolean; fitKey: string; nodeCount: () => number; fitItems: () => FitItem[]; insetLeft: number; size: string;
    reducedMotion: boolean;
  }
) {
  const reduced = useRef(auto.reducedMotion);
  reduced.current = auto.reducedMotion;
  /** The running view move (one animation frame request at a time). */
  const glide = useRef(0);
  /** Where a running sideways glide is heading, so a further change continues from there. */
  const panTarget = useRef<Point | null>(null);
  /** Where a running move or zoom is heading. */
  const heading = useRef<GraphView | null>(null);
  const stopGlide = useCallback(() => {
    cancelAnimationFrame(glide.current);
    panTarget.current = null;
    heading.current = null;
  }, []);
  useEffect(() => stopGlide, [stopGlide]);
  /** The viewer zoomed, panned, dragged or picked something since the last fit. */
  const userMoved = useRef(false);
  /** The viewer takes over: a running move stops and a pending automatic fit will be dropped. */
  const markMoved = useCallback(() => {
    userMoved.current = true;
    stopGlide();
  }, [stopGlide]);
  const fitPending = useRef(false);
  const fittedOnce = useRef(false);

  /** Glide the view to `to` (at once with reduced motion), stopping any move still running. */
  const moveTo = useCallback((to: GraphView, ms: number) => {
    const fg = fgRef.current;
    if (!fg) return;
    stopGlide();
    const show = (v: GraphView) => {
      fg.zoom(v.k);
      fg.centerAt(v.x, v.y);
    };
    const duration = motionMs(ms, reduced.current);
    if (duration <= 0) {
      show(to);
      return;
    }
    const now = fg.centerAt();
    const from: GraphView = { x: now.x, y: now.y, k: fg.zoom() };
    const began = performance.now();
    heading.current = to;
    const step = (t0: number) => {
      const t = Math.max(0, Math.min(1, (t0 - began) / duration));
      show(tweenView(from, to, easeInOut(t)));
      if (t < 1) glide.current = requestAnimationFrame(step);
      else heading.current = null;
    };
    glide.current = requestAnimationFrame(step);
  }, [fgRef, stopGlide]);

  /** The view once the running move or zoom ends (the current view when none runs). */
  const viewTarget = useCallback((): GraphView | null => {
    const fg = fgRef.current;
    if (!fg) return null;
    if (heading.current) return heading.current;
    const now = fg.centerAt();
    return { x: now.x, y: now.y, k: fg.zoom() };
  }, [fgRef]);

  const itemsRef = useRef(auto.fitItems);
  itemsRef.current = auto.fitItems;
  /**
   * zoomToFit, but into the free area between the legend and the panel, with room for the names and island
   * titles (lib/graph-fit.ts; the circles alone when the names cannot fit). An explicit fit: the viewer's
   * moves are forgotten.
   */
  const fitMap = useCallback((ms: number) => {
    const fg = fgRef.current;
    const bbox = fg?.getGraphBbox();
    if (!fg || !bbox) return;
    const { width: w, height: h, insets } = viewRef.current;
    moveTo(fitWithNames(itemsRef.current(), w, h, insets) ?? fitView(bbox, w, h, insets), ms);
    userMoved.current = false;
    fittedOnce.current = true;
  }, [fgRef, viewRef, moveTo]);

  // The settle fit is armed for the first model with pages only; a later model (e.g. archived pages
  // shown) keeps the viewer's view.
  useEffect(() => {
    if (!fittedOnce.current) fitPending.current = true;
  }, [model]);
  // First load (null) or a new scope: fit once the warm-up has placed the pages, then again when the
  // layout settles; both give way if the viewer moves first.
  const lastFitKey = useRef<string | null>(null);
  const { ready, fitKey, nodeCount, insetLeft } = auto;
  useEffect(() => {
    if (!ready || fitKey === lastFitKey.current) return;
    const first = lastFitKey.current === null;
    lastFitKey.current = fitKey;
    fitPending.current = true;
    if (!first) userMoved.current = false;
    const timer = setTimeout(() => {
      if (autoFit(true, userMoved.current, nodeCount()) === 'fit') fitMap(first ? 0 : 400);
    }, EARLY_FIT_MS);
    return () => clearTimeout(timer);
  }, [ready, fitKey, fitMap, nodeCount]);
  // The filter panel moved the free area's left edge: glide by half the change, zoom unchanged, unless
  // the viewer has moved the map since the last fit. Each change retargets a running glide.
  const lastLeft = useRef(insetLeft);
  useEffect(() => {
    const from = lastLeft.current;
    lastLeft.current = insetLeft;
    const fg = fgRef.current;
    const dx = recentrePan(from, insetLeft, userMoved.current);
    if (!fg || !fittedOnce.current || dx === 0) return;
    // A fit still gliding ends shifted instead, at its own zoom.
    if (heading.current) {
      moveTo(panView(heading.current, dx), RECENTRE_MS);
      return;
    }
    const base = panTarget.current;
    cancelAnimationFrame(glide.current);
    const k = fg.zoom();
    const now = fg.centerAt();
    const start = { x: now.x, y: now.y };
    const to = panView({ ...(base ?? start), k }, dx);
    if (reduced.current) {
      panTarget.current = null;
      fg.centerAt(to.x, start.y);
      return;
    }
    panTarget.current = to;
    const began = performance.now();
    const step = (t0: number) => {
      // The viewer took over mid-glide: stop where it is.
      if (userMoved.current) {
        panTarget.current = null;
        return;
      }
      const t = Math.max(0, Math.min(1, (t0 - began) / RECENTRE_MS));
      fg.centerAt(start.x + (to.x - start.x) * easeInOut(t), start.y);
      if (t < 1) glide.current = requestAnimationFrame(step);
      else panTarget.current = null;
    };
    glide.current = requestAnimationFrame(step);
  }, [insetLeft, fgRef, moveTo]);

  // The canvas was resized (the window, or the header wrapping): a fitted map fits the new size; a map the
  // viewer has moved stays as it is.
  const lastSize = useRef(auto.size);
  const { size } = auto;
  useEffect(() => {
    if (size === lastSize.current) return;
    lastSize.current = size;
    if (fittedOnce.current && !userMoved.current) fitMap(RECENTRE_MS);
  }, [size, fitMap]);

  const onEngineStop = useCallback(() => {
    const next = autoFit(fitPending.current, userMoved.current, nodeCount());
    if (next === 'drop') fitPending.current = false;
    if (next !== 'fit') return;
    fitPending.current = false;
    fitMap(500);
  }, [fitMap, nodeCount]);

  useEffect(() => {
    controlsRef.current = {
      focusNode(id) {
        const node = model.byId.get(id);
        const fg = fgRef.current;
        if (!node || !fg) return;
        const { width: w, height: h, insets } = viewRef.current;
        const k = Math.max(fg.zoom(), FOCUS_ZOOM);
        moveTo({ ...centerFor(node.x, node.y, k, w, h, insets), k }, 600);
        // The viewer asked to go to this page: a pending automatic fit must not undo it.
        userMoved.current = true;
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
        moveTo(fitView(bbox, w, h, insets, FIT_NODES_MAX_ZOOM), 600);
        userMoved.current = false;
        fitPending.current = false;
      },
    };
    return () => {
      controlsRef.current = null;
    };
  }, [controlsRef, model, fgRef, viewRef, moveTo]);

  const zoomBy = useCallback((factor: number) => {
    const fg = fgRef.current;
    if (!fg) return;
    stopGlide();
    userMoved.current = true;
    const center = fg.centerAt();
    const from: GraphView = { x: center.x, y: center.y, k: fg.zoom() };
    const { width: w, height: h, insets } = viewRef.current;
    const about = zoomAnchor(from, w, h, insets, aboutRef.current());
    const to = zoomAround(from, about, from.k * factor);
    // Zoom on a log scale with the anchor held still; centerAt and zoom each animated alone would drift.
    const show = (k: number) => {
      const view = zoomAround(from, about, k);
      fg.zoom(view.k);
      fg.centerAt(view.x, view.y);
    };
    if (reduced.current) {
      show(to.k);
      return;
    }
    const start = performance.now();
    heading.current = to;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ZOOM_MS);
      show(from.k * (to.k / from.k) ** easeInOut(t));
      if (t < 1) glide.current = requestAnimationFrame(step);
      else heading.current = null;
    };
    glide.current = requestAnimationFrame(step);
  }, [fgRef, viewRef, aboutRef, stopGlide]);

  return { fitMap, zoomBy, markMoved, onEngineStop, moveTo, viewTarget };
}
