'use client';

/**
 * ActivityTable — chronological activity event stream.
 *
 * Polls GET /api/activity?since=<watermark> every `pollInterval` ms.
 * 4-column layout: TIMESTAMP | DESCRIPTION | TYPE | ACTION
 * source_title is resolved server-side via JOIN — never shows raw IDs.
 *
 * Per-event rendering (badge + row content + retriable flag) is delegated to
 * the registry at `@/lib/activity-events`. Retry button lives in its own
 * component (`@/components/RetryButton`) and is used by the registry's
 * failure-row renderers.
 */

import { useEffect, useRef, useState } from 'react';
import {
  getEventDef,
  resolveBadge,
  type FeedActivityRow,
  type RowContent,
  type Tone,
} from '@/lib/activity-events';

function formatTime(iso: string): string {
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 19);
}

// ── Badge config ──────────────────────────────────────────────────────────────

interface BadgeCfg {
  label: string;
  bg: string;
  border: string;
  color: string;
}

const MINT  = { bg: 'rgba(var(--accent-rgb),0.1)', border: 'rgba(var(--accent-rgb),0.2)', color: 'var(--accent)' };
const NEUT  = { bg: 'rgba(var(--separator-rgb),0.1)',    border: 'rgba(var(--separator-rgb),0.2)',    color: 'var(--fg)' };
const DIM   = { bg: 'rgba(var(--separator-rgb),0.1)',    border: 'rgba(var(--separator-rgb),0.2)',    color: 'var(--fg-dim)' };
const RED   = { bg: 'rgba(var(--danger-rgb),0.1)', border: 'rgba(var(--danger-rgb),0.2)', color: 'var(--danger)' };

const TONE_MAP: Record<Tone, { bg: string; border: string; color: string }> = {
  mint: MINT, neut: NEUT, dim: DIM, red: RED,
};

function getBadge(row: FeedActivityRow): BadgeCfg {
  const def = getEventDef(row.action_type);
  if (def) {
    const b = resolveBadge(def, row);
    return { ...TONE_MAP[b.tone], label: b.label };
  }
  // Fallback for n8n-posted event types not yet in the registry.
  return {
    ...DIM,
    label: row.action_type.replace(/_/g, ' ').toUpperCase().slice(0, 12),
  };
}

function TypeBadge({ cfg }: { cfg: BadgeCfg }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 7px',
      background: cfg.bg, border: `1px solid ${cfg.border}`,
      fontFamily: 'var(--font-heading)', fontWeight: 700,
      fontSize: 9, letterSpacing: '0.45px', textTransform: 'uppercase',
      color: cfg.color, whiteSpace: 'nowrap',
    }}>
      {cfg.label}
    </span>
  );
}

// ── Row content ───────────────────────────────────────────────────────────────

function getRowContent(row: FeedActivityRow): RowContent {
  const def = getEventDef(row.action_type);
  if (def) return def.render(row);
  return {
    primary: <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-dim)' }}>{row.action_type}</span>,
    secondary: null,
    action: null,
    isError: false,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

interface ActivityTableProps {
  pollInterval?: number;
}

const MAX_EVENTS = 200;
const COL = '120px 1fr 110px 60px';

export function ActivityTable({ pollInterval = 2000 }: ActivityTableProps) {
  const [events, setEvents] = useState<FeedActivityRow[]>([]);
  const [pollError, setPollError] = useState<string | null>(null);
  const sinceRef = useRef<string>(new Date(0).toISOString());

  useEffect(() => {
    let alive = true;

    async function poll() {
      try {
        const res = await fetch(`/api/activity?since=${encodeURIComponent(sinceRef.current)}`);
        if (!res.ok) throw new Error(`poll failed: ${res.status}`);
        const body = (await res.json()) as { items: FeedActivityRow[]; count: number };
        if (!alive) return;

        if (body.items.length > 0) {
          setEvents((prev) => {
            const merged = [...body.items, ...prev];
            const seen = new Set<number>();
            const deduped = merged.filter((r) => {
              if (seen.has(r.id)) return false;
              seen.add(r.id);
              return true;
            });
            return deduped.sort((a, b) => b.id - a.id).slice(0, MAX_EVENTS);
          });
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

  return (
    <>
      {pollError && (
        <div style={{ background: 'rgba(var(--danger-rgb),0.08)', border: '1px solid rgba(var(--danger-rgb),0.2)', color: 'var(--danger)', padding: '0.6em 1em', marginBottom: '1rem', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          {pollError}
        </div>
      )}

      {events.length === 0 ? (
        <p style={{ color: 'var(--fg-dim)', fontFamily: 'var(--font-mono)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          No activity yet.
        </p>
      ) : (
        <div style={{ background: 'var(--bg-card)' }}>
          {/* Header */}
          <div style={{ display: 'grid', gridTemplateColumns: COL, background: 'var(--bg-card-hover)', padding: '0 24px' }}>
            {['Timestamp', 'Event', 'Type', 'Action'].map((col, i) => (
              <div key={col} style={{ padding: '16px 0', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 10, letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--fg-dim)', textAlign: i === 3 ? 'right' : 'left' }}>
                {col}
              </div>
            ))}
          </div>

          {/* Rows */}
          {(() => {
            // Track the newest event id per source_id (events are sorted desc).
            // Any retriable-failed row that isn't the newest for its source
            // shows "RETRIED" instead of ↻.
            const newestIdBySource = new Map<string, number>();
            for (const ev of events) {
              if (ev.source_id && !newestIdBySource.has(ev.source_id)) {
                newestIdBySource.set(ev.source_id, ev.id);
              }
            }

            return events.map((ev) => {
            const badge = getBadge(ev);
            const { primary, secondary, action: rawAction, isError } = getRowContent(ev);

            const isLatestForSource = !ev.source_id || newestIdBySource.get(ev.source_id) === ev.id;
            const def = getEventDef(ev.action_type);
            const actionNode = (!isLatestForSource && def?.retriable === true)
              ? <span style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 10, letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--fg-dim)' }}>RETRIED</span>
              : rawAction;

            return (
              <div
                key={ev.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: COL,
                  padding: '0 24px',
                  borderTop: '1px solid rgba(var(--separator-rgb),0.1)',
                  alignItems: 'center',
                }}
              >
                {/* Timestamp */}
                <div style={{ padding: '18px 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-dim)', whiteSpace: 'nowrap' }}>
                  {formatTime(ev.timestamp)}
                </div>

                {/* Description */}
                <div style={{ padding: '14px 0', minWidth: 0 }}>
                  <div style={{
                    fontFamily: 'var(--font-heading)', fontWeight: 400, fontSize: 14,
                    color: isError ? 'var(--danger)' : 'var(--fg)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {primary}
                  </div>
                  {secondary && (
                    <div style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {secondary}
                    </div>
                  )}
                </div>

                {/* Type badge */}
                <div style={{ padding: '17px 0' }}>
                  <TypeBadge cfg={badge} />
                </div>

                {/* Action */}
                <div style={{ padding: '18px 0', textAlign: 'right', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 10, letterSpacing: '1px', textTransform: 'uppercase' }}>
                  {actionNode}
                </div>
              </div>
            );
          });
          })()}
        </div>
      )}
    </>
  );
}
