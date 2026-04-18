'use client';

/**
 * ActivityTable — chronological activity event stream.
 *
 * Polls GET /api/activity?since=<watermark> every `pollInterval` ms.
 * 4-column layout: TIMESTAMP | DESCRIPTION | TYPE | ACTION
 * source_title is resolved server-side via JOIN — never shows raw IDs.
 *
 * Failed events (compile_failed, extraction_failed, ingest_failed) show a
 * "↻" retry button that calls POST /api/sources/[source_id]/recompile and
 * stores the returned session_id in localStorage so the dashboard banner
 * picks it up automatically.
 */

import Link from 'next/link';
import { useEffect, useRef, useState, useCallback } from 'react';

interface ActivityRow {
  id: number;
  timestamp: string;
  action_type: string;
  source_id: string | null;
  source_title: string | null; // joined server-side from sources
  details: string | null;      // JSON TEXT
}

function parseDetails(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

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

function getBadge(action_type: string, action?: string | null): BadgeCfg {
  switch (action_type) {
    case 'page_compiled':
      return action === 'update'
        ? { ...NEUT,  label: 'UPDATED'    }
        : { ...MINT,  label: 'CREATED'    };
    case 'extraction_complete':        return { ...MINT, label: 'EXTRACTED'  };
    case 'resolution_complete':        return { ...MINT, label: 'RESOLVED'   };
    case 'source_compiled':            return { ...NEUT, label: 'COMPILED'   };
    case 'ingest_accepted':            return { ...DIM,  label: 'QUEUED'     };
    case 'source_stored':              return { ...DIM,  label: 'INDEXED'    };
    case 'draft_approved':             return { ...MINT, label: 'APPROVED'   };
    case 'lint_complete':              return { ...NEUT, label: 'LINT'       };
    case 'onboarding_confirmed':       return { ...DIM,  label: 'ONBOARDING' };
    case 'source_archived':            return { ...DIM,  label: 'ARCHIVED'   };
    case 'source_unarchived':          return { ...DIM,  label: 'RESTORED'   };
    case 'source_deleted':             return { ...RED,  label: 'DELETED'    };
    case 'page_archived':              return { ...DIM,  label: 'ARCHIVED'   };
    case 'page_deleted':               return { ...RED,  label: 'PAGE DEL'   };
    case 'page_recompiled':            return { ...NEUT, label: 'RECOMPILED' };
    case 'page_provenance_updated':    return { ...DIM,  label: 'NOTED'      };
    case 'page_recompile_failed':      return { ...RED,  label: 'FAILED'     };
    case 'source_recompile_triggered': return { ...DIM,  label: 'RETRYING'   };
    case 'wiki_imported':              return { ...MINT, label: 'IMPORTED'   };
    case 'compile_cancelled':          return { ...DIM,  label: 'CANCELLED'  };
    case 'pending_drafts_cleaned':     return { ...DIM,  label: 'CLEANED'    };
    case 'digest_sent':                return { ...NEUT, label: 'DIGEST'     };
    case 'draft_too_thin':             return { ...DIM,  label: 'TOO THIN'   };
    case 'draft_queued_for_approval':  return { ...DIM,  label: 'QUEUED'     };
    case 'draft_rejected':
      return { ...RED, label: 'REJECTED' };
    case 'ingest_failed':
    case 'compile_trigger_failed':
    case 'compile_failed':
    case 'extraction_failed':
    case 'entity_expansion_failed':
    case 'digest_failed':
    case 'lint_failed':
      return { ...RED, label: 'FAILED' };
    default:
      return { ...DIM, label: action_type.replace(/_/g, ' ').toUpperCase().slice(0, 12) };
  }
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

// ── Retry button ──────────────────────────────────────────────────────────────

const RETRIABLE_TYPES = new Set([
  'compile_failed',
  'extraction_failed',
  'ingest_failed',
  'compile_trigger_failed',
]);

function RetryButton({ sourceId }: { sourceId: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');

  const handleRetry = useCallback(async () => {
    setState('loading');
    try {
      const res = await fetch(`/api/sources/${sourceId}/recompile`, { method: 'POST' });
      if (!res.ok && res.status !== 409) throw new Error(`${res.status}`);
      const body = (await res.json()) as { session_id?: string | null };
      if (body.session_id) {
        localStorage.setItem('kompl_active_compile', JSON.stringify({ session_id: body.session_id, source_count: 0 }));
      }
      setState('done');
    } catch {
      setState('error');
      setTimeout(() => setState('idle'), 3000);
    }
  }, [sourceId]);

  const base: React.CSSProperties = {
    fontFamily: 'var(--font-body)',
    fontWeight: 700,
    fontSize: 10,
    letterSpacing: '1px',
    textTransform: 'uppercase',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    padding: 0,
    transition: 'var(--transition-fast)',
  };

  if (state === 'done') {
    return <span style={{ ...base, color: 'var(--accent)', cursor: 'default' }}>QUEUED</span>;
  }
  if (state === 'error') {
    return <span style={{ ...base, color: 'var(--danger)', cursor: 'default' }}>ERR</span>;
  }
  return (
    <button
      onClick={handleRetry}
      disabled={state === 'loading'}
      style={{ ...base, color: state === 'loading' ? 'var(--fg-dim)' : 'var(--danger)', opacity: state === 'loading' ? 0.5 : 1 }}
    >
      {state === 'loading' ? '…' : '↻'}
    </button>
  );
}

// ── Row content helpers ───────────────────────────────────────────────────────

interface RowContent {
  primary: React.ReactNode;    // bold title line
  secondary: React.ReactNode;  // dim context line (or null)
  action: React.ReactNode;     // "View" link, RetryButton, or null
  isError: boolean;
}

function getRowContent(ev: ActivityRow): RowContent {
  const d = parseDetails(ev.details);
  const str = (k: string): string | null =>
    d && typeof d[k] === 'string' ? (d[k] as string) : null;
  const num = (k: string): number | null =>
    d && typeof d[k] === 'number' ? (d[k] as number) : null;

  const detailTitle  = str('title');
  const page_id      = str('page_id');
  const source_id    = ev.source_id;
  // Use server-joined source_title first, then detail-embedded, then ID fallback
  const resolvedSourceTitle = ev.source_title ?? str('source_title');

  const linkStyle = { color: 'inherit', textDecoration: 'none' };

  switch (ev.action_type) {

    case 'ingest_accepted':
    case 'ingest_complete':
    case 'source_stored':
    case 'source_compiled': {
      const name = resolvedSourceTitle ?? detailTitle ?? source_id?.slice(0, 8) ?? '…';
      const primary = source_id
        ? <Link href={`/source/${source_id}`} style={linkStyle}><strong>{name}</strong></Link>
        : <strong>{name}</strong>;
      const action = source_id
        ? <Link href={`/source/${source_id}`} style={{ ...linkStyle, color: 'var(--fg-dim)' }}>View</Link>
        : null;
      return { primary, secondary: null, action, isError: false };
    }

    case 'page_compiled': {
      const action_str = str('action') === 'update' ? 'updated' : 'created';
      const pageName = detailTitle ?? page_id ?? '…';
      const primary = (page_id)
        ? <Link href={`/wiki/${page_id}`} style={linkStyle}><strong>{pageName}</strong></Link>
        : <strong>{pageName}</strong>;
      const secondary = resolvedSourceTitle
        ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)' }}>
            {action_str} from{' '}
            {source_id
              ? <Link href={`/source/${source_id}`} style={linkStyle}>{resolvedSourceTitle}</Link>
              : resolvedSourceTitle}
          </span>
        : null;
      const action = page_id
        ? <Link href={`/wiki/${page_id}`} style={{ ...linkStyle, color: 'var(--fg-dim)' }}>View</Link>
        : null;
      return { primary, secondary, action, isError: false };
    }

    case 'extraction_complete': {
      const entities = num('entity_count')  ?? 0;
      const concepts = num('concept_count') ?? 0;
      const claims   = num('claim_count')   ?? 0;
      const name     = resolvedSourceTitle ?? detailTitle ?? source_id?.slice(0, 8) ?? '…';
      const primary  = <strong>{entities} entities · {concepts} concepts · {claims} claims</strong>;
      const secondary = <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)' }}>
        from {source_id
          ? <Link href={`/source/${source_id}`} style={{ color: 'inherit', textDecoration: 'none' }}>{name}</Link>
          : name}
      </span>;
      return { primary, secondary, action: null, isError: false };
    }

    case 'resolution_complete': {
      const merged   = num('merged_count')   ?? 0;
      const resolved = num('resolved_count') ?? 0;
      const primary  = <strong>{merged} entities merged → {resolved} canonical</strong>;
      return { primary, secondary: null, action: null, isError: false };
    }

    case 'ingest_failed':
    case 'compile_trigger_failed':
    case 'compile_failed':
    case 'extraction_failed':
    case 'entity_expansion_failed': {
      const name = resolvedSourceTitle ?? detailTitle ?? source_id?.slice(0, 8) ?? '…';
      const primary = source_id
        ? <Link href={`/source/${source_id}`} style={{ color: 'inherit', textDecoration: 'none' }}><strong>{name}</strong></Link>
        : <strong>{name}</strong>;
      const secondary = str('error')
        ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{str('error')}</span>
        : null;
      // Retry button replaces View link for retriable failures with a source_id
      const action = source_id && RETRIABLE_TYPES.has(ev.action_type)
        ? <RetryButton sourceId={source_id} />
        : source_id
          ? <Link href={`/source/${source_id}`} style={{ color: 'var(--danger)', textDecoration: 'none', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 10, letterSpacing: '1px', textTransform: 'uppercase' }}>View</Link>
          : null;
      return { primary, secondary, action, isError: true };
    }

    case 'source_recompile_triggered': {
      const name = resolvedSourceTitle ?? detailTitle ?? source_id?.slice(0, 8) ?? '…';
      const primary = source_id
        ? <Link href={`/source/${source_id}`} style={linkStyle}><strong>{name}</strong></Link>
        : <strong>{name}</strong>;
      const secondary = <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)' }}>recompile triggered</span>;
      const action = source_id
        ? <Link href={`/source/${source_id}`} style={{ ...linkStyle, color: 'var(--fg-dim)' }}>View</Link>
        : null;
      return { primary, secondary, action, isError: false };
    }

    case 'draft_approved':
    case 'draft_rejected': {
      const primary = <strong>{detailTitle ?? '…'}</strong>;
      return { primary, secondary: null, action: null, isError: ev.action_type === 'draft_rejected' };
    }

    case 'source_archived':
    case 'source_unarchived':
    case 'source_deleted': {
      const name = resolvedSourceTitle ?? detailTitle ?? source_id?.slice(0, 8) ?? '…';
      return { primary: <strong>{name}</strong>, secondary: null, action: null, isError: ev.action_type === 'source_deleted' };
    }

    case 'page_archived': {
      const pageName = detailTitle ?? page_id ?? '…';
      const primary = page_id
        ? <Link href={`/wiki/${page_id}`} style={linkStyle}><strong>{pageName}</strong></Link>
        : <strong>{pageName}</strong>;
      return { primary, secondary: null, action: null, isError: false };
    }

    case 'page_deleted': {
      const pageName = detailTitle ?? page_id ?? '…';
      const reason = str('reason');
      const reasonText = reason === 'no_remaining_sources'
        ? 'no sources remained'
        : reason === 'sole_remaining_source'
          ? 'sole source deleted'
          : null;
      const secondary = reasonText
        ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)' }}>{reasonText}</span>
        : null;
      return { primary: <strong>{pageName}</strong>, secondary, action: null, isError: true };
    }

    case 'page_recompiled': {
      const pageName = detailTitle ?? page_id ?? '…';
      const primary = page_id
        ? <Link href={`/wiki/${page_id}`} style={linkStyle}><strong>{pageName}</strong></Link>
        : <strong>{pageName}</strong>;
      const secondary = <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)' }}>rewritten after source removed</span>;
      const action = page_id
        ? <Link href={`/wiki/${page_id}`} style={{ ...linkStyle, color: 'var(--fg-dim)' }}>View</Link>
        : null;
      return { primary, secondary, action, isError: false };
    }

    case 'page_provenance_updated': {
      const pageName = detailTitle ?? page_id ?? '…';
      const primary = page_id
        ? <Link href={`/wiki/${page_id}`} style={linkStyle}><strong>{pageName}</strong></Link>
        : <strong>{pageName}</strong>;
      const secondary = <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)' }}>provenance note added</span>;
      const action = page_id
        ? <Link href={`/wiki/${page_id}`} style={{ ...linkStyle, color: 'var(--fg-dim)' }}>View</Link>
        : null;
      return { primary, secondary, action, isError: false };
    }

    case 'page_recompile_failed': {
      const pageName = detailTitle ?? page_id ?? '…';
      const primary = page_id
        ? <Link href={`/wiki/${page_id}`} style={linkStyle}><strong>{pageName}</strong></Link>
        : <strong>{pageName}</strong>;
      const errorMsg = str('error');
      const secondary = errorMsg
        ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{errorMsg}</span>
        : null;
      const action = page_id
        ? <Link href={`/wiki/${page_id}`} style={{ ...linkStyle, color: 'var(--danger)' }}>View</Link>
        : null;
      return { primary, secondary, action, isError: true };
    }

    case 'lint_complete': {
      const d = parseDetails(ev.details);
      const orphans = d && typeof d['orphan_pages'] === 'number' ? d['orphan_pages'] as number : null;
      const stale = d && typeof d['stale_pages'] === 'number' ? d['stale_pages'] as number : null;
      const crossRefs = d && Array.isArray(d['missing_cross_refs']) ? (d['missing_cross_refs'] as unknown[]).length : null;
      const contradictions = d && typeof d['contradiction_count'] === 'number' ? d['contradiction_count'] as number : null;
      const hasCounts = orphans !== null || stale !== null || crossRefs !== null;
      const secondary = hasCounts
        ? (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-dim)' }}>
            {[
              orphans !== null && `${orphans} orphan${orphans !== 1 ? 's' : ''}`,
              stale !== null && `${stale} stale`,
              crossRefs !== null && `${crossRefs} cross-ref${crossRefs !== 1 ? 's' : ''}`,
              contradictions !== null && `${contradictions} contradiction${contradictions !== 1 ? 's' : ''}`,
            ].filter(Boolean).join(' · ')}
          </span>
        )
        : null;
      return { primary: <>Wiki lint pass</>, secondary, action: null, isError: false };
    }

    case 'onboarding_confirmed':
      return { primary: <>Onboarding completed</>, secondary: null, action: null, isError: false };

    case 'wiki_imported': {
      const sources = num('source_count');
      const pages = num('page_count');
      const parts = [
        sources !== null && `${sources} source${sources !== 1 ? 's' : ''}`,
        pages !== null && `${pages} page${pages !== 1 ? 's' : ''}`,
      ].filter(Boolean);
      const secondary = parts.length > 0
        ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)' }}>{parts.join(' · ')}</span>
        : null;
      return { primary: <>Wiki imported</>, secondary, action: null, isError: false };
    }

    case 'compile_cancelled': {
      const step = str('current_step');
      const secondary = <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)' }}>
        {step ? `at step: ${step}` : 'before first step'}
      </span>;
      return { primary: <>Compile cancelled</>, secondary, action: null, isError: false };
    }

    case 'pending_drafts_cleaned': {
      const name = resolvedSourceTitle ?? detailTitle ?? source_id?.slice(0, 8) ?? '…';
      const rewritten = num('rewritten') ?? 0;
      const deleted = num('deleted') ?? 0;
      const secondary = <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)' }}>
        pending drafts: {rewritten} rewritten · {deleted} dropped
      </span>;
      return { primary: <strong>{name}</strong>, secondary, action: null, isError: false };
    }

    case 'digest_sent': {
      const channel = str('channel');
      const sources = num('sources_ingested');
      const pages = num('pages_created');
      const parts = [
        channel,
        sources !== null && `${sources} source${sources !== 1 ? 's' : ''}`,
        pages !== null && `${pages} page${pages !== 1 ? 's' : ''}`,
      ].filter(Boolean);
      const secondary = parts.length > 0
        ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)' }}>{parts.join(' · ')}</span>
        : null;
      return { primary: <>Weekly digest sent</>, secondary, action: null, isError: false };
    }

    case 'digest_failed':
    case 'lint_failed': {
      const label = ev.action_type === 'digest_failed' ? 'Weekly digest failed' : 'Wiki lint failed';
      const err = str('error');
      const secondary = err
        ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{err}</span>
        : null;
      return { primary: <>{label}</>, secondary, action: null, isError: true };
    }

    case 'draft_too_thin': {
      const name = detailTitle ?? '…';
      const chars = num('chars');
      const threshold = num('threshold');
      const secondary = (chars !== null && threshold !== null)
        ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)' }}>
            {chars} chars · threshold {threshold}
          </span>
        : null;
      return { primary: <strong>{name}</strong>, secondary, action: null, isError: false };
    }

    case 'draft_queued_for_approval': {
      const name = detailTitle ?? '…';
      const pageType = str('page_type');
      const secondary = <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)' }}>
        queued for approval{pageType ? ` · ${pageType}` : ''}
      </span>;
      return { primary: <strong>{name}</strong>, secondary, action: null, isError: false };
    }

    default:
      return {
        primary: <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-dim)' }}>{ev.action_type}</span>,
        secondary: null,
        action: null,
        isError: false,
      };
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface ActivityTableProps {
  pollInterval?: number;
}

const MAX_EVENTS = 200;
const COL = '120px 1fr 110px 60px';

export function ActivityTable({ pollInterval = 2000 }: ActivityTableProps) {
  const [events, setEvents] = useState<ActivityRow[]>([]);
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
            const d = parseDetails(ev.details);
            const action = d && typeof d['action'] === 'string' ? d['action'] as string : null;
            const badge = getBadge(ev.action_type, action);
            const { primary, secondary, action: rawAction, isError } = getRowContent(ev);

            const isLatestForSource = !ev.source_id || newestIdBySource.get(ev.source_id) === ev.id;
            const actionNode = (!isLatestForSource && RETRIABLE_TYPES.has(ev.action_type))
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
