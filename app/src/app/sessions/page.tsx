'use client';

/**
 * /sessions — Compile session history.
 *
 * Lists every compile_progress row newest-first. Each row links to the
 * per-session progress page where the user can retry/resume. Data comes
 * from GET /api/compile/sessions.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface SessionSummary {
  session_id: string;
  status: string;
  current_step: string | null;
  source_count: number;
  done_count: number;
  total_steps: number;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface SessionsResponse {
  items: SessionSummary[];
  count: number;
  total: number;
}

const STATUS_COLOR: Record<string, string> = {
  completed: 'var(--accent)',
  failed:    'var(--danger)',
  cancelled: 'var(--fg-subtle)',
  running:   'var(--accent)',
  queued:    'var(--fg-muted)',
};

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year:   'numeric',
    month:  'short',
    day:    '2-digit',
    hour:   '2-digit',
    minute: '2-digit',
  });
}

export default function SessionsPage() {
  const [data,    setData]    = useState<SessionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/compile/sessions?limit=100');
        if (!res.ok) {
          if (!cancelled) setError(`Failed to load sessions (${res.status}).`);
          return;
        }
        const json = await res.json() as SessionsResponse;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setError('Failed to load sessions — network error.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '2rem 40px calc(5rem + 32px)' }}>

      {/* Back link */}
      <a
        href="/feed"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontFamily: 'var(--font-mono)', fontSize: 10,
          textTransform: 'uppercase', letterSpacing: '1px',
          color: 'var(--fg-dim)', textDecoration: 'none',
          marginBottom: 24,
        }}
      >
        ← Activity
      </a>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 }}>
        <h1 style={{
          fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 24,
          letterSpacing: '1.8px', textTransform: 'uppercase', color: 'var(--fg)', margin: 0,
        }}>
          Compile Sessions
        </h1>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', letterSpacing: '0.5px' }}>
          {data ? `[ ${data.total} session${data.total !== 1 ? 's' : ''} ]` : ''}
        </span>
      </div>

      {loading && (
        <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-dim)', letterSpacing: '0.5px' }}>
          Loading…
        </p>
      )}

      {error && (
        <pre style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--danger)',
          background: 'rgba(var(--danger-rgb),0.08)', border: '1px solid rgba(var(--danger-rgb),0.2)',
          padding: '12px 16px', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {error}
        </pre>
      )}

      {!loading && !error && data && data.items.length === 0 && (
        <p style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-dim)',
          letterSpacing: '0.5px', padding: '32px 0',
        }}>
          No compile sessions yet.
        </p>
      )}

      {!loading && !error && data && data.items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {data.items.map((s) => {
            const dotColor = STATUS_COLOR[s.status] ?? 'var(--fg-muted)';
            const queryQueued = s.source_count > 0 ? s.source_count : 0;
            const when =
              s.completed_at ?? s.started_at ?? s.created_at;
            const progressFrag =
              s.total_steps > 0 ? `${s.done_count}/${s.total_steps}` : '—';
            return (
              <Link
                key={s.session_id}
                href={`/onboarding/progress?session_id=${encodeURIComponent(s.session_id)}&queued=${queryQueued}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '160px 100px 1fr 90px 80px',
                  alignItems: 'center',
                  gap: 24,
                  padding: '14px 16px',
                  borderTop: '1px solid rgba(var(--separator-rgb),0.1)',
                  textDecoration: 'none',
                  color: 'var(--fg)',
                  transition: 'background 0.1s',
                }}
              >
                {/* Timestamp */}
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.5px',
                  color: 'var(--fg-subtle)', whiteSpace: 'nowrap',
                }}>
                  {formatTimestamp(when)}
                </span>

                {/* Status */}
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, background: dotColor, flexShrink: 0 }} />
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 10,
                    textTransform: 'uppercase', letterSpacing: '1px',
                    color: dotColor,
                  }}>
                    {s.status}
                  </span>
                </span>

                {/* Error or current step or session id */}
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 11,
                  color: s.status === 'failed' ? 'var(--danger)' : 'var(--fg-secondary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {s.status === 'failed' && s.error
                    ? s.error
                    : s.current_step
                      ? `at ${s.current_step}`
                      : s.session_id.slice(0, 8)}
                </span>

                {/* Sources */}
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10,
                  color: 'var(--fg-dim)', textAlign: 'right', whiteSpace: 'nowrap',
                }}>
                  {s.source_count > 0 ? `${s.source_count} src` : '—'}
                </span>

                {/* Step progress */}
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10,
                  color: 'var(--fg-dim)', textAlign: 'right', whiteSpace: 'nowrap',
                }}>
                  {progressFrag}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
