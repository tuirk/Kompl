'use client';

/**
 * /wiki/graph — the knowledge graph as a topic map. CLIENT component.
 *
 * Loads /api/wiki/graph (pages, one line per page pair with its typed
 * relations, plain links), builds the model once per load
 * (lib/graph-model.ts) and filters it by the legend. Pages are coloured and
 * grouped into islands by category; lines are coloured by relation. Click a
 * page for its connections, a line for the evidence behind it. The side
 * panel lies over the canvas, so opening it never moves the map.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WikiViewToggle from '../../../components/WikiViewToggle';
import { closesPanelOnEscape, type GraphFocus } from '../../../lib/graph-focus';
import type { ViewInsets } from '../../../lib/graph-layout';
import { buildGraphModel, DEFAULT_FILTERS, filterGraph, plainLinksHint, type GraphFilters } from '../../../lib/graph-model';
import { CANVAS_BG } from '../../../lib/graph-palette';
import type { PageConnections } from '../../../lib/relations';
import type { WikiGraph } from '../../../lib/wiki-graph';
import EdgePanel from './EdgePanel';
import GraphCanvas, { type GraphControls } from './GraphCanvas';
import GraphLegend, { LEGEND_LEFT, LEGEND_WIDTH } from './GraphLegend';
import NodePanel from './NodePanel';
import { PANEL_WIDTH } from './panel-parts';

const NO_DATA: WikiGraph = { nodes: [], links: [], missing: [] };
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
  const [legendOpen, setLegendOpen] = useState(true);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<GraphControls | null>(null);

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
      if (closesPanelOnEscape(e)) setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const model = useMemo(() => buildGraphModel(data ?? NO_DATA), [data]);
  const visible = useMemo(() => filterGraph(model, filters), [model, filters]);
  // A fresh cache per load, so panels never show connections from before a reload.
  const connectionsCache = useMemo(() => new Map<string, PageConnections>(), [model]);
  const showHint = useMemo(() => plainLinksHint(model, visible, filters), [model, visible, filters]);

  const selectedNode =
    selected?.kind === 'node' && visible.neighbours.has(selected.id) ? (model.byId.get(selected.id) ?? null) : null;
  const selectedLink =
    selected?.kind === 'link' && visible.linksOf.get(selected.link.a)?.includes(selected.link) ? selected.link : null;
  const panelOpen = selectedNode !== null || selectedLink !== null;
  const insets: ViewInsets = useMemo(
    () => ({
      left: legendOpen ? LEGEND_INSET : 24,
      top: legendOpen ? 44 : FOLDED_LEGEND_TOP,
      right: panelOpen ? PANEL_WIDTH + 24 : 64,
      bottom: 40,
    }),
    [legendOpen, panelOpen]
  );

  const close = useCallback(() => setSelected(null), []);
  const pick = useCallback((id: string) => {
    setSelected({ kind: 'node', id });
    controlsRef.current?.focusNode(id);
  }, []);
  const isShown = useCallback((id: string) => visible.neighbours.has(id), [visible]);

  const pages = visible.nodes.length;
  const lines = visible.links.length;
  const hasPages = data !== null && data.nodes.length > 0;

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
        <header
          style={{
            display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.75rem 1.5rem', zIndex: 30,
            borderBottom: '1px solid rgba(71,72,74,0.15)', background: 'rgba(36,38,41,0.6)', backdropFilter: 'blur(12px)',
          }}
        >
          <h1 style={{ margin: 0, fontSize: '0.875rem', fontWeight: 700, fontFamily: 'var(--font-heading)', color: 'var(--fg)', letterSpacing: '-0.35px' }}>
            Knowledge Graph
          </h1>
          <span style={{ width: 1, height: 16, background: 'rgba(71,72,74,0.3)', display: 'inline-block' }} />
          <span
            aria-live="polite"
            style={{ fontSize: 10, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', fontFamily: 'var(--font-body)' }}
          >
            {pages} page{pages === 1 ? '' : 's'} · {lines} connection{lines === 1 ? '' : 's'}
          </span>
          <div style={{ marginLeft: 'auto' }}>
            <WikiViewToggle active="graph" />
          </div>
        </header>

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
                  width={size.width}
                  height={size.height}
                  insets={insets}
                  coveredLeft={legendOpen ? LEGEND_COVER : 0}
                  coveredRight={panelOpen ? PANEL_WIDTH : 0}
                  controlsRight={panelOpen ? PANEL_WIDTH + 16 : 16}
                  selected={selected}
                  onSelect={setSelected}
                  controlsRef={controlsRef}
                />
              )}
              {!hasPages && (
                <div style={MESSAGE}>
                  {includeArchived ? 'No pages to show.' : 'Every page is archived. Turn on “Show archived” in the legend to see them.'}
                </div>
              )}
              {hasPages && pages === 0 && (
                <div style={{ ...MESSAGE, position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                  Nothing to show with these filters.
                </div>
              )}
              {showHint && <PlainLinksHint onShow={() => setFilters({ ...filters, showPlain: true })} />}
              <GraphLegend
                model={model}
                visible={visible}
                filters={filters}
                onFilters={setFilters}
                includeArchived={includeArchived}
                onIncludeArchived={setIncludeArchived}
                open={legendOpen}
                onOpen={setLegendOpen}
              />
              {selectedNode && (
                <NodePanel key={selectedNode.id} node={selectedNode} isShown={isShown} cache={connectionsCache}
                  onClose={close} onPick={pick} returnFocusTo={boxRef} />
              )}
              {selectedLink && (
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

/** Shown when no line is drawn but plain links join the pages on screen. */
function PlainLinksHint({ onShow }: { onShow(): void }) {
  return (
    <div
      role="status"
      style={{
        position: 'absolute', left: '50%', bottom: 20, transform: 'translateX(-50%)', zIndex: 10,
        padding: '8px 14px', background: 'rgba(18,19,22,0.9)', border: '1px solid rgba(71,72,74,0.3)',
        fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--fg-muted)', whiteSpace: 'nowrap',
      }}
    >
      No typed connections between these pages yet.{' '}
      <button
        type="button"
        onClick={onShow}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'var(--accent)' }}
      >
        Show plain links
      </button>
    </div>
  );
}
