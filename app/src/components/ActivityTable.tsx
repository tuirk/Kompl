'use client';

/**
 * ActivityTable — shared polling component used by the dashboard (limit=50)
 * and the full activity feed (no limit).
 *
 * Polls GET /api/activity?since=<watermark> every `pollInterval` ms.
 * Groups rows by source_id so each source shows a single status line.
 */

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

interface ActivityRow {
  id: number;
  timestamp: string;
  action_type: string;
  source_id: string | null;
  details: string | null; // JSON TEXT
}

interface SourceState {
  source_id: string;
  latest_id: number;
  status: 'queued' | 'ready' | 'compiled' | 'failed' | 'unknown';
  timestamp: string;
  title: string | null;
  page_id: string | null;
  error: string | null;
}

function parseDetails(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function mergeStates(existing: Map<string, SourceState>, rows: ActivityRow[]): Map<string, SourceState> {
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const next = new Map(existing);

  for (const row of sorted) {
    if (!row.source_id) continue;
    const prev = next.get(row.source_id);
    const details = parseDetails(row.details);
    const title =
      details && typeof details.title === 'string' ? details.title : (prev?.title ?? null);
    const error =
      details && typeof details.error === 'string' ? details.error : (prev?.error ?? null);
    const page_id =
      details && typeof details.page_id === 'string' ? details.page_id : (prev?.page_id ?? null);

    let status: SourceState['status'] = prev?.status ?? 'unknown';
    if (row.action_type === 'ingest_accepted') status = 'queued';
    else if (row.action_type === 'source_stored') status = 'ready';
    else if (row.action_type === 'source_compiled') status = 'compiled';
    else if (row.action_type === 'ingest_failed') status = 'failed';
    else if (row.action_type === 'compile_failed') status = 'failed';

    next.set(row.source_id, {
      source_id: row.source_id,
      latest_id: row.id,
      status,
      timestamp: row.timestamp,
      title,
      page_id,
      error,
    });
  }
  return next;
}

function formatTime(iso: string): string {
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 19);
}

const STATUS_STYLES: Record<SourceState['status'], { color: string; label: string }> = {
  queued: { color: 'var(--warning)', label: 'queued' },
  ready: { color: 'var(--warning)', label: 'indexing…' },
  compiled: { color: 'var(--success)', label: 'compiled' },
  failed: { color: 'var(--danger)', label: 'failed' },
  unknown: { color: 'var(--fg-muted)', label: 'unknown' },
};

interface ActivityTableProps {
  /** Cap the number of rendered rows. Undefined = show all. */
  limit?: number;
  /** Polling interval in ms. Default 2000. */
  pollInterval?: number;
}

export function ActivityTable({ limit, pollInterval = 2000 }: ActivityTableProps) {
  const [states, setStates] = useState<Map<string, SourceState>>(new Map());
  const [pollError, setPollError] = useState<string | null>(null);
  const sinceRef = useRef<string>(new Date(0).toISOString());

  useEffect(() => {
    let alive = true;

    async function poll() {
      try {
        const res = await fetch(`/api/activity?since=${encodeURIComponent(sinceRef.current)}`);
        if (!res.ok) throw new Error(`poll failed: ${res.status}`);
        const body = (await res.json()) as { items: ActivityRow[]; count: number };
        if (!alive) return;

        if (body.items.length > 0) {
          setStates((prev) => mergeStates(prev, body.items));
          const maxTs = body.items.reduce(
            (acc, r) => (r.timestamp > acc ? r.timestamp : acc),
            sinceRef.current
          );
          sinceRef.current = maxTs;
        } else {
          sinceRef.current = new Date().toISOString();
        }
        setPollError(null);
      } catch (e) {
        if (!alive) return;
        setPollError(e instanceof Error ? e.message : 'poll error');
      }
    }

    poll();
    const interval = setInterval(poll, pollInterval);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [pollInterval]);

  const sorted = Array.from(states.values()).sort((a, b) => b.latest_id - a.latest_id);
  const rows = limit !== undefined ? sorted.slice(0, limit) : sorted;

  return (
    <>
      {pollError && (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--danger)',
            color: 'var(--danger)',
            padding: '0.7em 1em',
            borderRadius: 6,
            marginBottom: '1rem',
            fontSize: 14,
          }}
        >
          Polling error: {pollError}
        </div>
      )}

      {rows.length === 0 ? (
        <p style={{ color: 'var(--fg-muted)' }}>No activity yet.</p>
      ) : (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--bg-card)',
            overflow: 'hidden',
          }}
        >
          {rows.map((s) => {
            const style = STATUS_STYLES[s.status];
            return (
              <div
                key={s.source_id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '86px 1fr 90px 90px',
                  gap: '1rem',
                  padding: '0.85rem 1rem',
                  borderBottom: '1px solid var(--border)',
                  alignItems: 'center',
                  fontSize: 14,
                }}
              >
                <span style={{ color: 'var(--fg-muted)', fontFamily: 'ui-monospace, Consolas, monospace' }}>
                  {formatTime(s.timestamp)}
                </span>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.title ?? <code style={{ color: 'var(--fg-muted)' }}>{s.source_id.slice(0, 8)}</code>}
                  {s.status === 'failed' && s.error && (
                    <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 2 }}>{s.error}</div>
                  )}
                </span>
                <span style={{ color: style.color, fontWeight: 500 }}>{style.label}</span>
                <span style={{ textAlign: 'right' }}>
                  {s.status === 'compiled' && s.page_id ? (
                    <Link href={`/wiki/${s.page_id}`}>View wiki page →</Link>
                  ) : s.status === 'ready' ? (
                    <Link href={`/source/${s.source_id}`}>View source →</Link>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
