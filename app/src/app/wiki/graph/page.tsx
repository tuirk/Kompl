'use client';

/**
 * /wiki/graph — Force-directed knowledge graph. CLIENT component.
 *
 * Fetches /api/wiki/graph (nodes + links), renders with react-force-graph.
 * Nodes colored by page_type, sized by source_count.
 * Click a node → navigate to /wiki/[page_id].
 */

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

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
  'source-summary': '#5b6a78',
  concept: '#58a6ff',
  entity: '#d29922',
  topic: '#3fb950',
};

const NODE_COLOR_DEFAULT = '#8899a6';

export default function WikiGraphPage() {
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const graphRef = useRef<HTMLDivElement>(null);
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
          height: Math.max(400, window.innerHeight - 160),
        });
      }
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const nodeColor = useCallback((node: GraphNode) => {
    return NODE_COLORS[node.group] ?? NODE_COLOR_DEFAULT;
  }, []);

  const nodeVal = useCallback((node: GraphNode) => {
    return Math.max(1, node.source_count ?? 1);
  }, []);

  const nodeLabel = useCallback((node: GraphNode) => {
    return `${node.label} (${node.group}, ${node.category})`;
  }, []);

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      router.push(`/wiki/${node.id}`);
    },
    [router]
  );

  const handleNodeHover = useCallback((node: GraphNode | null) => {
    setHovered(node);
  }, []);

  return (
    <main style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          padding: '0.75rem 1.5rem',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg)',
        }}
      >
        <Link href="/wiki" style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          ← All pages
        </Link>
        <h1 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Knowledge Graph</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '1rem', fontSize: 12, color: 'var(--fg-muted)' }}>
          <span>{graphData.nodes.length} pages</span>
          <span>{graphData.links.length} links</span>
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', gap: '0.75rem', fontSize: 11 }}>
          {Object.entries(NODE_COLORS).map(([type, color]) => (
            <span key={type} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', color: 'var(--fg-muted)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
              {type}
            </span>
          ))}
        </div>
      </header>

      <div ref={graphRef} style={{ flex: 1, position: 'relative', background: 'var(--bg)' }}>
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
            graphData={graphData as { nodes: object[]; links: object[] }}
            width={dimensions.width}
            height={dimensions.height}
            backgroundColor="var(--bg)"
            nodeColor={nodeColor as (node: object) => string}
            nodeVal={nodeVal as (node: object) => number}
            nodeLabel={nodeLabel as (node: object) => string}
            onNodeClick={handleNodeClick as (node: object) => void}
            onNodeHover={handleNodeHover as (node: object | null) => void}
            nodeCanvasObject={(node, ctx, globalScale) => {
              const n = node as GraphNode;
              const r = Math.sqrt(Math.max(1, n.source_count ?? 1)) * 4 + 2;
              ctx.beginPath();
              ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
              ctx.fillStyle = NODE_COLORS[n.group] ?? NODE_COLOR_DEFAULT;
              ctx.fill();
              if (globalScale > 1.5 || hovered?.id === n.id) {
                ctx.font = `${Math.max(8, 11 / globalScale)}px sans-serif`;
                ctx.fillStyle = '#e6edf3';
                ctx.textAlign = 'center';
                ctx.fillText(n.label.slice(0, 32), n.x ?? 0, (n.y ?? 0) + r + 6);
              }
            }}
            linkColor={() => '#2a3947'}
            linkWidth={1}
            cooldownTicks={80}
          />
        )}
      </div>
    </main>
  );
}
