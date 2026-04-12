'use client';

/**
 * DashboardClient — returning-user dashboard rendered by the root page.
 *
 * Sections:
 *   1. ActiveCompileBanner: shown when a compile session is running (reads localStorage)
 *   2. Header: "Kompl" + "View Wiki →"
 *   3. Quick Actions: "+ Add Sources" and "Browse Wiki →"
 *   4. Recent Activity: last 50 items via ActivityTable
 *   5. Pending Drafts: placeholder (wired in Part 2c)
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, BookOpen, MessageSquare, AlertTriangle } from 'lucide-react';

// ── Active compile banner constants ────────────────────────────────────────
const LS_KEY = 'kompl_active_compile';
const BANNER_POLL_MS = 3000;

const STEP_LABELS: Record<string, string> = {
  extract:  'Extracting knowledge',
  resolve:  'Resolving entities',
  match:    'Checking existing wiki',
  plan:     'Planning wiki structure',
  draft:    'Writing pages',
  crossref: 'Cross-referencing',
  commit:   'Finalizing',
  schema:   'Setting up wiki structure',
};
const STEP_KEYS = ['extract', 'resolve', 'match', 'plan', 'draft', 'crossref', 'commit', 'schema'];

interface ActiveCompileInfo {
  session_id: string;
  source_count: number;
}

interface ProgressResponse {
  status: string;
  current_step: string | null;
}

function ActiveCompileBanner() {
  const [info, setInfo] = useState<ActiveCompileInfo | null>(null);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }

  async function poll(sessionId: string) {
    try {
      const res = await fetch(`/api/compile/progress?session_id=${encodeURIComponent(sessionId)}`);
      if (!res.ok) {
        localStorage.removeItem(LS_KEY);
        setInfo(null);
        stopPolling();
        return;
      }
      const data = await res.json() as ProgressResponse;
      if (data.status !== 'running') {
        localStorage.removeItem(LS_KEY);
        setInfo(null);
        stopPolling();
        return;
      }
      setCurrentStep(data.current_step);
    } catch {
      // silent
    }
  }

  useEffect(() => {
    let stored: ActiveCompileInfo | null = null;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) stored = JSON.parse(raw) as ActiveCompileInfo;
    } catch {
      localStorage.removeItem(LS_KEY);
    }

    if (!stored) return;

    setInfo(stored);

    // Immediate check, then poll every 3s
    void poll(stored.session_id);
    intervalRef.current = setInterval(() => void poll(stored.session_id), BANNER_POLL_MS);

    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!info) return null;

  const stepIndex = currentStep ? Math.max(1, STEP_KEYS.indexOf(currentStep) + 1) : 1;
  const stepLabel = currentStep ? (STEP_LABELS[currentStep] ?? currentStep) : null;
  const sc = info.source_count;

  return (
    <div
      style={{
        background: 'var(--bg-card)',
        borderLeft: '2px solid var(--accent)',
        padding: '12px 20px',
        marginBottom: 24,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
      }}
    >
      <span style={{ fontSize: 13, color: 'var(--fg-secondary)' }}>
        ⏳ {sc > 0 ? `Compiling ${sc} source${sc !== 1 ? 's' : ''}` : 'Compiling'}…
        {stepLabel && (
          <span style={{ color: 'var(--fg-muted)', marginLeft: 8 }}>
            (Step {stepIndex}/{STEP_KEYS.length}: {stepLabel})
          </span>
        )}
      </span>
      <Link
        href={`/onboarding/progress?session_id=${encodeURIComponent(info.session_id)}&queued=${sc}`}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.7rem',
          color: 'var(--accent)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          whiteSpace: 'nowrap',
        }}
      >
        View progress →
      </Link>
    </div>
  );
}

// ── Process queue ──────────────────────────────────────────────────────────

interface SourceQueueRow {
  source_id: string;
  title: string;
  source_type: string;
  date_ingested: string;
  compile_status: string;
}

const GREEN_DOT = <div style={{ width: 9, height: 9, borderRadius: '50%', background: 'rgba(137,240,203,0.5)', flexShrink: 0 }} />;
const DIM_DOT   = <div style={{ width: 9, height: 9, borderRadius: '50%', background: '#47484A',               flexShrink: 0 }} />;

function getStatusCfg(status: string) {
  switch (status) {
    case 'active':      // legacy corrupt value — treat as compiled
    case 'compiled':
    case 'extracted':
    case 'in_progress':
      return { border: 'rgba(137,240,203,0.4)', icon: GREEN_DOT, fillColor: 'rgba(137,240,203,0.3)', progress: 100, dim: false };
    case 'failed':
      return { border: 'rgba(255,113,108,0.4)', icon: <AlertTriangle size={13} style={{ color: 'var(--danger)' }} />, fillColor: 'var(--danger)', progress: 100, dim: false };
    default:
      return { border: 'rgba(137,240,203,0.15)', icon: DIM_DOT, fillColor: '#47484A', progress: 100, dim: true };
  }
}

const QUEUE_POLL_MS = 5000;

function ProcessQueue() {
  const [sources, setSources] = useState<SourceQueueRow[]>([]);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());

  const fetchSources = useCallback(() => {
    void fetch('/api/sources?limit=4&sort_by=date_ingested&sort_order=desc')
      .then(r => r.json())
      .then((data: { sources: SourceQueueRow[] }) => setSources((data.sources ?? []).slice(0, 4)));
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

  if (sources.length === 0) {
    return <p style={{ color: 'var(--fg-muted)', fontSize: '0.9rem', margin: 0 }}>No sources yet.</p>;
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
      {sources.map((s) => {
        const cfg = getStatusCfg(s.compile_status);
        const [datePart] = s.date_ingested.split(' ');
        const [, month, day] = datePart.split('-');
        const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
        const ts = `${MONTHS[parseInt(month, 10) - 1]} ${parseInt(day, 10)}`;
        const isFailed = s.compile_status === 'failed';
        const isRetrying = retrying.has(s.source_id);
        return (
          <div
            key={s.source_id}
            style={{
              background: 'var(--bg-card)',
              borderLeft: `2px solid ${cfg.border}`,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              opacity: cfg.dim ? 0.5 : 1,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
                {ts}
              </span>
              {cfg.icon}
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 14, lineHeight: '20px', color: 'var(--fg-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.title}
            </div>
            <div style={{ height: 4, background: '#242629', position: 'relative' }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${cfg.progress}%`, background: cfg.fillColor }} />
            </div>
            {isFailed && (
              <button
                onClick={() => void handleRetry(s.source_id)}
                disabled={isRetrying}
                style={{
                  marginTop: 2,
                  background: 'transparent',
                  border: '1px solid rgba(255,113,108,0.3)',
                  color: isRetrying ? 'var(--fg-dim)' : 'var(--danger)',
                  fontFamily: 'var(--font-body)',
                  fontWeight: 700,
                  fontSize: 9,
                  letterSpacing: '0.8px',
                  textTransform: 'uppercase',
                  padding: '4px 8px',
                  cursor: isRetrying ? 'default' : 'pointer',
                  transition: 'var(--transition-fast)',
                  opacity: isRetrying ? 0.5 : 1,
                }}
              >
                {isRetrying ? 'Queuing…' : '↻ Retry'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Pending drafts ─────────────────────────────────────────────────────────

interface DraftRow {
  plan_id: string;
  title: string;
  page_type: string;
  action: string;
  session_id: string;
  draft_content_preview: string | null;
  draft_content: string | null;
  created_at: string;
}

function PendingDrafts() {
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpand(planId: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(planId)) next.delete(planId); else next.add(planId);
      return next;
    });
  }

  useEffect(() => {
    void fetch('/api/drafts/pending')
      .then((r) => r.json())
      .then((data: { drafts: DraftRow[] }) => setDrafts(data.drafts));
  }, []);

  async function approve(planId: string) {
    setBusy(planId);
    await fetch(`/api/drafts/${planId}/approve`, { method: 'POST' });
    setDrafts((prev) => prev.filter((d) => d.plan_id !== planId));
    setBusy(null);
  }

  async function reject(planId: string) {
    setBusy(planId);
    await fetch(`/api/drafts/${planId}/reject`, { method: 'POST' });
    setDrafts((prev) => prev.filter((d) => d.plan_id !== planId));
    setBusy(null);
  }

  if (drafts.length === 0) {
    return (
      <p style={{ color: 'var(--fg-muted)', fontSize: '0.9rem', margin: 0 }}>
        No pending drafts.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {drafts.map((d) => (
        <div
          key={d.plan_id}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '0.9rem 1.1rem',
            background: 'var(--bg-card)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: '0.9rem', marginBottom: '0.25rem' }}>{d.title}</div>
              <div className="meta">
                {d.page_type}
                {d.action !== 'create' ? ` · ${d.action}` : ''}
                {d.session_id.startsWith('chat-') ? ' · from chat' : ''}
              </div>
              {d.draft_content_preview && !expanded.has(d.plan_id) && (
                <div
                  style={{
                    marginTop: '0.4rem',
                    fontSize: 12,
                    color: 'var(--fg-dim)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {d.draft_content_preview}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
              {d.draft_content && (
                <button
                  onClick={() => toggleExpand(d.plan_id)}
                  style={{
                    padding: '0.35rem 0.8rem',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: 'transparent',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    color: 'var(--fg-muted)',
                  }}
                >
                  {expanded.has(d.plan_id) ? '▲ Hide' : '▼ Preview'}
                </button>
              )}
              <button
                onClick={() => void approve(d.plan_id)}
                disabled={busy === d.plan_id}
                style={{
                  padding: '0.35rem 0.8rem',
                  borderRadius: 6,
                  border: 'none',
                  background: 'var(--success, #059669)',
                  color: '#fff',
                  cursor: busy === d.plan_id ? 'not-allowed' : 'pointer',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                }}
              >
                ✓ Approve
              </button>
              <button
                onClick={() => void reject(d.plan_id)}
                disabled={busy === d.plan_id}
                style={{
                  padding: '0.35rem 0.8rem',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  cursor: busy === d.plan_id ? 'not-allowed' : 'pointer',
                  fontSize: '0.8rem',
                  color: 'var(--fg-muted)',
                }}
              >
                ✗ Reject
              </button>
            </div>
          </div>
          {expanded.has(d.plan_id) && d.draft_content && (
            <div
              style={{
                marginTop: '0.75rem',
                paddingTop: '0.75rem',
                borderTop: '1px solid var(--border)',
                fontSize: '0.85rem',
                lineHeight: 1.6,
                color: 'var(--fg)',
                whiteSpace: 'pre-wrap',
                fontFamily: 'var(--font-mono, monospace)',
                maxHeight: 400,
                overflowY: 'auto',
              }}
            >
              {d.draft_content}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Root export ────────────────────────────────────────────────────────────

export default function DashboardClient() {
  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '1.5rem 40px 5rem' }}>

      {/* Active compile banner — only rendered when localStorage has a running session */}
      <ActiveCompileBanner />

      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section
        style={{
          position: 'relative',
          background: 'var(--bg-card)',
          padding: 48,
          overflow: 'hidden',
          isolation: 'isolate',
          marginBottom: 48,
        }}
      >
        {/* Decorative gradient */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(180deg, rgba(152,255,217,0) 50%, rgba(152,255,217,0.05) 50%)',
            opacity: 0.2,
            zIndex: 0,
            pointerEvents: 'none',
          }}
        />

        {/* Two-column layout */}
        <div
          style={{
            position: 'relative',
            zIndex: 1,
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'flex-start',
            minHeight: 264,
          }}
        >
          {/* Left — identity */}
          <div
            style={{
              flex: '0 0 50%',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              paddingRight: 32,
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-body)',
                fontSize: 10.4,
                letterSpacing: '1.04px',
                textTransform: 'uppercase',
                color: 'var(--accent)',
                lineHeight: '16px',
              }}
            >
              Knowledge Compiler
            </span>
            <h1
              style={{
                fontFamily: 'var(--font-heading)',
                fontSize: 72,
                fontWeight: 700,
                lineHeight: '72px',
                letterSpacing: '-3.6px',
                color: 'var(--fg)',
                margin: 0,
              }}
            >
              RE_INITIALIZED_
            </h1>
            <p
              style={{
                fontFamily: 'var(--font-heading)',
                fontSize: 16,
                fontWeight: 400,
                lineHeight: '26px',
                color: 'var(--fg-muted)',
                margin: 0,
                paddingTop: 16,
                maxWidth: 384,
              }}
            >
              Your knowledge archive is live. Sources compile automatically into a self-organizing wiki.
            </p>
          </div>

          {/* Right — action buttons */}
          <div
            style={{
              flex: '0 0 50%',
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              alignSelf: 'stretch',
            }}
          >
            {/* Primary — Add Sources */}
            <Link
              href="/onboarding?mode=add"
              style={{
                display: 'flex',
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: 24,
                background: 'var(--accent)',
                textDecoration: 'none',
                flex: 1,
              }}
            >
              <span style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 700, color: 'var(--accent-text)' }}>
                Add Sources
              </span>
              <Upload size={17} style={{ color: '#00291D', flexShrink: 0 }} />
            </Link>

            {/* Secondary — Browse Wiki */}
            <Link
              href="/wiki"
              style={{
                display: 'flex',
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: 24,
                background: 'var(--bg-card-hover)',
                border: '1px solid rgba(39,39,42,0.3)',
                textDecoration: 'none',
                flex: 1,
              }}
            >
              <span style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 400, color: 'var(--fg)' }}>
                Browse Wiki
              </span>
              <BookOpen size={18} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            </Link>

            {/* Secondary — Open Chat */}
            <Link
              href="/chat"
              style={{
                display: 'flex',
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: 24,
                background: 'var(--bg-card-hover)',
                border: '1px solid rgba(39,39,42,0.3)',
                textDecoration: 'none',
                flex: 1,
              }}
            >
              <span style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 400, color: 'var(--fg)' }}>
                Open Chat
              </span>
              <MessageSquare size={21} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            </Link>
          </div>
        </div>
      </section>

      {/* Processing Queue */}
      <section style={{ marginBottom: '3rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
          <h2
            style={{
              fontFamily: 'var(--font-heading)',
              fontWeight: 700,
              fontSize: 18,
              letterSpacing: '1.8px',
              textTransform: 'uppercase',
              color: 'var(--fg-secondary)',
              margin: 0,
              whiteSpace: 'nowrap',
            }}
          >
            Recently Processed
          </h2>
          <div style={{ flex: 1, height: 1, background: 'rgba(71,72,74,0.3)' }} />
          <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center' }}>
            <Link href="/sources" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              View all sources →
            </Link>
            <Link href="/feed" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              View all activity →
            </Link>
          </div>
        </div>
        <ProcessQueue />
      </section>

      {/* Pending Drafts */}
      <section>
        <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.75rem' }}>
          Pending Drafts
        </h2>
        <PendingDrafts />
      </section>

    </main>
  );
}
