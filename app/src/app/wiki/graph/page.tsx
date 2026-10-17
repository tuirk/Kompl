'use client';

/**
 * /wiki/graph — the knowledge graph as a topic map. CLIENT component.
 *
 * Loads /api/wiki/graph (pages, one line per page pair with its typed
 * relations, plain links, names with no page yet) and derives the views from
 * it (useGraphView.ts). Pages are coloured and grouped into islands by
 * category; lines are coloured by relation. Click a page for its
 * connections, a line for the evidence behind it. ?focus=<page_id>&depth=1|2
 * shows one page with its neighbours; "Connect two pages" finds the chain
 * between two pages; the legend can add the missing pages; bridge pages carry
 * a badge. The side panel lies over the canvas, so opening it never moves
 * the map.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { closesPanelOnEscape, limitsLinePointer, type GraphFocus } from '../../../lib/graph-focus';
import type { ViewInsets } from '../../../lib/graph-layout';
import { placeMissing } from '../../../lib/graph-missing';
import { DEFAULT_FILTERS, type GraphFilters } from '../../../lib/graph-model';
import { CANVAS_BG } from '../../../lib/graph-palette';
import { fillPath, type PathQuery } from '../../../lib/graph-path';
import { FULL_MAP, revealFilters, sameScope, type GraphScope } from '../../../lib/graph-scope';
import type { PageConnections } from '../../../lib/relations';
import type { WikiGraph } from '../../../lib/wiki-graph';
import { CanvasHint } from './canvas-overlays';
import EdgePanel from './EdgePanel';
import GraphCanvas, { type GraphControls } from './GraphCanvas';
import GraphHeader from './GraphHeader';
import GraphLegend, { LEGEND_LEFT, LEGEND_WIDTH } from './GraphLegend';
import NodePanel from './NodePanel';
import { PANEL_WIDTH } from './panel-parts';
import PathPanel from './PathPanel';
import { readScope, writeScope } from './scope-url';
import { useGraphView } from './useGraphView';

const MESSAGE = { color: 'var(--fg-muted)', padding: '3rem', textAlign: 'center' } as const;
/** Canvas edges kept clear when fitting: the legend (open or folded), an open panel, the zoom buttons. */
const LEGEND_COVER = LEGEND_LEFT + LEGEND_WIDTH;
const LEGEND_INSET = LEGEND_COVER + 16;
const FOLDED_LEGEND_TOP = 64;

async function loadGraph(includeArchived: boolean, signal: AbortSignal): Promise<WikiGraph> {
  const r = await fetch(includeArchived ? '/api/wiki/graph?include_archived=true' : '/api/wiki/graph', { signal });
  if (!r.ok) throw new Error(`graph fetch failed: ${r.status}`);
  return (await r.json()) as WikiGraph;
}

export default function WikiGraphPage() {
  const [data, setData] = useState<WikiGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  /** True when every page is archived: the legend stays up so "Show archived" can be turned on. */
  const [archivedOnly, setArchivedOnly] = useState(false);
  const [filters, setFilters] = useState<GraphFilters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<GraphFocus | null>(null);
  const [scope, setScope] = useState<GraphScope>(FULL_MAP);
  /** Non-null while "Connect two pages" is open. */
  const [pathQuery, setPathQuery] = useState<PathQuery | null>(null);
  const [showMissing, setShowMissing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(true);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<GraphControls | null>(null);
  const pathOpen = useRef(false);
  pathOpen.current = pathQuery !== null;

  useEffect(() => {
    const abort = new AbortController();
    (async () => {
      const graph = await loadGraph(includeArchived, abort.signal);
      // An empty map may only mean every page is archived; ask once more to tell.
      const hidden = !includeArchived && graph.nodes.length === 0
        ? (await loadGraph(true, abort.signal)).nodes.length > 0
        : false;
      setData(graph);
      setArchivedOnly(hidden);
      setError(null);
      setSelected(null);
    })().catch((e: unknown) => {
      if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'failed to load graph');
    });
    return () => abort.abort();
  }, [includeArchived]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => setSize({ width: box.offsetWidth, height: Math.max(400, box.offsetHeight) });
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

  const changeScope = useCallback((next: GraphScope) => {
    setScope((prev) => (sameScope(prev, next) ? prev : next));
    setNotice(null);
    writeScope(next);
  }, []);
  // The address's ?focus= once, when the page opens.
  // ...and again on Back / Forward between graph addresses, so the view follows the address.
  useEffect(() => {
    setScope(readScope());
    const onPop = () => {
      setScope(readScope());
      setNotice(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Entering a focus: a page the filters hide is let through; a page not on the map says so.
  useEffect(() => {
    if (scope.focus === null || data === null) return;
    const node = model.byId.get(scope.focus);
    if (!node) {
      changeScope(FULL_MAP);
      setNotice('That page is not on the map.');
      return;
    }
    setPathQuery(null);
    setFilters((f) => revealFilters(f, node));
  }, [scope.focus, model, data, changeScope]);

  // A found path fits into view.
  useEffect(() => {
    if (path) controlsRef.current?.fitNodes(path.nodes);
  }, [path]);

  const selectedNode =
    selected?.kind === 'node' && visible.neighbours.has(selected.id) ? (model.byId.get(selected.id) ?? null) : null;
  const selectedLink =
    selected?.kind === 'link' && visible.linksOf.get(selected.link.a)?.includes(selected.link) ? selected.link : null;
  const panelOpen = pathQuery !== null || selectedNode !== null || selectedLink !== null;
  const insets: ViewInsets = useMemo(
    () => ({
      left: legendOpen ? LEGEND_INSET : 24,
      top: legendOpen ? 44 : FOLDED_LEGEND_TOP,
      right: panelOpen ? PANEL_WIDTH + 24 : 64,
      bottom: 40,
    }),
    [legendOpen, panelOpen]
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
              {hasPages && (
                <GraphCanvas
                  model={model}
                  visible={visible}
                  lookup={lookup}
                  width={size.width}
                  height={size.height}
                  insets={insets}
                  coveredLeft={legendOpen ? LEGEND_COVER : 0}
                  coveredRight={panelOpen ? PANEL_WIDTH : 0}
                  controlsRight={panelOpen ? PANEL_WIDTH + 16 : 16}
                  selected={selected}
                  onSelect={select}
                  pinned={pinned}
                  marked={marked}
                  bridges={bridgeIds}
                  focusId={focusId}
                  fitKey={focusId ? `${focusId}\u0000${scope.depth}` : ''}
                  controlsRef={controlsRef}
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
              />
              {pathQuery !== null && (
                <PathPanel pages={view.pickable} model={model} query={pathQuery} onQuery={setPathQuery} path={path}
                  onShowAllLines={allLines ? undefined : () => setFilters({ ...filters, showPlain: true, showRelated: true })}
                  cache={connectionsCache} onClose={close} onPick={pick} returnFocusTo={boxRef} />
              )}
              {pathQuery === null && selectedNode && (
                <NodePanel key={selectedNode.id} node={selectedNode} isShown={isShown} cache={connectionsCache}
                  onClose={close} onPick={pick} returnFocusTo={boxRef} bridge={bridges.get(selectedNode.id) ?? null}
                  onFocus={focusId === selectedNode.id ? undefined : (id) => changeScope({ focus: id, depth: scope.depth })} />
              )}
              {pathQuery === null && selectedLink && (
                <EdgePanel key={`${selectedLink.a}\u0000${selectedLink.b}`} link={selectedLink} model={model}
                  cache={connectionsCache} onClose={close} onPick={pick} returnFocusTo={boxRef} />
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
}

