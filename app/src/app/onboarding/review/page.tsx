'use client';

/**
 * /onboarding/review — Pre-ingestion review of staged sources (v18).
 *
 * Reads GET /api/onboarding/staging?session_id=X — returns rows from the
 * collect_staging table grouped by connector. Renders them as visual
 * groups (URLs vs Bookmarks split even though both are connector='url')
 * with per-connector "Add more" links back to /onboarding/[connector]?resume=1.
 *
 * Unchecking → PATCH /api/onboarding/staging/[stage_id] with {included: false}.
 * State is server-durable so refreshes preserve it.
 *
 * "Build my wiki" → POST /api/onboarding/finalize → /onboarding/progress
 *   (finalize also accepts status='ingested' rows — the v18 migration
 *   lifts legacy compile_status='collected' sources into staging with
 *   resolved_source_id set, and they queue through the pipeline normally).
 *
 * Top-right "Discard session" → DELETE /api/onboarding/session
 *   (cancels any in-flight compile, unlinks staged upload files, clears
 *   staging rows + compile_progress). Two-click inline confirm with a
 *   3-second revert — no modal in v2 (Slice 5 polish).
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { useToast } from '../../../components/Toast';
import { toUserMessage } from '@/lib/service-errors';
import type { StagingRow } from '@/lib/db';
import {
  VISUAL_GROUP_ORDER,
  VISUAL_GROUP_LABELS,
  VISUAL_GROUP_CONNECTOR_SLUG,
  emptyGroups,
  groupStagingRows,
  formatBytes,
  formatRelativeMtime,
  formatDate,
  type GroupedStaging,
  type TypedStagingRow,
  type VisualGroup,
} from './grouping';

// ── Server response shape ─────────────────────────────────────────────────

interface StagingResponse {
  session_id: string;
  groups: Record<string, StagingRow[]>;
  totals: {
    total: number;
    included: number;
    by_connector: Record<string, number>;
  };
}

// Rows render folded past this threshold to keep long imports (200-item
// bookmark exports) from burying the Build button below 4 screens of scroll.
const FOLD_AFTER = 10;

// ── Page ──────────────────────────────────────────────────────────────────

function ReviewPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast, showToast } = useToast();

  const urlSessionId = searchParams.get('session_id') ?? '';
  const [sessionId, setSessionId] = useState('');
  const [groups, setGroups] = useState<GroupedStaging>(emptyGroups());
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<VisualGroup>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [discardState, setDiscardState] = useState<'idle' | 'confirming' | 'deleting'>('idle');

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? sessionStorage.getItem('kompl_session_id') : null;
    setSessionId(stored ?? urlSessionId);
  }, [urlSessionId]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/onboarding/staging?session_id=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json().then((body) => ({ ok: r.ok, body: body as StagingResponse & { error?: string } })))
      .then(({ ok, body }) => {
        if (cancelled) return;
        if (!ok) {
          setError(body.error ?? 'Failed to load staged sources');
          return;
        }
        // Flatten server groups (keyed on connector) into a flat row list,
        // then re-group for the review UI (keyed on visual group).
        const flat: StagingRow[] = [];
        for (const arr of Object.values(body.groups)) flat.push(...arr);
        const grouped = groupStagingRows(flat);
        setGroups(grouped);
        const initialIncluded: Record<string, boolean> = {};
        for (const arr of Object.values(grouped)) {
          for (const row of arr) initialIncluded[row.stage_id] = row.included;
        }
        setIncluded(initialIncluded);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Network error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId]);

  // Optimistic toggle + fire-and-forget PATCH. On PATCH failure, revert
  // local state and show a toast — the server is authoritative.
  async function handleToggle(stageId: string, next: boolean) {
    setIncluded((prev) => ({ ...prev, [stageId]: next }));
    try {
      const res = await fetch(`/api/onboarding/staging/${encodeURIComponent(stageId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ included: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; error_code?: string };
        setIncluded((prev) => ({ ...prev, [stageId]: !next }));
        showToast(toUserMessage(body.error_code ?? 'stage_insert_failed'), 'error');
      }
    } catch {
      setIncluded((prev) => ({ ...prev, [stageId]: !next }));
      showToast('Network error — selection not saved', 'error');
    }
  }

  async function handleGroupBulk(group: VisualGroup, next: boolean) {
    const rows = groups[group];
    for (const row of rows) {
      if (included[row.stage_id] !== next) {
        void handleToggle(row.stage_id, next);
      }
    }
  }

  async function handleFinalize() {
    if (confirming) return;
    setConfirming(true);
    try {
      const res = await fetch('/api/onboarding/finalize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      const body = (await res.json()) as {
        session_id?: string;
        queued?: number;
        error?: string;
        error_code?: string;
      };
      if (!res.ok) {
        // n8n_* errors still navigate to progress so the retry button lives there.
        if (body.error_code?.startsWith('n8n_')) {
          router.push(
            `/onboarding/progress?session_id=${encodeURIComponent(sessionId)}` +
            `&queued=${body.queued ?? 0}&n8n_error=${encodeURIComponent(body.error_code)}`
          );
          return;
        }
        showToast(toUserMessage(body.error_code ?? 'commit_failed'), 'error');
        setConfirming(false);
        return;
      }
      router.push(
        `/onboarding/progress?session_id=${encodeURIComponent(sessionId)}&queued=${body.queued ?? 0}`
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Network error', 'error');
      setConfirming(false);
    }
  }

  async function handleDiscard() {
    if (discardState === 'deleting') return;
    if (discardState === 'idle') {
      setDiscardState('confirming');
      // Auto-revert after 3s so a misclick doesn't leave the button armed.
      setTimeout(() => {
        setDiscardState((s) => (s === 'confirming' ? 'idle' : s));
      }, 3000);
      return;
    }
    // discardState === 'confirming' — second click commits.
    setDiscardState('deleting');
    try {
      const res = await fetch(
        `/api/onboarding/session?session_id=${encodeURIComponent(sessionId)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        showToast(body.error ?? 'Discard failed', 'error');
        setDiscardState('idle');
        return;
      }
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem('kompl_session_id');
        sessionStorage.removeItem('kompl_connectors');
        sessionStorage.removeItem('kompl_connector_idx');
        localStorage.removeItem('kompl_active_compile');
      }
      router.push('/');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Network error', 'error');
      setDiscardState('idle');
    }
  }

  const visibleGroups = VISUAL_GROUP_ORDER.filter((g) => groups[g].length > 0);
  const totalItems = VISUAL_GROUP_ORDER.reduce((n, g) => n + groups[g].length, 0);
  const includedCount = Object.values(included).filter(Boolean).length;
  const uncheckedCount = totalItems - includedCount;

  if (loading) {
    return (
      <main style={{ maxWidth: 1040, margin: '0 auto', padding: '1.5rem 40px 2.5rem' }}>
        <p style={{ color: 'var(--fg-muted)' }}>Loading staged sources…</p>
        {toast}
      </main>
    );
  }

  if (error) {
    return (
      <main style={{ maxWidth: 1040, margin: '0 auto', padding: '1.5rem 40px 2.5rem' }}>
        <p style={{ color: 'var(--danger)' }}>Failed to load: {error}</p>
        <Link href="/onboarding" style={{ color: 'var(--accent)' }}>← Back to onboarding</Link>
        {toast}
      </main>
    );
  }

  if (totalItems === 0) {
    return (
      <main style={{ maxWidth: 1040, margin: '0 auto', padding: '1.5rem 40px 2.5rem' }}>
        <h1 style={{ fontFamily: 'var(--font-heading)', fontSize: 28, margin: '0 0 0.5rem' }}>
          No sources staged
        </h1>
        <p style={{ color: 'var(--fg-muted)', marginBottom: '1.5rem' }}>
          You haven&apos;t added any sources yet.
        </p>
        <Link
          href={`/onboarding?session_id=${encodeURIComponent(sessionId)}`}
          style={{ color: 'var(--accent)', textDecoration: 'none' }}
        >
          ← Add sources
        </Link>
        {toast}
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '1.5rem 40px 2.5rem' }}>

      {/* Top utility bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 24,
      }}>
        <Link
          href={`/onboarding?session_id=${encodeURIComponent(sessionId)}`}
          style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '1px',
            textTransform: 'uppercase', color: 'var(--fg-dim)', textDecoration: 'none',
          }}
        >
          ← Add more sources
        </Link>
        <DiscardButton state={discardState} onClick={handleDiscard} />
      </div>

      {/* Header */}
      <h1 style={{
        fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 36,
        letterSpacing: '-1px', margin: '0 0 0.25rem',
      }}>
        Review your sources
      </h1>
      <p style={{
        fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.5px',
        textTransform: 'uppercase', color: 'var(--fg-dim)', margin: '0 0 0.5rem',
      }}>
        {totalItems} items staged · {includedCount} will be compiled
        {uncheckedCount > 0 && ` · ${uncheckedCount} unchecked`}
      </p>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 2rem' }}>
        Uncheck anything you don&apos;t want. Nothing is scraped until you click Build.
      </p>

      {/* Groups */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {visibleGroups.map((group) => (
          <GroupSection
            key={group}
            group={group}
            rows={groups[group]}
            included={included}
            sessionId={sessionId}
            expanded={expandedGroups.has(group)}
            onExpand={() => setExpandedGroups((prev) => {
              const next = new Set(prev);
              if (next.has(group)) next.delete(group); else next.add(group);
              return next;
            })}
            onToggle={handleToggle}
            onBulk={handleGroupBulk}
          />
        ))}
      </div>

      {/* Footer */}
      <div style={{
        borderTop: '1px solid var(--separator)',
        marginTop: 32, paddingTop: 24,
        display: 'flex', justifyContent: 'flex-end',
      }}>
        <button
          onClick={handleFinalize}
          disabled={confirming || includedCount === 0}
          style={{
            padding: '14px 32px',
            background: confirming || includedCount === 0 ? 'var(--bg-card)' : 'var(--accent)',
            color: confirming || includedCount === 0 ? 'var(--fg-muted)' : 'var(--accent-text)',
            border: 'none',
            cursor: confirming || includedCount === 0 ? 'not-allowed' : 'pointer',
            fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 11,
            letterSpacing: '1px', textTransform: 'uppercase',
          }}
        >
          {confirming ? 'Starting…' : `Build my wiki (${includedCount}) →`}
        </button>
      </div>

      {toast}
    </main>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function DiscardButton({
  state,
  onClick,
}: {
  state: 'idle' | 'confirming' | 'deleting';
  onClick: () => void;
}) {
  if (state === 'idle') {
    return (
      <button
        onClick={onClick}
        aria-label="Discard session"
        style={{
          background: 'none', border: '1px solid var(--separator)', cursor: 'pointer',
          padding: '6px 10px',
          fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '1px',
          textTransform: 'uppercase', color: 'var(--fg-muted)',
        }}
      >
        × Discard
      </button>
    );
  }
  if (state === 'confirming') {
    return (
      <button
        onClick={onClick}
        style={{
          background: 'var(--danger)', color: 'white', border: 'none', cursor: 'pointer',
          padding: '6px 10px',
          fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '1px',
          textTransform: 'uppercase',
        }}
      >
        Really discard? Click again
      </button>
    );
  }
  return (
    <button
      disabled
      style={{
        background: 'var(--bg-card)', border: '1px solid var(--separator)',
        cursor: 'not-allowed', padding: '6px 10px', color: 'var(--fg-muted)',
        fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '1px',
        textTransform: 'uppercase',
      }}
    >
      Discarding…
    </button>
  );
}

function GroupSection({
  group,
  rows,
  included,
  sessionId,
  expanded,
  onExpand,
  onToggle,
  onBulk,
}: {
  group: VisualGroup;
  rows: TypedStagingRow[];
  included: Record<string, boolean>;
  sessionId: string;
  expanded: boolean;
  onExpand: () => void;
  onToggle: (stageId: string, next: boolean) => void;
  onBulk: (group: VisualGroup, next: boolean) => void;
}) {
  const visibleRows = expanded ? rows : rows.slice(0, FOLD_AFTER);
  const hiddenCount = rows.length - visibleRows.length;
  const addMoreSlug = VISUAL_GROUP_CONNECTOR_SLUG[group];

  return (
    <section style={{
      border: '1px solid var(--separator)',
      background: 'var(--bg-card)',
    }}>
      {/* Section header */}
      <header style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '12px 16px',
        borderBottom: '1px solid var(--separator)',
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 11,
          letterSpacing: '1.5px', textTransform: 'uppercase', color: 'var(--accent)',
        }}>
          {VISUAL_GROUP_LABELS[group]} · {rows.length}
        </span>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button onClick={() => onBulk(group, true)} style={bulkBtnStyle}>All</button>
          <button onClick={() => onBulk(group, false)} style={bulkBtnStyle}>None</button>
        </div>
      </header>

      {/* Items */}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {visibleRows.map((row) => (
          <ItemRow
            key={row.stage_id}
            row={row}
            checked={included[row.stage_id] ?? false}
            onToggle={(next) => onToggle(row.stage_id, next)}
          />
        ))}
        {hiddenCount > 0 && (
          <li>
            <button
              onClick={onExpand}
              style={{
                width: '100%', textAlign: 'left',
                padding: '12px 16px',
                background: 'var(--bg-card-hover)',
                border: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-mono)', fontSize: 11,
                letterSpacing: '0.5px', color: 'var(--fg-muted)',
              }}
            >
              ({hiddenCount} more) ▸
            </button>
          </li>
        )}
      </ul>

      {/* Add-more link */}
      <footer style={{
        padding: '10px 16px', textAlign: 'right',
        borderTop: '1px solid var(--separator)',
      }}>
        <Link
          href={`/onboarding/${addMoreSlug}?session_id=${encodeURIComponent(sessionId)}&resume=1`}
          style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '1px',
            textTransform: 'uppercase', color: 'var(--accent)', textDecoration: 'none',
          }}
        >
          + Add more {VISUAL_GROUP_LABELS[group].toLowerCase()}
        </Link>
      </footer>
    </section>
  );
}

const bulkBtnStyle: React.CSSProperties = {
  background: 'none', border: '1px solid var(--separator)', cursor: 'pointer',
  padding: '4px 10px', color: 'var(--fg-dim)',
  fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.5px',
  textTransform: 'uppercase',
};

function ItemRow({
  row,
  checked,
  onToggle,
}: {
  row: TypedStagingRow;
  checked: boolean;
  onToggle: (next: boolean) => void;
}) {
  const d = row.display;
  const isIngested = row.status === 'ingested';
  return (
    <li style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 16px',
      borderBottom: '1px solid rgba(var(--separator-rgb), 0.4)',
      opacity: checked ? 1 : 0.5,
    }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={isIngested}
        onChange={(e) => onToggle(e.target.checked)}
        style={{ flexShrink: 0, width: 16, height: 16, cursor: isIngested ? 'not-allowed' : 'pointer' }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <ItemLabel display={d} />
        <ItemMeta display={d} />
      </div>
      {isIngested && (
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '1px',
          textTransform: 'uppercase', color: 'var(--fg-dim)',
          padding: '2px 6px', border: '1px solid var(--separator)',
        }}>
          Already ingested
        </span>
      )}
    </li>
  );
}

function ItemLabel({ display }: { display: TypedStagingRow['display'] }) {
  const base: React.CSSProperties = {
    fontFamily: 'var(--font-body)', fontSize: 14,
    color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  };
  switch (display.kind) {
    case 'url':
      if (display.source_origin === 'bookmarks' && display.title) {
        return <div style={base}>{display.title}</div>;
      }
      return <div style={{ ...base, fontFamily: 'var(--font-mono)', fontSize: 13 }}>{display.url}</div>;
    case 'file-upload':
      return <div style={{ ...base, fontFamily: 'var(--font-mono)', fontSize: 13 }}>{display.filename}</div>;
    case 'text':
      if (display.source_origin === 'twitter') {
        return <div style={base}>{display.author} · {display.excerpt}</div>;
      }
      return <div style={{ ...base, fontFamily: 'var(--font-mono)', fontSize: 13 }}>{display.filename}</div>;
    case 'saved-link':
      return <div style={{ ...base, fontFamily: 'var(--font-mono)', fontSize: 13 }}>{display.tweet_url ?? 'Saved tweet'}</div>;
    default:
      return <div style={base}>Unknown</div>;
  }
}

function ItemMeta({ display }: { display: TypedStagingRow['display'] }) {
  const meta: React.CSSProperties = {
    fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.3px',
    color: 'var(--fg-muted)', marginTop: 2,
  };
  switch (display.kind) {
    case 'url': {
      const parts: string[] = [display.hostname];
      if (display.source_origin === 'bookmarks' && display.date_saved) {
        parts.push(`saved ${formatDate(display.date_saved)}`);
      }
      if (display.source_origin === 'twitter-link' && display.linked_from_tweet) {
        parts.push('from a tweet');
      }
      return <div style={meta}>{parts.join(' · ')}</div>;
    }
    case 'file-upload':
      return (
        <div style={meta}>
          {formatBytes(display.size_bytes)} · modified {formatRelativeMtime(display.mtime_ms)}
        </div>
      );
    case 'text':
      if (display.source_origin === 'twitter') {
        const parts: string[] = [];
        if (display.date_saved) parts.push(formatDate(display.date_saved));
        if (display.linked_count > 0) parts.push(`${display.linked_count} linked article${display.linked_count === 1 ? '' : 's'}`);
        return <div style={meta}>{parts.join(' · ')}</div>;
      }
      return (
        <div style={meta}>
          {display.line_count} line{display.line_count === 1 ? '' : 's'}
          {display.excerpt && ` — "${display.excerpt}"`}
        </div>
      );
    case 'saved-link': {
      const parts: string[] = ['media-only'];
      if (display.author) parts.push(display.author);
      if (display.date_saved) parts.push(formatDate(display.date_saved));
      return <div style={meta}>{parts.join(' · ')}</div>;
    }
    default:
      return null;
  }
}

export default function ReviewPage() {
  return (
    <Suspense>
      <ReviewPageInner />
    </Suspense>
  );
}