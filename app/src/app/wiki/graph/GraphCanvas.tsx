'use client';

/**
 * The knowledge graph's canvas: react-force-graph-2d with the topic-map
 * forces (graph-forces.ts), page, name and island drawing (graph-draw.ts,
 * graph-islands.ts), hover highlighting, the hover card, click-to-select
 * pages and lines, and zoom. Fitting and centring keep to the part of the
 * canvas the legend and the side panel leave free (`insets`). The data
 * arrives prepared (lib/graph-model.ts); the canvas callbacks only read it.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { ForceGraphMethods } from 'react-force-graph-2d';
import { centerFor, fitView, LAYOUT, warmupTicks, type ViewInsets } from '../../../lib/graph-layout';
import { focusHighlight, hoverCardText, type GraphFocus } from '../../../lib/graph-focus';
import type { GraphModel, ModelLink, ModelNode, VisibleGraph } from '../../../lib/graph-model';
import { CANVAS_BG } from '../../../lib/graph-palette';
import { HoverCard, moveCard, ZoomButtons } from './canvas-overlays';
import { applyLayoutForces } from './graph-forces';
import {
  beginFrame, drawLabels, drawNode, newFrameState, newLabelBuffer, prepareLabels, type DrawView,
} from './graph-draw';
import { drawClusterLabels, newClusterBuffer } from './graph-islands';

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
/** Extra pixels around a line that still count as hovering it. */
const LINK_HOVER_PX = 8;
const FOCUS_ZOOM = 2;
/** A selected page this close to the panel's edge (screen px) is moved into view. */
const REVEAL_MARGIN = 120;
const EMPTY = { nodes: [] as object[], links: [] as object[] };
const NO_LABEL = () => '';
/** force-graph's hit area for a page: sqrt(val) * 4 (nodeRelSize), so the drawn radius. */
const NODE_VAL = (node: object) => (node as ModelNode).radius ** 2 / 16;

/** What the page can ask of the canvas. */
export interface GraphControls {
  /** Centre a page in the free part of the canvas and zoom in to it. */
  focusNode(id: string): void;
}

interface Props {
  model: GraphModel;
  visible: VisibleGraph;
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
  controlsRef: MutableRefObject<GraphControls | null>;
}

function cssFont(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value ? `${value}, ${fallback}` : fallback;
}

export default function GraphCanvas({
  model, visible, width, height, insets, coveredLeft, coveredRight, controlsRight, selected, onSelect, controlsRef,
}: Props) {
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const viewRef = useRef({ width, height, insets });
  viewRef.current = { width, height, insets };
  const [ready, setReady] = useState(false);
  const [hovered, setHovered] = useState<GraphFocus | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const fitPending = useRef(true);
  const frame = useRef(newFrameState('Inter, system-ui, sans-serif', 'system-ui, sans-serif'));
  const clusterBuf = useMemo(() => newClusterBuffer(model.categories.length), [model]);
  const labelBuf = useMemo(() => newLabelBuffer(model.nodes.length, model.categories.length), [model]);

  // The app's fonts (next/font names) once mounted; label widths are measured again in them.
  useEffect(() => {
    frame.current = newFrameState(
      cssFont('--font-body', 'system-ui, sans-serif'),
      cssFont('--font-heading', 'system-ui, sans-serif')
    );
    labelBuf.widths.clear();
    labelBuf.islandWidths.fill(NaN);
  }, [labelBuf]);
  useEffect(() => {
    fitPending.current = true;
  }, [model]);

  // Forces go in before the first data, so the very first layout is the topic map.
  const attach = useCallback((fg: ForceGraphMethods | null) => {
    fgRef.current = fg ?? undefined;
    if (!fg) return;
    applyLayoutForces(fg, (id) => visibleRef.current.linksOf.get(id)?.length ?? 0);
    setReady(true);
  }, []);

  /** zoomToFit, but into the free area between the legend and the panel. */
  const fitMap = useCallback((ms: number) => {
    const fg = fgRef.current;
    const bbox = fg?.getGraphBbox();
    if (!fg || !bbox) return;
    const { width: w, height: h, insets: edges } = viewRef.current;
    const view = fitView(bbox, w, h, edges);
    fg.centerAt(view.x, view.y, ms);
    fg.zoom(view.k, ms);
  }, []);

  useEffect(() => {
    controlsRef.current = {
      focusNode(id) {
        const node = model.byId.get(id);
        const fg = fgRef.current;
        if (!node || !fg) return;
        const { width: w, height: h, insets: edges } = viewRef.current;
        const k = Math.max(fg.zoom(), FOCUS_ZOOM);
        const at = centerFor(node.x, node.y, k, w, h, edges);
        fg.centerAt(at.x, at.y, 600);
        fg.zoom(k, 600);
      },
    };
    return () => {
      controlsRef.current = null;
    };
  }, [controlsRef, model]);

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
  const highlight = useMemo(() => focusHighlight(visible, hovered, selected), [visible, hovered, selected]);
  const view: DrawView = useMemo(
    () => ({
      highlight,
      selectedId: selected?.kind === 'node' ? selected.id : null,
      hoveredId: hovered?.kind === 'node' ? hovered.id : null,
      labelRank: visible.labelRank,
    }),
    [highlight, selected, hovered, visible]
  );

  // New callbacks whenever the view changes: that is what makes force-graph redraw.
  const paintNode = useCallback(
    (node: object, ctx: CanvasRenderingContext2D) => drawNode(ctx, node as ModelNode, frame.current, view),
    [view]
  );
  const linkColor = useCallback(
    (link: object) => {
      const l = link as ModelLink;
      if (highlight === null) return l.color;
      return highlight.links.has(l) ? l.bright : l.faded;
    },
    [highlight]
  );
  const linkWidth = useCallback(
    (link: object) => {
      const l = link as ModelLink;
      return highlight !== null && highlight.links.has(l) ? l.width + 0.75 : l.width;
    },
    [highlight]
  );
  const framePre = useCallback(
    (ctx: CanvasRenderingContext2D, scale: number) => beginFrame(frame.current, ctx, scale, coveredLeft, coveredRight),
    [coveredLeft, coveredRight]
  );
  // The page whose name goes first: the hovered page, else the selected one (not when a line is hovered).
  const focusNode = useMemo(() => {
    const focus = hovered ?? selected;
    return focus?.kind === 'node' && visible.neighbours.has(focus.id) ? (model.byId.get(focus.id) ?? null) : null;
  }, [hovered, selected, visible, model]);
  const framePost = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      prepareLabels(labelBuf, visible.nodes, frame.current, highlight);
      drawClusterLabels(ctx, visible.nodes, model.categories, clusterBuf, frame.current, highlight !== null, labelBuf);
      drawLabels(ctx, visible.labelOrder, focusNode, frame.current, view, labelBuf);
    },
    [visible, focusNode, view, labelBuf, model, clusterBuf, highlight]
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
    (link: object | null) => setHovered(link ? { kind: 'link', link: link as ModelLink } : null),
    []
  );
  const clickNode = useCallback((node: object) => onSelect({ kind: 'node', id: (node as ModelNode).id }), [onSelect]);
  const clickLink = useCallback((link: object) => onSelect({ kind: 'link', link: link as ModelLink }), [onSelect]);
  const clickBackground = useCallback(() => onSelect(null), [onSelect]);
  const clearHover = useCallback(() => setHovered(null), []);
  const zoomBy = useCallback((factor: number) => {
    const fg = fgRef.current;
    if (fg) fg.zoom(fg.zoom() * factor, 300);
  }, []);

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
        linkWidth={linkWidth}
        linkHoverPrecision={LINK_HOVER_PX}
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
      <HoverCard cardRef={cardRef} card={hoverCardText(hovered, model.byId)} />
      <ZoomButtons right={controlsRight} onZoom={zoomBy} onFit={() => fitMap(400)} />
    </div>
  );
}

function midpoint(link: ModelLink, model: GraphModel): { x: number; y: number } | undefined {
  const [a, b] = [model.byId.get(link.a), model.byId.get(link.b)];
  return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : undefined;
}
