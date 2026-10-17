'use client';

/**
 * The knowledge graph's canvas: react-force-graph-2d with the topic-map
 * forces (graph-forces.ts), page, name and island drawing (graph-draw.ts,
 * graph-islands.ts), hover highlighting, the hover card, click-to-select
 * pages and lines, and the view controls (useCanvasControls.ts). Fitting and
 * centring keep to the part of the canvas the legend and the side panel
 * leave free (`insets`). The data arrives prepared (lib/graph-model.ts,
 * graph-scope.ts, graph-missing.ts); the canvas callbacks only read it.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraphMethods } from 'react-force-graph-2d';
import { LAYOUT, warmupTicks, type ViewInsets } from '../../../lib/graph-layout';
import { focusHighlight, hoverCardText, type GraphFocus, type Highlight } from '../../../lib/graph-focus';
import { isMissingLink, isMissingNode } from '../../../lib/graph-missing';
import type { GraphModel, ModelLink, ModelNode, VisibleGraph } from '../../../lib/graph-model';
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
import { LINK_HOVER_PX, lineWidth, useLinePaint } from './useLinePaint';

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
/** After a change of scope, a first fit once the new layout's warm-up has run (ms), before the final one. */
const EARLY_FIT_MS = 80;
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
}

function cssFont(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value ? `${value}, ${fallback}` : fallback;
}

export default function GraphCanvas({
  model, visible, lookup, width, height, insets, coveredLeft, coveredRight, controlsRight, selected, onSelect,
  pinned = null, marked = null, bridges = NO_BRIDGES, focusId = null, fitKey = '', controlsRef,
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
  const [hovered, setHovered] = useState<GraphFocus | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const fitPending = useRef(true);
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
  const { fitMap, zoomBy } = useCanvasControls(fgRef, viewRef, model, controlsRef, aboutRef);

  useEffect(() => {
    fitPending.current = true;
  }, [model]);
  // A new scope, or a focus the page opened with: fit once the warm-up has placed its pages,
  // and again when the layout settles. The full map on first load waits for the settle only.
  const lastFitKey = useRef('');
  useEffect(() => {
    if (!ready || fitKey === lastFitKey.current) return;
    lastFitKey.current = fitKey;
    fitPending.current = true;
    const timer = setTimeout(() => fitMap(400), EARLY_FIT_MS);
    return () => clearTimeout(timer);
  }, [ready, fitKey, fitMap]);

  // Forces go in before the first data, so the very first layout is the topic map.
  const attach = useCallback((fg: ForceGraphMethods | null) => {
    fgRef.current = fg ?? undefined;
    if (!fg) return;
    applyLayoutForces(fg, (id) => visibleRef.current.linksOf.get(id)?.length ?? 0, () => anchorRef.current);
    setReady(true);
  }, []);

  // The panel lies over the canvas, so the map stays put when it opens; only a
  // selection that would end up under the panel glides left into view.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !selected) return;
    const point = selected.kind === 'node' ? model.byId.get(selected.id) : midpoint(selected.link, model);
    if (!point) return;
    const screen = fg.graph2ScreenCoords(point.x, point.y);
    const limit = width - insets.right - REVEAL_MARGIN;
    if (screen.x <= limit) return;
    const center = fg.centerAt();
    fg.centerAt(center.x + (screen.x - limit) / fg.zoom(), center.y, 400);
  }, [selected, model, width, insets.right]);

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
  const { styles, lines, linkColor, linkMode, linkObject, dash, pointerArea } = useLinePaint(model, visible, highlight, pinned, selected, frame, picked);
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

  const onEngineStop = useCallback(() => {
    if (fitPending.current && visibleRef.current.nodes.length > 0) {
      fitPending.current = false;
      fitMap(500);
    }
  }, [fitMap]);

  const hoverNode = useCallback(
    (node: object | null) => setHovered(node ? { kind: 'node', id: (node as ModelNode).id } : null),
    []
  );
  const hoverLink = useCallback(
    (link: object | null) => setHovered(link && !isMissingLink(link as ModelLink) ? { kind: 'link', link: link as ModelLink } : null),
    []
  );
  // Missing names are report-only: hover shows what they are; a click does nothing.
  const clickNode = useCallback(
    (node: object) => {
      if (!isMissingNode(node as ModelNode)) onSelect({ kind: 'node', id: (node as ModelNode).id });
    },
    [onSelect]
  );
  const clickLink = useCallback(
    (link: object) => {
      if (!isMissingLink(link as ModelLink)) onSelect({ kind: 'link', link: link as ModelLink });
    },
    [onSelect]
  );
  const clickBackground = useCallback(() => onSelect(null), [onSelect]);
  const clearHover = useCallback(() => setHovered(null), []);

  return (
    // force-graph keeps its hover when the pointer leaves the canvas; drop ours so the card and highlight go.
    <div
      style={{ position: 'absolute', left: 0, top: 0, width, height }}
      onMouseMove={(e) => moveCard(cardRef.current, e.clientX, e.clientY)}
      onMouseLeave={clearHover}
    >
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
        warmupTicks={warmupTicks(visible.nodes.length)}
        cooldownTime={COOLDOWN_MS}
        onEngineStop={onEngineStop}
      />
      <HoverCard cardRef={cardRef} card={hoverCardText(hovered, lookup)} />
      <ZoomButtons right={controlsRight} onZoom={zoomBy} onFit={() => fitMap(400)} />
    </div>
  );
}

function midpoint(link: ModelLink, model: GraphModel): { x: number; y: number } | undefined {
  const [a, b] = [model.byId.get(link.a), model.byId.get(link.b)];
  return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : undefined;
}
