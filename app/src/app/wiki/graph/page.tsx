'use client';

/**
 * /wiki/graph — the knowledge graph as a topic map. CLIENT component.
 *
 * Loads /api/wiki/graph (useGraphData.ts: pages, one line per page pair with
 * its typed relations, plain links, names with no page yet) and derives the
 * views from it (useGraphView.ts). Pages are coloured and grouped into
 * islands by category; lines are coloured by relation. Click a page for its
 * connections, a line for the evidence behind it. ?focus=<page_id>&depth=1|2
 * shows one page with its neighbours, each focus a history entry
 * (scope-url.ts); "Connect two pages" finds the chain
 * between two pages; the legend can add the missing pages; bridge pages carry
 * a badge. The side panel lies over the canvas, so opening it never moves
 * the map.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { closesPanelOnEscape, limitsLinePointer, type GraphFocus } from '../../../lib/graph-focus';
import { pagesFitKey } from '../../../lib/graph-fit';
import { canvasInsets, LEGEND_LEFT } from '../../../lib/graph-panels';
import { placeMissing } from '../../../lib/graph-missing';
import { DEFAULT_FILTERS, type GraphFilters } from '../../../lib/graph-model';
import { CANVAS_BG } from '../../../lib/graph-palette';
import { fillPath, pathKey, type PathQuery } from '../../../lib/graph-path';
import { canvasLabel, FULL_MAP, missingFocusAction, revealFilters } from '../../../lib/graph-scope';
import type { PageConnections } from '../../../lib/relations';
import { CanvasHint } from './canvas-overlays';
import EdgePanel from './EdgePanel';
import GraphCanvas, { type GraphControls } from './GraphCanvas';
import GraphHeader from './GraphHeader';
import GraphLegend from './GraphLegend';
import NodePanel from './NodePanel';
import { PanelWidthContext } from './panel-parts';
import { usePanelSizes } from './usePanelSizes';
import PathPanel from './PathPanel';
import { useScopeAddress } from './scope-url';
import { useGraphData } from './useGraphData';
import { useGraphView } from './useGraphView';

const MESSAGE = { color: 'var(--fg-muted)', padding: '3rem', textAlign: 'center' } as const;

export default function WikiGraphPage() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const [filters, setFilters] = useState<GraphFilters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<GraphFocus | null>(null);
  const { data, error, archivedOnly, loaded } = useGraphData(includeArchived, setSelected);
  const { scope, changeScope, notice, setNotice } = useScopeAddress();
  /** Non-null while "Connect two pages" is open. */
  const [pathQuery, setPathQuery] = useState<PathQuery | null>(null);
  const [showMissing, setShowMissing] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<GraphControls | null>(null);
  const pathOpen = useRef(false);
  pathOpen.current = pathQuery !== null;

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    // The canvas is exactly its box: taller, a short screen would clip its zoom buttons and fitted map.
    const measure = () => setSize({ width: box.offsetWidth, height: box.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!closesPanelOnEscape(e)) return;
      setSelected(null);
      setPathQuery(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const view = useGraphView(data, filters, scope, showMissing, pathQuery);
  const { model, focusId, scoped, layer, visible, lookup, bridges, bridgeIds, path, pinned, marked } = view;
  // A fresh cache per load, so panels never show connections from before a reload.
  const connectionsCache = useMemo(() => new Map<string, PageConnections>(), [model]);

  // Entering a focus: a page the filters hide is let through, and an archived one turns archived pages on
  // (its article's "See in graph"); a page not on the map says so. A reload in flight is waited for.
  const lookedFor = useRef<string | null>(null);
  const archivedForLook = useRef(false);
  useEffect(() => {
    if (scope.focus === null) lookedFor.current = null;
    if (scope.focus === null || !loaded) return;
    const firstLook = lookedFor.current !== scope.focus;
    lookedFor.current = scope.focus;
    const node = model.byId.get(scope.focus);
    if (node) {
      archivedForLook.current = false;
      setPathQuery(null);
      setFilters((f) => revealFilters(f, node));
      return;
    }
    const action = missingFocusAction(firstLook, includeArchived, archivedForLook.current);
    archivedForLook.current = action === 'show-archived';
    if (action !== 'leave') setIncludeArchived(action === 'show-archived');
    if (action === 'show-archived') return;
    changeScope(FULL_MAP, 'replace');
    setNotice('That page is not on the map.');
  }, [scope.focus, model, loaded, includeArchived, changeScope, setNotice]);

  // A found path fits into view once: a filter change recomputes `path` but not its pages.
  const fitPath = pathKey(path);
  useEffect(() => {
    if (fitPath) controlsRef.current?.fitNodes(fitPath.split('\u0000'));
  }, [fitPath]);

  const selectedNode =
    selected?.kind === 'node' && visible.neighbours.has(selected.id) ? (model.byId.get(selected.id) ?? null) : null;
  const selectedLink =
    selected?.kind === 'link' && visible.linksOf.get(selected.link.a)?.includes(selected.link) ? selected.link : null;
  const panelOpen = pathQuery !== null || selectedNode !== null || selectedLink !== null;
  // The selection whose panel has taken keyboard focus: when a filter hides the selected page or line and
  // shows it again, its panel comes back without pulling focus away from the legend.
  const [focusedFor, setFocusedFor] = useState<GraphFocus | null>(null);
  const panelFor = selectedNode !== null || selectedLink !== null ? selected : null;
  useEffect(() => {
    if (panelFor) setFocusedFor(panelFor);
  }, [panelFor]);
  // The legend and the details panel can be resized; the map keeps clear of their current sizes.
  const panels = usePanelSizes(size.width, size.height);
  const { legendOpen, setLegendOpen } = panels;
  const { legend: legendSize, panel: panelWidth } = panels.sizes;
  const insets = useMemo(
    () => canvasInsets(legendOpen, legendSize.width, panelOpen, panelWidth),
    [legendOpen, legendSize.width, panelOpen, panelWidth]
  );

  const close = useCallback(() => {
    setSelected(null);
    setPathQuery(null);
  }, []);
  const pick = useCallback((id: string) => {
    if (!pathOpen.current) setSelected({ kind: 'node', id });
    controlsRef.current?.focusNode(id);
  }, []);
  // While connecting two pages, a click on a page fills the pickers instead of opening its panel.
  const select = useCallback((focus: GraphFocus | null) => {
    if (!pathOpen.current) setSelected(focus);
    else if (focus?.kind === 'node') setPathQuery((q) => (q ? fillPath(q, focus.id) : q));
  }, []);
  // Opening starts from the selected page and leaves any focus: a path runs over the whole map.
  const togglePath = () => {
    if (pathQuery !== null) {
      setPathQuery(null);
      return;
    }
    if (scope.focus !== null) changeScope(FULL_MAP);
    setPathQuery({ from: selectedNode?.id ?? null, to: null });
    setSelected(null);
  };
  // The panel's "Focus" button goes away once the map is focused on its page: keyboard focus moves to the
  // header's focus controls (GraphHeader.tsx) instead of falling to the page body.
  const [focusRequest, setFocusRequest] = useState(0);
  const enterFocus = (id: string) => {
    changeScope({ focus: id, depth: scope.depth });
    setFocusRequest((n) => n + 1);
  };
  const toggleMissing = (next: boolean) => {
    if (next) placeMissing(layer, model.byId);
    setShowMissing(next);
  };
  const isShown = useCallback((id: string) => visible.neighbours.has(id), [visible]);

  const hasPages = data !== null && data.nodes.length > 0;
  const allLines = filters.showPlain && filters.showRelated;

  return (
    <>
      {/*
        The force-graph library maps mouse events using getBoundingClientRect(), which
        returns visual (post-zoom) dimensions. With html { zoom: 0.9 } the canvas CSS
        coordinate space (0..width) and the mouse position range (0..width*0.9) diverge
        by 10%, causing hover/click to miss. Resetting html zoom to 1 for this page
        only (React removes the <style> on unmount when navigating away).
      */}
      <style>{`html { zoom: 1; }`}</style>
      <main style={{ height: 'calc(100dvh - 65px)', display: 'flex', flexDirection: 'column', background: CANVAS_BG, overflow: 'hidden' }}>
        <GraphHeader
          pages={scoped.nodes.length}
          lines={scoped.links.length}
          focusTitle={scope.focus !== null ? (model.byId.get(scope.focus)?.label ?? null) : null}
          depth={scope.depth}
          onDepth={(depth) => changeScope({ ...scope, depth })}
          onFullMap={() => changeScope(FULL_MAP)}
          pathOpen={pathQuery !== null}
          onPath={togglePath}
          notice={notice ?? (scope.focus && !focusId && model.byId.has(scope.focus) ? 'The focused page is hidden by the legend’s filters.' : null)}
          findPages={scoped.nodes}
          onFind={pick}
          focusRequest={focusRequest}
        />

        {/* tabIndex -1: focus comes back here when a panel closes and its opener is gone. */}
        <div ref={boxRef} tabIndex={-1} style={{ flex: 1, position: 'relative', background: CANVAS_BG, overflow: 'hidden', outline: 'none' }}>
          {error && <div style={{ ...MESSAGE, color: 'var(--danger)' }}>{error}</div>}
          {!error && data === null && <div style={MESSAGE}>Loading graph…</div>}
          {!error && data !== null && !hasPages && !archivedOnly && !includeArchived && (
            <div style={MESSAGE}>
              No pages compiled yet. <Link href="/">Add a source</Link> to build the graph.
            </div>
          )}
          {!error && data !== null && (hasPages || archivedOnly || includeArchived) && size.width > 0 && (
            <>
              {/* Before the canvas in the page, so Tab reaches the filters (top left) before the zoom buttons
                  (bottom right); the legend's z-index keeps it over the canvas. */}
              <GraphLegend
                model={model}
                visible={scoped}
                filters={filters}
                onFilters={setFilters}
                includeArchived={includeArchived}
                onIncludeArchived={setIncludeArchived}
                missingCount={layer.nodes.length}
                showMissing={showMissing}
                onShowMissing={toggleMissing}
                pointerLimited={limitsLinePointer(visible.links.length)}
                open={legendOpen}
                onOpen={setLegendOpen}
                size={legendSize}
                onSize={panels.setLegend}
                onSizeDone={panels.save}
              />
              {hasPages && (
                <GraphCanvas
                  model={model}
                  visible={visible}
                  lookup={lookup}
                  width={size.width}
                  height={size.height}
                  insets={insets}
                  coveredLeft={legendOpen ? LEGEND_LEFT + legendSize.width : 0}
                  coveredRight={panelOpen ? panelWidth : 0}
                  controlsRight={panelOpen ? panelWidth + 16 : 16}
                  selected={selected}
                  onSelect={select}
                  pinned={pinned}
                  marked={marked}
                  bridges={bridgeIds}
                  focusId={focusId}
                  fitKey={`${focusId ? `${focusId}\u0000${scope.depth}` : ''}\u0003${pagesFitKey(filters, showMissing)}`}
                  controlsRef={controlsRef}
                  label={canvasLabel(scoped.nodes.length, scoped.links.length, focusId ? (model.byId.get(focusId)?.label ?? null) : null)}
                />
              )}
              {!hasPages && (
                <div style={MESSAGE}>
                  {includeArchived ? 'No pages to show.' : 'Every page is archived. Turn on “Show archived” in the legend to see them.'}
                </div>
              )}
              {hasPages && scoped.nodes.length === 0 && (
                <div style={{ ...MESSAGE, position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                  Nothing to show with these filters.
                </div>
              )}
              <CanvasHint model={model} full={view.full} scoped={scoped} focusId={focusId} filters={filters} onFilters={setFilters} />
              <PanelWidthContext.Provider value={panels.panelContext}>
              {pathQuery !== null && (
                <PathPanel pages={view.pickable} model={model} query={pathQuery} onQuery={setPathQuery} path={path}
                  onShowAllLines={allLines ? undefined : () => setFilters({ ...filters, showPlain: true, showRelated: true })}
                  cache={connectionsCache} onClose={close} onPick={pick} returnFocusTo={boxRef} />
              )}
              {pathQuery === null && selectedNode && (
                <NodePanel key={selectedNode.id} node={selectedNode} isShown={isShown} cache={connectionsCache}
                  onClose={close} onPick={pick} returnFocusTo={boxRef} takeFocus={focusedFor !== selected} bridge={bridges.get(selectedNode.id) ?? null}
                  onFocus={focusId === selectedNode.id ? undefined : enterFocus} />
              )}
              {pathQuery === null && selectedLink && (
                <EdgePanel key={`${selectedLink.a}\u0000${selectedLink.b}`} link={selectedLink} model={model}
                  cache={connectionsCache} onClose={close} onPick={pick} returnFocusTo={boxRef} takeFocus={focusedFor !== selected} />
              )}
              </PanelWidthContext.Provider>
            </>
          )}
        </div>
      </main>
    </>
  );
}

