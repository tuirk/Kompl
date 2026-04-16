'use client';

/**
 * /wiki/graph — Force-directed knowledge graph. CLIENT component.
 *
 * Fetches /api/wiki/graph (nodes + links), renders with react-force-graph-2d.
 * Nodes colored by page_type, sized by source_count.
 * Click a node → opens slide-in preview panel (right side).
 * Hover → custom styled tooltip card.
 */

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ForceGraphMethods } from 'react-force-graph-2d';

// react-force-graph-2d is the 2D-only variant of the force-graph family.
// Using it instead of the barrel package (react-force-graph) avoids pulling in
// 3d-force-graph → aframe-forcegraph-component which calls AFRAME.registerComponent()
// as a module-level side effect even when only ForceGraph2D is used.
// Must be dynamic (no SSR) — uses canvas/WebGL APIs.
const ForceGraph2D = dynamic(
  () => import('react-force-graph-2d').then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <div style={{ color: 'var(--fg-muted)', padding: '2rem', textAlign: 'center' }}>
        Loading graph…
      </div>
    ),
  }
);

interface GraphNode {
  id: string;
  label: string;
  group: string;
  category: string;
  source_count: number;
  summary?: string | null;
  last_updated?: string;
  // ForceGraph adds these at runtime
  x?: number;
  y?: number;
}

interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  type: string;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

const NODE_COLORS: Record<string, string> = {
  'source-summary': '#6b7280',
  concept:          '#3b82f6',
  entity:           '#f59e0b',
  comparison:       '#8b5cf6',
  overview:         '#10b981',
};

const NODE_COLOR_DEFAULT = '#8899a6';

function timeAgo(iso: string | undefined): string {
  if (!iso) return 'unknown';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d === 0) return 'today';
  if (d === 1) return '1 day ago';
  return `${d} days ago`;
}

export default function WikiGraphPage() {
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const zoomLevelRef = useRef(1);
  const graphRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const [dimensions, setDimensions] = useState({ width: 900, height: 620 });
  const router = useRouter();

  useEffect(() => {
    fetch('/api/wiki/graph')
      .then((r) => {
        if (!r.ok) throw new Error(`graph fetch failed: ${r.status}`);
        return r.json() as Promise<GraphData>;
      })
      .then((data) => {
        setGraphData(data);
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'failed to load graph');
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    function measure() {
      if (graphRef.current) {
        setDimensions({
          width: graphRef.current.offsetWidth,
          height: Math.max(400, graphRef.current.offsetHeight),
        });
      }
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Precompute edge count per node for relatedness %
  const linkCountMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const l of graphData.links) {
      const s = typeof l.source === 'string' ? l.source : (l.source as GraphNode).id;
      const t = typeof l.target === 'string' ? l.target : (l.target as GraphNode).id;
      map[s] = (map[s] ?? 0) + 1;
      map[t] = (map[t] ?? 0) + 1;
    }
    return map;
  }, [graphData.links]);

  const maxLinks = useMemo(
    () => Math.max(1, ...Object.values(linkCountMap)),
    [linkCountMap]
  );

  // Neighbors of selected node
  const neighborSet = useMemo(() => {
    if (!selectedNode) return new Set<string>();
    const set = new Set<string>();
    for (const l of graphData.links) {
      const s = typeof l.source === 'string' ? l.source : (l.source as GraphNode).id;
      const t = typeof l.target === 'string' ? l.target : (l.target as GraphNode).id;
      if (s === selectedNode.id) set.add(t);
      if (t === selectedNode.id) set.add(s);
    }
    return set;
  }, [selectedNode, graphData.links]);

  const visibleGraphData = useMemo(() => {
    if (hiddenTypes.size === 0) return graphData;
    const visibleIds = new Set(
      graphData.nodes.filter((n) => !hiddenTypes.has(n.group)).map((n) => n.id)
    );
    return {
      nodes: graphData.nodes.filter((n) => !hiddenTypes.has(n.group)),
      links: graphData.links.filter((l) => {
        const s = typeof l.source === 'string' ? l.source : (l.source as GraphNode).id;
        const t = typeof l.target === 'string' ? l.target : (l.target as GraphNode).id;
        return visibleIds.has(s) && visibleIds.has(t);
      }),
    };
  }, [graphData, hiddenTypes]);

  const toggleType = useCallback((type: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  }, []);

  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node);
  }, []);

  const handleNodeHover = useCallback((node: GraphNode | null) => {
    setHovered(node);
  }, []);

  const panelWidth = selectedNode ? 320 : 0;
  const canvasWidth = dimensions.width - panelWidth;

  return (
    <main
      style={{ height: 'calc(100dvh / 0.9 - 97px)', display: 'flex', flexDirection: 'column', background: '#0D0E10', overflow: 'hidden' }}
    >
      {/* Floating header bar */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          padding: '0.75rem 1.5rem',
          borderBottom: '1px solid rgba(71,72,74,0.15)',
          background: 'rgba(36,38,41,0.6)',
          backdropFilter: 'blur(12px)',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <Link
          href="/wiki"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontFamily: 'var(--font-mono)', fontSize: 10,
            textTransform: 'uppercase', letterSpacing: '1px',
            color: 'var(--fg-dim)', textDecoration: 'none',
          }}
        >
          ← Wiki
        </Link>
        <span style={{ width: 1, height: 16, background: 'rgba(71,72,74,0.3)', display: 'inline-block' }} />
        <h1 style={{ margin: 0, fontSize: '0.875rem', fontWeight: 700, fontFamily: 'var(--font-heading)', color: 'var(--fg)', letterSpacing: '-0.35px' }}>
          Knowledge Graph
        </h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '1rem', fontSize: 10, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '-0.45px', fontFamily: 'var(--font-body)' }}>
          <span>{graphData.nodes.length} pages</span>
          <span>·</span>
          <span>{graphData.links.length} links</span>
        </div>
      </header>

      <div
        ref={graphRef}
        style={{ flex: 1, position: 'relative', background: '#0D0E10', overflow: 'hidden' }}
        onMouseMove={(e) => setMousePos({ x: e.clientX, y: e.clientY })}
      >
        {loading && (
          <div style={{ color: 'var(--fg-muted)', padding: '3rem', textAlign: 'center' }}>
            Loading graph…
          </div>
        )}
        {error && (
          <div style={{ color: 'var(--danger)', padding: '3rem', textAlign: 'center' }}>{error}</div>
        )}
        {!loading && !error && graphData.nodes.length === 0 && (
          <div style={{ color: 'var(--fg-muted)', padding: '3rem', textAlign: 'center' }}>
            No pages compiled yet. <Link href="/">Add a source</Link> to build the graph.
          </div>
        )}
        {!loading && !error && graphData.nodes.length > 0 && (
          <ForceGraph2D
            ref={fgRef}
            graphData={visibleGraphData as { nodes: object[]; links: object[] }}
            width={canvasWidth}
            height={dimensions.height}
            backgroundColor="#0D0E10"
            nodeLabel={() => ''}
            nodeColor={(node) => {
              const n = node as GraphNode;
              return NODE_COLORS[n.group] ?? NODE_COLOR_DEFAULT;
            }}
            nodeVal={(node) => Math.max(1, (node as GraphNode).source_count ?? 1)}
            onNodeClick={handleNodeClick as (node: object) => void}
            onNodeHover={handleNodeHover as (node: object | null) => void}
            nodeCanvasObject={(node, ctx, globalScale) => {
              const n = node as GraphNode;
              const r = Math.sqrt(Math.max(1, n.source_count ?? 1)) * 4 + 2;
              const isSelected = selectedNode?.id === n.id;
              const isNeighbor = !isSelected && neighborSet.has(n.id);
              const isDimmed = !!selectedNode && !isSelected && !isNeighbor;
              const color = NODE_COLORS[n.group] ?? NODE_COLOR_DEFAULT;

              // Main circle
              ctx.beginPath();
              ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
              ctx.fillStyle = isDimmed ? color + '33' : color;
              ctx.fill();

              if (isSelected) {
                // White outer ring (4px gap)
                ctx.beginPath();
                ctx.arc(n.x ?? 0, n.y ?? 0, r + 4, 0, 2 * Math.PI);
                ctx.strokeStyle = '#FFFFFF';
                ctx.lineWidth = 2;
                ctx.stroke();
                // Teal glow halo
                ctx.beginPath();
                ctx.arc(n.x ?? 0, n.y ?? 0, r + 12, 0, 2 * Math.PI);
                ctx.strokeStyle = 'rgba(137, 240, 203, 0.3)';
                ctx.lineWidth = 6;
                ctx.stroke();
              } else if (isNeighbor) {
                // Teal connection ring
                ctx.beginPath();
                ctx.arc(n.x ?? 0, n.y ?? 0, r + 2, 0, 2 * Math.PI);
                ctx.strokeStyle = 'rgba(137, 240, 203, 0.4)';
                ctx.lineWidth = 2;
                ctx.stroke();
              }

              // Labels: show on selected, hovered, or zoomed in
              if (globalScale > 1.5 || isSelected || hovered?.id === n.id) {
                ctx.font = `${Math.max(8, 11 / globalScale)}px sans-serif`;
                ctx.fillStyle = isDimmed ? 'rgba(230,237,243,0.3)' : '#e6edf3';
                ctx.textAlign = 'center';
                ctx.fillText(n.label.slice(0, 32), n.x ?? 0, (n.y ?? 0) + r + 6);
              }
            }}
            linkColor={(link) => {
              if (!selectedNode) return '#2a3947';
              const l = link as GraphLink;
              const s = typeof l.source === 'string' ? l.source : (l.source as GraphNode).id;
              const t = typeof l.target === 'string' ? l.target : (l.target as GraphNode).id;
              if (s === selectedNode.id || t === selectedNode.id) return 'rgba(137,240,203,0.6)';
              return 'rgba(42,57,71,0.2)';
            }}
            linkWidth={(link) => {
              if (!selectedNode) return 1;
              const l = link as GraphLink;
              const s = typeof l.source === 'string' ? l.source : (l.source as GraphNode).id;
              const t = typeof l.target === 'string' ? l.target : (l.target as GraphNode).id;
              return (s === selectedNode.id || t === selectedNode.id) ? 1.5 : 0.5;
            }}
            onZoom={({ k }) => { zoomLevelRef.current = k; }}
            cooldownTicks={80}
          />
        )}

        {/* Hover tooltip card — hidden when panel is open */}
        {hovered && !selectedNode && (
          <div
            style={{
              position: 'fixed',
              left: mousePos.x - 96,
              top: mousePos.y - 128,
              width: 192,
              background: 'rgba(30, 32, 34, 0.9)',
              border: '1px solid rgba(71, 72, 74, 0.3)',
              backdropFilter: 'blur(8px)',
              padding: '12px',
              pointerEvents: 'none',
              zIndex: 50,
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-heading)',
                fontWeight: 700,
                fontSize: 14,
                lineHeight: '20px',
                color: '#FDFBFE',
              }}
            >
              {hovered.label}
            </div>
            <div
              style={{
                fontFamily: 'var(--font-body)',
                fontSize: 9,
                letterSpacing: '0.9px',
                textTransform: 'uppercase',
                color: '#89F0CB',
                marginTop: 2,
                paddingBottom: 4,
              }}
            >
              {hovered.group} · {hovered.source_count} sources
            </div>
            <div
              style={{
                borderTop: '1px solid rgba(71,72,74,0.1)',
                paddingTop: 8,
                marginTop: 4,
                fontFamily: 'var(--font-heading)',
                fontSize: 9,
                letterSpacing: '-0.45px',
                textTransform: 'uppercase',
                color: '#FDFBFE',
                opacity: 0.5,
              }}
            >
              Updated {timeAgo(hovered.last_updated)}
            </div>
          </div>
        )}

        {/* Floating Schema Classification legend — bottom left */}
        <div
          style={{
            position: 'absolute',
            left: 24,
            bottom: 24,
            background: 'rgba(18, 19, 22, 0.8)',
            border: '1px solid rgba(71, 72, 74, 0.15)',
            backdropFilter: 'blur(6px)',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-body)',
              fontWeight: 700,
              fontSize: 10,
              lineHeight: '15px',
              letterSpacing: '1px',
              textTransform: 'uppercase',
              color: '#ABABAD',
            }}
          >
            Schema Classification
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Object.entries(NODE_COLORS).map(([type, color]) => {
              const hidden = hiddenTypes.has(type);
              return (
                <label
                  key={type}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', userSelect: 'none' }}
                >
                  <input
                    type="checkbox"
                    checked={!hidden}
                    onChange={() => toggleType(type)}
                    style={{ display: 'none' }}
                  />
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: hidden ? 'transparent' : color,
                      border: `1.5px solid ${color}`,
                      flexShrink: 0,
                      display: 'inline-block',
                      transition: 'background 150ms',
                    }}
                  />
                  <span
                    style={{
                      fontFamily: 'var(--font-body)',
                      fontSize: 11,
                      lineHeight: '16px',
                      letterSpacing: '0.55px',
                      textTransform: 'uppercase',
                      color: hidden ? '#52525b' : '#FDFBFE',
                      transition: 'color 150ms',
                    }}
                  >
                    {type === 'source-summary' ? 'Source Summary' : type.charAt(0).toUpperCase() + type.slice(1)}
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {/* Floating zoom controls — bottom right */}
        <div
          style={{
            position: 'absolute',
            right: selectedNode ? 344 : 24,
            bottom: 24,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            transition: 'right 0.25s ease',
          }}
        >
          {(
            [
              {
                label: '+',
                onClick: () => fgRef.current?.zoom(zoomLevelRef.current * 1.3, 300),
              },
              {
                label: '−',
                onClick: () => fgRef.current?.zoom(zoomLevelRef.current * 0.77, 300),
              },
              {
                label: '⊙',
                onClick: () => fgRef.current?.zoomToFit(400),
              },
            ] as { label: string; onClick: () => void }[]
          ).map(({ label, onClick }) => (
            <button
              key={label}
              onClick={onClick}
              style={{
                width: 40,
                height: 40,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(36, 38, 41, 0.6)',
                border: '1px solid rgba(71, 72, 74, 0.2)',
                backdropFilter: 'blur(6px)',
                color: '#FDFBFE',
                fontSize: label === '⊙' ? 14 : 18,
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Slide-in preview panel */}
        {selectedNode && (() => {
          const nodeLinks = linkCountMap[selectedNode.id] ?? 0;
          const relatedness = Math.round((nodeLinks / maxLinks) * 100);
          const nodeColor = NODE_COLORS[selectedNode.group] ?? NODE_COLOR_DEFAULT;

          return (
            <div
              style={{
                position: 'absolute',
                right: 0,
                top: 0,
                bottom: 0,
                width: 320,
                background: 'rgba(24, 26, 28, 0.95)',
                borderLeft: '1px solid rgba(71, 72, 74, 0.1)',
                boxShadow: '-20px 0px 40px rgba(0, 0, 0, 0.5)',
                backdropFilter: 'blur(20px)',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              {/* Header */}
              <div style={{ padding: '24px 24px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div
                      style={{
                        fontFamily: 'var(--font-body)',
                        fontWeight: 900,
                        fontSize: 9,
                        lineHeight: '14px',
                        letterSpacing: '1.8px',
                        textTransform: 'uppercase',
                        color: '#89F0CB',
                      }}
                    >
                      Selected Node
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--font-heading)',
                        fontWeight: 900,
                        fontSize: 24,
                        lineHeight: '32px',
                        letterSpacing: '-1.2px',
                        textTransform: 'uppercase',
                        color: '#FDFBFE',
                        maxWidth: 200,
                      }}
                    >
                      {selectedNode.label}
                    </div>
                  </div>
                  <button
                    onClick={() => setSelectedNode(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#ABABAD',
                      cursor: 'pointer',
                      fontSize: 16,
                      padding: 0,
                      lineHeight: 1,
                      marginTop: 2,
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Thumbnail strip with node color gradient */}
              <div
                style={{
                  margin: '16px 24px 0',
                  height: 152,
                  position: 'relative',
                  overflow: 'hidden',
                  background: `linear-gradient(135deg, ${nodeColor}33 0%, ${nodeColor}11 100%)`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {/* Node type icon */}
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: '50%',
                    background: nodeColor,
                    boxShadow: `0 0 0 4px #FFFFFF33, 0 0 24px ${nodeColor}66`,
                  }}
                />
                {/* Fade overlay */}
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'linear-gradient(0deg, rgba(24,26,28,0.95) 0%, rgba(24,26,28,0) 60%)',
                  }}
                />
              </div>

              {/* Summary + stats */}
              <div
                style={{
                  flex: 1,
                  padding: '0 24px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 16,
                  overflowY: 'auto',
                  marginTop: 16,
                }}
              >
                {/* Summary text */}
                <div
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 400,
                    fontSize: 14,
                    lineHeight: '23px',
                    color: '#E2E2E5',
                    opacity: 0.8,
                  }}
                >
                  {selectedNode.summary ?? 'No summary available for this page yet.'}
                </div>

                {/* Stats row */}
                <div
                  style={{
                    borderTop: '1px solid rgba(71,72,74,0.1)',
                    paddingTop: 17,
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div
                      style={{
                        fontFamily: 'var(--font-body)',
                        fontSize: 9,
                        letterSpacing: '0.9px',
                        textTransform: 'uppercase',
                        color: '#FDFBFE',
                        opacity: 0.5,
                      }}
                    >
                      Relatedness
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--font-heading)',
                        fontWeight: 700,
                        fontSize: 16,
                        lineHeight: '24px',
                        color: '#89F0CB',
                      }}
                    >
                      {relatedness}%
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div
                      style={{
                        fontFamily: 'var(--font-body)',
                        fontSize: 9,
                        letterSpacing: '0.9px',
                        textTransform: 'uppercase',
                        color: '#FDFBFE',
                        opacity: 0.5,
                      }}
                    >
                      Key Links
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--font-heading)',
                        fontWeight: 700,
                        fontSize: 16,
                        lineHeight: '24px',
                        color: '#FDFBFE',
                      }}
                    >
                      {selectedNode.source_count} Active
                    </div>
                  </div>
                </div>
              </div>

              {/* Open Page button */}
              <div style={{ padding: '0 24px 24px' }}>
                <button
                  onClick={() => router.push(`/wiki/${selectedNode.id}`)}
                  style={{
                    width: '100%',
                    padding: '16px 0',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    border: '1px solid rgba(137, 240, 203, 0.3)',
                    background: 'none',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 700,
                    fontSize: 12,
                    lineHeight: '16px',
                    letterSpacing: '1.2px',
                    textTransform: 'uppercase',
                    color: '#89F0CB',
                  }}
                >
                  Open Page
                  <span style={{ fontSize: 10 }}>→</span>
                </button>
              </div>
            </div>
          );
        })()}
      </div>
    </main>
  );
}
