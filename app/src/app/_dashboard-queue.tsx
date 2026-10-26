'use client';

/**
 * Dashboard "Recently processed": the four newest sources with their compile
 * state. Each card opens its source page; a failed one also offers Retry.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { formatDate } from '@/lib/date-format';

export interface SourceQueueRow {
  source_id: string;
  title: string;
  source_type: string;
  date_ingested: string;
  compile_status: string;
}

const GREEN_DOT = <div style={{ width: 9, height: 9, borderRadius: '50%', background: 'rgba(var(--accent-rgb),0.5)', flexShrink: 0 }} />;
const DIM_DOT   = <div style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--separator)',      flexShrink: 0 }} />;

function getStatusCfg(status: string) {
  switch (status) {
    case 'active':
    case 'extracted':
    case 'in_progress':
      return { border: 'rgba(var(--accent-rgb),0.4)', icon: GREEN_DOT, fillColor: 'rgba(var(--accent-rgb),0.3)', progress: 100, dim: false };
    case 'failed':
      return { border: 'rgba(var(--danger-rgb),0.4)', icon: <AlertTriangle size={13} style={{ color: 'var(--danger)' }} />, fillColor: 'var(--danger)', progress: 100, dim: false };
    default:
      return { border: 'rgba(var(--accent-rgb),0.15)', icon: DIM_DOT, fillColor: 'var(--separator)', progress: 100, dim: true };
  }
}

const QUEUE_POLL_MS = 5000;

export default function ProcessQueue() {
  const [sources, setSources] = useState<SourceQueueRow[]>([]);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState(false);

  const fetchSources = useCallback(() => {
    void fetch('/api/sources?limit=4&sort_by=date_ingested&sort_order=desc')
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data: { sources: SourceQueueRow[] }) => {
        setSources((data.sources ?? []).slice(0, 4));
        setLoadError(false);
      })
      .catch(() => setLoadError(true));
  }, []);

  useEffect(() => {
    fetchSources();
    const id = setInterval(fetchSources, QUEUE_POLL_MS);
    return () => clearInterval(id);
  }, [fetchSources]);

  const handleRetry = useCallback(async (sourceId: string) => {
    setRetrying(prev => new Set(prev).add(sourceId));
    try {
      const res = await fetch(`/api/sources/${sourceId}/recompile`, { method: 'POST' });
      if (!res.ok && res.status !== 409) throw new Error(`${res.status}`);
      const body = (await res.json()) as { session_id?: string | null };
      if (body.session_id) {
        localStorage.setItem('kompl_active_compile', JSON.stringify({ session_id: body.session_id, source_count: 0 }));
      }
      // Optimistically flip status to pending so the card dims down
      setSources(prev => prev.map(s => s.source_id === sourceId ? { ...s, compile_status: 'pending' } : s));
    } catch {
      // silently ignore — card retains failed state, user can try again
    } finally {
      setRetrying(prev => { const next = new Set(prev); next.delete(sourceId); return next; });
    }
  }, []);

  if (loadError && sources.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <p style={{ color: 'var(--danger)', fontSize: '0.9rem', margin: 0 }}>Couldn&apos;t load sources.</p>
        <button onClick={() => fetchSources()} style={{
          background: 'transparent', border: '1px solid var(--border)', color: 'var(--fg-secondary)',
          padding: '4px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, cursor: 'pointer',
          textTransform: 'uppercase', letterSpacing: '0.5px',
        }}>Retry</button>
      </div>
    );
  }
  if (sources.length === 0) {
    return <p style={{ color: 'var(--fg-muted)', fontSize: '0.9rem', margin: 0 }}>No sources yet.</p>;
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
      {sources.map((s) => (
        <QueueCard
          key={s.source_id}
          source={s}
          retrying={retrying.has(s.source_id)}
          onRetry={() => void handleRetry(s.source_id)}
        />
      ))}
    </div>
  );
}

/**
 * One source: the card opens its source page. Retry (failed sources only)
 * sits outside the link, so the two never nest. The full title shows on
 * hover, since long titles are cut short.
 */
export function QueueCard({
  source: s,
  retrying,
  onRetry,
}: {
  source: SourceQueueRow;
  retrying: boolean;
  onRetry: () => void;
}) {
  const cfg = getStatusCfg(s.compile_status);
  return (
    <div
      style={{
        background: 'var(--bg-card)',
        borderLeft: `2px solid ${cfg.border}`,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minWidth: 0,
        opacity: cfg.dim ? 0.5 : 1,
      }}
    >
      <Link
        href={`/source/${encodeURIComponent(s.source_id)}`}
        title={s.title}
        style={{ display: 'flex', flexDirection: 'column', gap: 8, color: 'inherit', textDecoration: 'none', minWidth: 0 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-dim)', letterSpacing: '0.3px' }}>
            {formatDate(s.date_ingested)}
          </span>
          {cfg.icon}
        </div>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 14, lineHeight: '20px', color: 'var(--fg-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {s.title}
        </div>
        <div style={{ height: 4, background: 'var(--bg-track)', position: 'relative' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${cfg.progress}%`, background: cfg.fillColor }} />
        </div>
      </Link>
      {s.compile_status === 'failed' && (
        <button
          onClick={onRetry}
          disabled={retrying}
          style={{
            marginTop: 2,
            background: 'transparent',
            border: '1px solid rgba(var(--danger-rgb),0.3)',
            color: retrying ? 'var(--fg-dim)' : 'var(--danger)',
            fontFamily: 'var(--font-body)',
            fontWeight: 700,
            fontSize: 9,
            letterSpacing: '0.8px',
            textTransform: 'uppercase',
            padding: '4px 8px',
            cursor: retrying ? 'default' : 'pointer',
            transition: 'var(--transition-fast)',
            opacity: retrying ? 0.5 : 1,
          }}
        >
          {retrying ? 'Queuing…' : '↻ Retry'}
        </button>
      )}
    </div>
  );
}
