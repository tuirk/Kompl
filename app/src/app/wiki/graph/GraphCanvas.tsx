'use client';

/**
 * The knowledge graph's canvas: react-force-graph-2d with the topic-map
 * forces (graph-forces.ts), page, name and island drawing (graph-draw.ts,
 * graph-islands.ts), hover highlighting (useCanvasHover.ts), the hover card,
 * click-to-select pages and lines, and the view controls
 * (useCanvasControls.ts). Fitting and centring keep to the part of the
 * canvas the legend and the side panel leave free (`insets`). The data
 * arrives prepared (lib/graph-model.ts, graph-scope.ts, graph-missing.ts);
 * the canvas callbacks only read it. For screen readers the canvas is an
 * image named by what it shows; keyboards reach pages by "Find a page".
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraphMethods } from 'react-force-graph-2d';
import { LAYOUT, warmupTicks, type ViewInsets } from '../../../lib/graph-layout';
import { focusHighlight, hoverCardText, type GraphFocus, type Highlight } from '../../../lib/graph-focus';
import { isMissingLink, isMissingNode } from '../../../lib/graph-missing';
import type { GraphModel, ModelLink, ModelNode, VisibleGraph } from '../../../lib/graph-model';
import { reducedMotionTicks } from '../../../lib/graph-motion';
import { CANVAS_BG } from '../../../lib/graph-palette';
import { HoverCard, moveCard, ZoomButtons } from './canvas-overlays';
import { applyLayoutForces } from './graph-forces';
import {
  beginFrame, drawLabels, drawNode, newFrameState, newLabelBuffer, prepareLabels, type DrawView,
} from './graph-draw';
import { drawClusterLabels, newClusterBuffer } from './graph-islands';
import { drawLineLabels } from './graph-line-labels';
import { beginLineFrame, newLineFrame } from './graph-lines';
import { useCanvasControls, type GraphControls } from './useCanvasControls';
import { useCanvasHover } from './useCanvasHover';
import { LINK_HOVER_PX, useLinePaint } from './useLinePaint';
import { useReducedMotion } from './useReducedMotion';

export type { GraphControls } from './useCanvasControls';

// react-force-graph-2d is the 2D-only variant of the force-graph family.
// Using it instead of the barrel package (react-force-graph) avoids pulling in
// 3d-force-graph → aframe-forcegraph-component which calls AFRAME.registerComponent()
// as a module-level side effect even when only ForceGraph2D is used.
// Must be dynamic (no SSR) — uses canvas APIs.
const ForceGraph2D = dynamic(() => import('react-force-graph-2d').then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div style={{ color: 'var(--fg-muted)', padding: '2rem', textAlign: 'center' }}>Loading graph…</div>
  ),
});

/** The simulation stops by alpha (LAYOUT.alphaMin); this only caps a runaway. */
const COOLDOWN_MS = 20000;
/** A selected page this close to the panel's edge (screen px) is moved into view. */
const REVEAL_MARGIN = 120;
const EMPTY = { nodes: [] as object[], links: [] as object[] };
const NO_LABEL = () => '';
/** force-graph's hit area for a page: sqrt(val) * 4 (nodeRelSize), so the drawn radius. */
const NODE_VAL = (node: object) => (node as ModelNode).radius ** 2 / 16;
const NO_BRIDGES: ReadonlySet<string> = new Set();

interface Props {
  model: GraphModel;
  visible: VisibleGraph;
  /** Every node the canvas may draw: pages and missing names. */
  lookup: ReadonlyMap<string, ModelNode>;
  width: number;
  height: number;
  /** Edges covered by the legend and the side panel. */
  insets: ViewInsets;
  /** Pixels the legend covers at the left and an open side panel at the right (names stay clear of them). */
  coveredLeft: number;
  coveredRight: number;
  /** Distance of the zoom buttons from the right edge (clear of an open panel). */
  controlsRight: number;
  selected: GraphFocus | null;
  onSelect(focus: GraphFocus | null): void;
  /** Lit when nothing is hovered, ahead of the selection: a found path. */
  pinned?: Highlight | null;
  /** Pages ringed like the selection: a path's two ends, or the focused page. */
  marked?: ReadonlySet<string> | null;
  /** Pages whose names carry the bridge badge. */
  bridges?: ReadonlySet<string>;
  /** The focused page in focus mode: pages gather at its island, and zoom falls back to it. */
  focusId?: string | null;
  /** Changes when the view should fit again (focus entered, left, its depth changed). */
  fitKey?: string;
  controlsRef: MutableRefObject<GraphControls | null>;
  /** The map's accessible name (lib/graph-scope.ts canvasLabel). */
  label: string;
}

function cssFont(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value ? `${value}, ${fallback}` : fallback;
}

export default function GraphCanvas({
  model, visible, lookup, width, height, insets, coveredLeft, coveredRight, controlsRight, selected, onSelect,
  pinned = null, marked = null, bridges = NO_BRIDGES, focusId = null, fitKey = '', controlsRef, label,
}: Props) {
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const viewRef = useRef({ width, height, insets });
  viewRef.current = { width, height, insets };
  const focusNode = focusId ? (model.byId.get(focusId) ?? null) : null;
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  anchorRef.current = focusNode ? { x: focusNode.anchorX, y: focusNode.anchorY } : null;
  const [ready, setReady] = useState(false);
  const { hovered, hoverNode, hoverLink, track } = useCanvasHover();
  const cardRef = useRef<HTMLDivElement>(null);
  const frame = useRef(newFrameState('Inter, system-ui, sans-serif', 'system-ui, sans-serif'));
  const clusterBuf = useMemo(() => newClusterBuffer(model.categories.length), [model]);
  const labelBuf = useMemo(() => newLabelBuffer(model.nodes.length + model.missing.length, model.categories.length), [model]);

  // The zoom buttons zoom about the selected page or line, else the focused page.
  const aboutRef = useRef<() => { x: number; y: number } | null>(() => null);
  aboutRef.current = () => {
    if (selected?.kind === 'node') return model.byId.get(selected.id) ?? null;
    if (selected?.kind === 'link') return midpoint(selected.link, model) ?? null;
    return focusNode;
  };
  // Automatic fits (first load, scope changes), the guard that keeps a viewer's zoom live there, and the
  // sideways glide that keeps a fitted map centred when the filter panel changes.
  const nodeCount = useCallback(() => visibleRef.current.nodes.length, []);
  // Reduced motion: view moves jump, and the layout settles before the first paint, then stays still.
  const reducedMotion = useReducedMotion();
  const { fitMap, zoomBy, markMoved, onEngineStop, moveTo, viewTarget } = useCanvasControls(
    fgRef, viewRef, model, controlsRef, aboutRef, { ready, fitKey, nodeCount, insetLeft: insets.left, reducedMotion }
  );

  // Forces go in before the first data, so the very first layout is the topic map.
  const attach = useCallback((fg: ForceGraphMethods | null) => {
    fgRef.current = fg ?? undefined;
    if (!fg) return;
    applyLayoutForces(fg, (id) => visibleRef.current.linksOf.get(id)?.length ?? 0, () => anchorRef.current);
    setReady(true);
  }, []);

  // The panel lies over the canvas, so the map stays put when it opens; only a selection that would end up
  // under the panel (where the view is heading, e.g. a move to a picked page) glides left into view
  // (resizing it never moves the map).
  useEffect(() => {
    const view = viewTarget();
    if (!view || !selected) return;
    const point = selected.kind === 'node' ? model.byId.get(selected.id) : midpoint(selected.link, model);
    if (!point) return;
    const screenX = viewRef.current.width / 2 + (point.x - view.x) * view.k;
    const limit = viewRef.current.width - viewRef.current.insets.right - REVEAL_MARGIN;
    if (screenX <= limit) return;
    moveTo({ ...view, x: view.x + (screenX - limit) / view.k }, 400);
  }, [selected, model, viewTarget, moveTo]);

  const graphData = useMemo(
    () => (ready ? ({ nodes: visible.nodes, links: visible.links } as unknown as typeof EMPTY) : EMPTY),
    [ready, visible]
  );
  const highlight = useMemo(
    () => (hovered ? focusHighlight(visible, hovered, null) : null) ?? pinned ?? focusHighlight(visible, null, selected),
    [visible, hovered, selected, pinned]
  );
  const view: DrawView = useMemo(
    () => ({
      highlight,
      selectedId: selected?.kind === 'node' ? selected.id : null,
      hoveredId: hovered?.kind === 'node' ? hovered.id : null,
      labelRank: visible.labelRank,
      marked,
      bridges,
    }),
    [highlight, selected, hovered, visible, marked, bridges]
  );

  // New callbacks whenever the view changes: that is what makes force-graph redraw.
  const paintNode = useCallback(
    (node: object, ctx: CanvasRenderingContext2D) => drawNode(ctx, node as ModelNode, frame.current, view),
    [view]
  );
  // Pages wearing a selection or hover ring; arrowheads stop outside it.
  const picked = useMemo(() => {
    const set = new Set<string>(marked ?? []);
    if (selected?.kind === 'node') set.add(selected.id);
    if (hovered?.kind === 'node') set.add(hovered.id);
    return set;
  }, [marked, selected, hovered]);
  const { styles, lines, linkColor, width: lineWidth, linkMode, linkObject, dash, pointerArea } = useLinePaint(model, visible, highlight, pinned, selected, frame, picked);
  // The app's fonts (next/font names) once mounted; label widths are measured again in them.
  useEffect(() => {
    const body = cssFont('--font-body', 'system-ui, sans-serif');
    frame.current = newFrameState(body, cssFont('--font-heading', 'system-ui, sans-serif'));
    lines.current = newLineFrame(body);
    labelBuf.widths.clear();
    labelBuf.islandWidths.fill(NaN);
  }, [labelBuf, lines]);
  const framePre = useCallback(
    (ctx: CanvasRenderingContext2D, scale: number) => {
      beginFrame(frame.current, ctx, scale, coveredLeft, coveredRight);
      beginLineFrame(lines.current, scale);
    },
    [coveredLeft, coveredRight, lines]
  );
  // The page whose name goes first: the hovered page, else the selected one (not when a line is hovered).
  const nameFirst = useMemo(() => {
    const focus = hovered ?? selected;
    return focus?.kind === 'node' && visible.neighbours.has(focus.id) ? (lookup.get(focus.id) ?? null) : null;
  }, [hovered, selected, visible, lookup]);
  const framePost = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      prepareLabels(labelBuf, visible.nodes, frame.current, highlight);
      drawClusterLabels(ctx, visible.nodes, model.categories, clusterBuf, frame.current, highlight !== null, labelBuf);
      drawLabels(ctx, visible.labelOrder, nameFirst, frame.current, view, labelBuf);
      drawLineLabels(ctx, visible.links, styles, highlight?.links ?? null, lines.current, frame.current, labelBuf.space);
    },
    [visible, nameFirst, view, labelBuf, model, clusterBuf, highlight, styles, lines]
  );

  // Missing names are report-only: hover shows what they are; a click does nothing. Picking a page or line is
  // the viewer taking over the view: a pending automatic fit must not re-fit the map as its panel opens.
  const clickNode = useCallback(
    (node: object) => {
      if (isMissingNode(node as ModelNode)) return;
      markMoved();
      onSelect({ kind: 'node', id: (node as ModelNode).id });
    },
    [onSelect, markMoved]
  );
  const clickLink = useCallback(
    (link: object) => {
      if (isMissingLink(link as ModelLink)) return;
      markMoved();
      onSelect({ kind: 'link', link: link as ModelLink });
    },
    [onSelect, markMoved]
  );
  const clickBackground = useCallback(() => onSelect(null), [onSelect]);

  return (
    // Hover counts only over the canvas itself, not the zoom buttons or what lies over the canvas (useCanvasHover.ts).
    <div
      style={{ position: 'absolute', left: 0, top: 0, width, height }}
      onPointerMove={(e) => {
        track(e.target instanceof HTMLCanvasElement);
        moveCard(cardRef.current, e.clientX, e.clientY);
      }}
      onPointerDown={(e) => track(e.target instanceof HTMLCanvasElement)}
      onPointerLeave={() => track(false)}
      // Capture phase: d3-zoom stops wheel and pan events at the canvas, before they could bubble here.
      onWheelCapture={markMoved}
      onPointerMoveCapture={(e) => {
        if (e.buttons) markMoved();
      }}
    >
      {/* The canvas alone is the image: the zoom buttons stay outside it, reachable. */}
      <div role="img" aria-label={label}>
        <ForceGraph2D
          ref={attach as unknown as MutableRefObject<ForceGraphMethods | undefined>}
          graphData={graphData}
          width={width}
          height={height}
          backgroundColor={CANVAS_BG}
          nodeId="id"
          nodeLabel={NO_LABEL}
          linkLabel={NO_LABEL}
          nodeVal={NODE_VAL}
          nodeCanvasObject={paintNode}
          linkColor={linkColor}
          linkWidth={lineWidth}
          linkLineDash={dash}
          linkCanvasObjectMode={linkMode}
          linkCanvasObject={linkObject}
          linkHoverPrecision={LINK_HOVER_PX}
          linkPointerAreaPaint={pointerArea}
          onRenderFramePre={framePre}
          onRenderFramePost={framePost}
          onNodeHover={hoverNode}
          onLinkHover={hoverLink}
          onNodeClick={clickNode}
          onLinkClick={clickLink}
          onBackgroundClick={clickBackground}
          d3AlphaDecay={LAYOUT.alphaDecay}
          d3VelocityDecay={LAYOUT.velocityDecay}
          d3AlphaMin={LAYOUT.alphaMin}
          warmupTicks={reducedMotion ? reducedMotionTicks(visible.nodes.length) : warmupTicks(visible.nodes.length)}
          cooldownTicks={reducedMotion ? 0 : Infinity}
          cooldownTime={COOLDOWN_MS}
          onEngineStop={onEngineStop}
        />
      </div>
      <HoverCard cardRef={cardRef} card={hoverCardText(hovered, lookup)} />
      <ZoomButtons right={controlsRight} onZoom={zoomBy} onFit={() => fitMap(400)} />
    </div>
  );
}

function midpoint(link: ModelLink, model: GraphModel): { x: number; y: number } | undefined {
  const [a, b] = [model.byId.get(link.a), model.byId.get(link.b)];
  return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : undefined;
}
