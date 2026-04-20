'use client';

/**
 * /onboarding/progress — Compile pipeline progress screen.
 *
 * Polls GET /api/compile/progress?session_id=<id> every 2 seconds.
 * Stops polling when status === 'completed' or status === 'failed'.
 * Runs in the background — the Dashboard button is always visible so
 * users can leave and come back. A patience note appears after 15 min.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { toUserMessage } from '@/lib/service-errors';
import { COMPILE_STEPS } from '@/lib/compile-steps';

const POLL_INTERVAL_MS    = 2000;
const PATIENCE_TIMEOUT_MS = 15 * 60 * 1000;
const LS_KEY              = 'kompl_active_compile';

interface StepState {
  status: string;
  detail?: string;
}

interface ProgressResponse {
  session_id:   string;
  status:       string;
  current_step: string | null;
  steps:        Record<string, StepState>;
  error:        string | null;
  started_at:   string | null;
  completed_at: string | null;
  // Phase 4: count of collect_staging rows in 'failed' state for this
  // session. When > 0 AND status is terminal, the "Retry N failed items"
  // button is shown so the user can re-fire only those items.
  failed_stage_count?: number;
}

const STEPS = COMPILE_STEPS;

function parseCommittedCount(detail: string | undefined): { pages: number; sources: number } {
  if (!detail) return { pages: 0, sources: 0 };
  const pM = detail.match(/(\d+)\s+pages?/i);
  const sM = detail.match(/(\d+)\s+sources?/i);
  return { pages: pM ? parseInt(pM[1], 10) : 0, sources: sM ? parseInt(sM[1], 10) : 0 };
}

// ── Icon components ────────────────────────────────────────────────────────────

function IconDone() {
  return (
    <svg width="14" height="11" viewBox="0 0 14 11" fill="none">
      <path d="M1 5.5L5 9.5L13 1.5" style={{ stroke: 'var(--accent)' }} strokeWidth="1.5" strokeLinecap="square"/>
    </svg>
  );
}

function IconSpinner() {
  /* Static arc — looks like a loading indicator */
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M9 1A8 8 0 1 1 1 9"
        stroke="#005A44"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconFail() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M1 1L9 9M9 1L1 9" stroke="var(--danger)" strokeWidth="1.5" strokeLinecap="square"/>
    </svg>
  );
}

function IconPending() {
  /* Two short horizontal bars — pending / pause indicator */
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ width: 14, height: 2, background: 'var(--fg-muted)' }} />
      <div style={{ width: 14, height: 2, background: 'var(--fg-muted)' }} />
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

function ProgressPageInner() {
  const searchParams = useSearchParams();
  const router       = useRouter();

  const sessionId   = searchParams.get('session_id') ?? '';
  const sourceCount  = parseInt(searchParams.get('queued') ?? '0', 10);
  // Overestimate: ~2 min/source, minimum 2 min — always computed from URL params, never changes
  const estimateMins = sourceCount > 0 ? Math.max(2, sourceCount * 2) : null;
  // If confirm returned 503 n8n_*, review page passed the reason through.
  // UI-A pre-step row starts in danger state so the user can retry immediately.
  const n8nErrorFromUrl = searchParams.get('n8n_error');

  const [progress,        setProgress]        = useState<ProgressResponse | null>(null);
  const [retrying,        setRetrying]        = useState(false);
  const [retryingFailed,  setRetryingFailed]  = useState(false);
  const [cancelling,      setCancelling]      = useState(false);
  const [patienceVisible, setPatienceVisible] = useState(false);
  const [queuedRetry,     setQueuedRetry]     = useState(false);
  const [actionError,     setActionError]     = useState<string | null>(null);
  const [queuedStartMs,   setQueuedStartMs]   = useState<number | null>(null);
  const [elapsedSec,      setElapsedSec]      = useState(0);
  const [nowMs,           setNowMs]           = useState(() => Date.now());

  const intervalRef      = useRef<ReturnType<typeof setInterval>  | null>(null);
  const patienceTimerRef = useRef<ReturnType<typeof setTimeout>   | null>(null);
  const queuedTimerRef   = useRef<ReturnType<typeof setTimeout>   | null>(null);
  const isActiveRef      = useRef(true);

  function stopPolling() {
    if (intervalRef.current)      { clearInterval(intervalRef.current);     intervalRef.current      = null; }
    if (patienceTimerRef.current) { clearTimeout(patienceTimerRef.current); patienceTimerRef.current = null; }
    if (queuedTimerRef.current)   { clearTimeout(queuedTimerRef.current);   queuedTimerRef.current   = null; }
  }

  async function fetchProgress() {
    if (!sessionId || !isActiveRef.current) return;
    try {
      const res  = await fetch(`/api/compile/progress?session_id=${encodeURIComponent(sessionId)}`);
      if (!res.ok) return;
      const data = await res.json() as ProgressResponse;
      if (!isActiveRef.current) return;

      // Hard timeout: if still 'running' for > 30 min, the server likely restarted
      if (data.status === 'running' && data.started_at) {
        const elapsed = Date.now() - new Date(data.started_at.replace(' ', 'T') + 'Z').getTime();
        if (elapsed > 30 * 60 * 1000) {
          stopPolling();
          localStorage.removeItem(LS_KEY);
          sessionStorage.removeItem('kompl_session_id');
          sessionStorage.removeItem('kompl_connectors');
          sessionStorage.removeItem('kompl_connector_idx');
          setProgress({
            ...data,
            status: 'failed',
            error: 'Session timed out — the server may have restarted. Click Retry to rerun.',
          });
          return;
        }
      }

      setProgress(data);

      if (data.status === 'running' || data.status === 'queued') {
        localStorage.setItem(LS_KEY, JSON.stringify({ session_id: sessionId, source_count: sourceCount }));
      } else if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
        // Keep LS_KEY so the dashboard banner persists until the user dismisses it via the ✕.
        // Clear onboarding-session state only (these are step-wizard breadcrumbs, not the banner pointer).
        sessionStorage.removeItem('kompl_session_id');
        sessionStorage.removeItem('kompl_connectors');
        sessionStorage.removeItem('kompl_connector_idx');
      }

      // Arm a 60s timer the first time we see 'queued'; cancel it if pipeline starts.
      if (data.status === 'queued' && !queuedTimerRef.current) {
        queuedTimerRef.current = setTimeout(() => setQueuedRetry(true), 180_000);
      } else if (data.status !== 'queued' && queuedTimerRef.current) {
        clearTimeout(queuedTimerRef.current);
        queuedTimerRef.current = null;
      }

      if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') stopPolling();
    } catch { /* silent — keep polling */ }
  }

  useEffect(() => {
    if (!sessionId) return;
    void fetchProgress();
    intervalRef.current      = setInterval(fetchProgress, POLL_INTERVAL_MS);
    patienceTimerRef.current = setTimeout(() => setPatienceVisible(true), PATIENCE_TIMEOUT_MS);
    return () => { isActiveRef.current = false; stopPolling(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // UI-A: track elapsed seconds while status === 'queued'. Reset when we leave queued.
  const status = progress?.status ?? 'queued';
  const isQueued = status === 'queued';
  useEffect(() => {
    if (isQueued && queuedStartMs === null) setQueuedStartMs(Date.now());
    else if (!isQueued && queuedStartMs !== null) { setQueuedStartMs(null); setElapsedSec(0); }
  }, [isQueued, queuedStartMs]);
  useEffect(() => {
    if (!isQueued || queuedStartMs === null) return;
    setElapsedSec(Math.floor((Date.now() - queuedStartMs) / 1000));
    const id = setInterval(
      () => setElapsedSec(Math.floor((Date.now() - queuedStartMs) / 1000)),
      1000
    );
    return () => clearInterval(id);
  }, [isQueued, queuedStartMs]);

  // Total-runtime ticker. Ticks once a second while the session is queued or
  // running; freezes once we hit a terminal status (completed/failed/cancelled).
  // Anchored to progress.started_at so a reload mid-run shows the true elapsed,
  // and to progress.completed_at so terminal-state rendering is stable.
  const isTerminal =
    status === 'completed' || status === 'failed' || status === 'cancelled';
  useEffect(() => {
    if (isTerminal) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isTerminal]);

  async function handleRetry() {
    if (!sessionId) return;
    setRetrying(true);
    setActionError(null);
    localStorage.removeItem(LS_KEY);
    try {
      const res = await fetch('/api/compile/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setActionError(
          body.error === 'n8n_unreachable'
            ? 'Retry failed — background worker (n8n) is unreachable. Check Docker and try again.'
            : `Retry failed (${res.status}). ${body.error ?? ''}`
        );
        setRetrying(false);
        return;
      }
      isActiveRef.current = true;
      setProgress(null);
      setRetrying(false);
      setQueuedRetry(false);
      void fetchProgress();
      intervalRef.current = setInterval(fetchProgress, POLL_INTERVAL_MS);
    } catch {
      setActionError('Retry failed — network error.');
      setRetrying(false);
    }
  }

  async function handleRetryFailed() {
    if (!sessionId) return;
    setRetryingFailed(true);
    setActionError(null);
    localStorage.removeItem(LS_KEY);
    try {
      const res = await fetch('/api/compile/retry-failed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setActionError(
          body.error === 'n8n_unreachable'
            ? 'Retry failed — background worker (n8n) is unreachable. Check Docker and try again.'
            : body.error === 'pipeline_active'
              ? 'A pipeline is already running for this session — wait for it to finish.'
              : `Retry failed (${res.status}). ${body.error ?? ''}`
        );
        setRetryingFailed(false);
        return;
      }
      const body = await res.json().catch(() => ({})) as { retried?: number; status?: string };
      if (body.status === 'noop') {
        setActionError('Nothing to retry — no failed items in this session.');
        setRetryingFailed(false);
        return;
      }
      isActiveRef.current = true;
      setProgress(null);
      setRetryingFailed(false);
      setQueuedRetry(false);
      void fetchProgress();
      intervalRef.current = setInterval(fetchProgress, POLL_INTERVAL_MS);
    } catch {
      setActionError('Retry failed — network error.');
      setRetryingFailed(false);
    }
  }

  async function handleCancel() {
    if (!sessionId) return;
    setCancelling(true);
    setActionError(null);
    try {
      const res = await fetch('/api/compile/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string; message?: string };
        setActionError(
          body.error === 'commit_in_progress'
            ? (body.message ?? 'Commit is running — wait a moment and retry.')
            : `Cancel failed (${res.status}). ${body.error ?? ''}`
        );
        setCancelling(false);
        return;
      }
      setCancelling(false);
      // Polling will pick up status='cancelled' within POLL_INTERVAL_MS.
      void fetchProgress();
    } catch {
      setActionError('Cancel failed — network error.');
      setCancelling(false);
    }
  }

  // ── Derived state ────────────────────────────────────────────────────────────

  const steps          = progress?.steps  ?? {};

  const isComplete     = status === 'completed';
  const isFailedStatus = status === 'failed';
  const isCancelled    = status === 'cancelled';
  const isRunning      = status === 'running';

  // UI-A pre-step row state: neutral (0-15s), amber (15-30s), danger (>30s or n8n_error from URL).
  const forceDanger = !!n8nErrorFromUrl;
  const uiAState: 'neutral' | 'amber' | 'danger' =
    forceDanger || elapsedSec >= 30 ? 'danger' :
    elapsedSec >= 15                ? 'amber'  :
                                      'neutral';

  const { pages: committedPages, sources: committedSources } =
    parseCommittedCount(steps['commit']?.detail);

  // Step counter excludes hidden skipped steps so a text-only session's
  // counter reads 0/8 → 8/8 instead of a confusing 0/12 → 8/12 (4 prelude
  // steps get hidden on render).
  const isSkippedDone = (key: string) => {
    const s = steps[key];
    return s?.status === 'done' && s.detail?.startsWith('skipped');
  };
  const visibleSteps = STEPS.filter(s => !isSkippedDone(s.key));
  const doneCount  = visibleSteps.filter(s => steps[s.key]?.status === 'done').length;
  const totalSteps = visibleSteps.length;

  const headingText =
    isComplete     ? 'Wiki Ready.'           :
    isFailedStatus ? 'Something went wrong.' :
    isCancelled    ? 'Compile cancelled.'    :
                     'Building your wiki.';

  const statusLabel =
    isComplete     ? 'COMPLETE'  :
    isFailedStatus ? 'FAILED'    :
    isCancelled    ? 'CANCELLED' :
    isRunning      ? 'RUNNING'   :
                     'QUEUED';

  const statusColor =
    isFailedStatus ? 'var(--danger)' :
    isCancelled    ? 'var(--fg-subtle)' :
                     'var(--accent)';

  const stepCounterLabel = isComplete ? 'PAGES' : 'STEP';
  const stepCounterValue =
    isComplete ? (committedPages > 0 ? String(committedPages) : '—') :
    isRunning  ? `${doneCount} / ${totalSteps}`                      :
                 `— / ${totalSteps}`;

  // Parse server timestamp ("YYYY-MM-DD HH:MM:SS", UTC) to epoch ms.
  function parseServerTs(ts: string | null | undefined): number | null {
    if (!ts) return null;
    const n = new Date(ts.replace(' ', 'T') + 'Z').getTime();
    return Number.isFinite(n) ? n : null;
  }
  const startedAtMs   = parseServerTs(progress?.started_at);
  const completedAtMs = parseServerTs(progress?.completed_at);
  const runElapsedMs  =
    startedAtMs !== null ? (completedAtMs ?? nowMs) - startedAtMs : null;
  function formatElapsed(ms: number | null): string {
    if (ms === null || ms < 0) return '—';
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
  }

  /* Footer stats: SELECTED SOURCES + EST are fixed (from URL params, never change).
     ELAPSED ticks every second while running and freezes on terminal status.
     When complete, also show PAGES CREATED. */
  const selectedSourcesValue =
    isComplete && committedSources > 0 ? String(committedSources) :
    sourceCount > 0                    ? String(sourceCount)      :
                                         '—';
  const footerStats: { label: string; value: string }[] = [
    { label: isComplete && committedSources > 0 ? 'SOURCES COMPILED' : 'SELECTED SOURCES', value: selectedSourcesValue },
    { label: 'EST.',              value: estimateMins !== null ? `~${estimateMins} min`      : '—' },
    { label: 'ELAPSED',           value: formatElapsed(runElapsedMs) },
    ...(isComplete && committedPages > 0
      ? [{ label: 'PAGES CREATED', value: String(committedPages) }]
      : []),
  ];

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    /* Same outer shell as every other page */
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '1.5rem 40px 2.5rem' }}>

      {/* Card — centered within the shell */}
      <div style={{
        maxWidth: 1040,
        margin: '0 auto',
        background: 'var(--bg-card)',
        border: '1px solid rgba(var(--separator-rgb),0.1)',
        boxShadow: '0 0 50px rgba(var(--accent-rgb),0.03)',
        padding: 32,
        display: 'flex',
        flexDirection: 'column',
        gap: 48,
        position: 'relative',
        overflow: 'hidden',
      }}>

        {/* Background flourish */}
        <span style={{
          position: 'absolute', right: -300, top: '50%',
          transform: 'rotate(90deg)',
          fontFamily: 'var(--font-mono)', fontSize: 8,
          letterSpacing: '8px', textTransform: 'uppercase',
          color: 'var(--accent)', opacity: 0.15,
          whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none',
        }}>
          SESSION · {sessionId.slice(0, 8).toUpperCase()} · COMPILE PIPELINE · {totalSteps} STEPS
        </span>

        {/* ── Header ────────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>

          {/* Left: status dot + heading */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 8, height: 8, background: statusColor, flexShrink: 0 }} />
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 10,
                lineHeight: '15px', letterSpacing: '2px', textTransform: 'uppercase',
                color: statusColor,
              }}>
                {statusLabel}
              </span>
            </div>
            <h1 style={{
              fontFamily: 'var(--font-heading)', fontWeight: 700,
              fontSize: 36, lineHeight: '36px', letterSpacing: '-0.9px',
              color: 'var(--fg)', margin: 0,
            }}>
              {headingText}
            </h1>
          </div>

          {/* Right: step counter */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px',
              letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--fg-subtle)',
            }}>
              {stepCounterLabel}
            </span>
            <span style={{
              fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 16,
              lineHeight: '24px', letterSpacing: '-0.8px', color: 'var(--accent)',
              textShadow: '0 0 12px rgba(var(--accent-rgb),0.4)',
            }}>
              {stepCounterValue}
            </span>
          </div>
        </div>

        {/* ── Pipeline steps ─────────────────────────────────────────────────── */}
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 24 }}>

          {/* Vertical connector line between icon boxes */}
          <div style={{
            position: 'absolute', width: 1, left: 19.5,
            top: 40, bottom: 40,
            background: 'var(--separator)', opacity: 0.2, pointerEvents: 'none',
          }} />

          {/* UI-A — pre-step queued-state row. Progressive escalation:
                 0-15s neutral, 15-30s amber, >30s (or 503 from confirm) danger. */}
          {isQueued && (() => {
            const rowColor =
              uiAState === 'danger' ? 'var(--danger)' :
              uiAState === 'amber'  ? '#E6B800'       :
                                      'var(--fg-subtle)';
            const rowBg =
              uiAState === 'danger' ? 'rgba(var(--danger-rgb),0.15)' :
              uiAState === 'amber'  ? 'rgba(230,184,0,0.15)'         :
                                      'var(--bg-track)';
            const rowLabel =
              uiAState === 'danger' ? 'Compile engine not responding'
                                    : 'Queuing — waiting for compile engine';
            const subline =
              uiAState === 'danger' && n8nErrorFromUrl ? toUserMessage(n8nErrorFromUrl) :
              uiAState === 'danger'                    ? 'n8n did not pick up this session. Click Retry to resend.' :
              uiAState === 'amber'                     ? 'n8n may be starting up — this usually takes a few seconds.' :
                                                         null;
            return (
              <div style={{
                display: 'flex', flexDirection: 'row',
                alignItems: subline ? 'flex-start' : 'center',
                gap: 24,
              }}>
                <div style={{
                  width: 40, height: 40, flexShrink: 0,
                  background: rowBg,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  position: 'relative', zIndex: 1,
                }}>
                  <IconSpinner />
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, paddingTop: subline ? 4 : 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                    <span style={{
                      fontFamily: 'var(--font-heading)', fontWeight: 500,
                      fontSize: 16, lineHeight: '24px', color: 'var(--fg)',
                    }}>
                      {rowLabel}
                    </span>
                    {uiAState === 'danger' ? (
                      <button
                        onClick={handleRetry}
                        disabled={retrying}
                        style={{
                          background: 'transparent', border: `1px solid ${rowColor}`,
                          cursor: retrying ? 'not-allowed' : 'pointer',
                          padding: '4px 14px',
                          fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px',
                          letterSpacing: '2px', textTransform: 'uppercase', color: rowColor,
                          opacity: retrying ? 0.5 : 1, flexShrink: 0,
                        }}
                      >
                        {retrying ? 'Retrying…' : 'Retry'}
                      </button>
                    ) : (
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px',
                        letterSpacing: '1px', textTransform: 'uppercase', color: rowColor,
                        flexShrink: 0,
                      }}>
                        {elapsedSec}s
                      </span>
                    )}
                  </div>
                  {subline && (
                    <span style={{
                      fontFamily: 'var(--font-heading)', fontSize: 13,
                      lineHeight: '18px', color: 'var(--fg-subtle)',
                    }}>
                      {subline}
                    </span>
                  )}
                </div>
              </div>
            );
          })()}

          {STEPS.map(step => {
            const stepState  = steps[step.key];
            const stepStatus = isComplete ? 'done' : (stepState?.status ?? 'pending');
            const detail     = stepState?.detail;

            // Hide v18 prelude steps that completed as skipped (no items
            // for that connector). `detail='skipped (no items)'` /
            // 'skipped (legacy session)' is the convention written by
            // runPerItemStep + the orchestrator's legacy else-branch.
            if (stepStatus === 'done' && detail?.startsWith('skipped')) {
              return null;
            }

            const isStepDone    = stepStatus === 'done';
            const isStepActive  = stepStatus === 'running';
            const isStepFailed  = stepStatus === 'failed';
            const isStepPending = !isStepDone && !isStepActive && !isStepFailed;

            const iconBg =
              isStepDone   ? 'rgba(var(--accent-rgb),0.2)' :
              isStepActive ? 'var(--accent)'         :
              isStepFailed ? 'rgba(var(--danger-rgb),0.15)' :
                             'var(--bg-track)';

            return (
              <div
                key={step.key}
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: isStepActive ? 'flex-start' : 'center',
                  gap: 24,
                  opacity: isStepPending ? 0.3 : 1,
                }}
              >
                {/* Icon box */}
                <div style={{
                  width: 40, height: 40, flexShrink: 0,
                  background: iconBg,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  position: 'relative', zIndex: 1,
                }}>
                  {isStepDone    && <IconDone />}
                  {isStepActive  && <IconSpinner />}
                  {isStepFailed  && <IconFail />}
                  {isStepPending && <IconPending />}
                </div>

                {/* Text content */}
                {isStepActive ? (
                  /* Active — tall with detail row + micro bar */
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span style={{
                        fontFamily: 'var(--font-heading)', fontWeight: 700,
                        fontSize: 18, lineHeight: '28px', color: 'var(--fg)',
                      }}>
                        {step.label}
                      </span>
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px',
                        letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--accent)',
                        flexShrink: 0,
                      }}>
                        Processing
                      </span>
                    </div>
                    {detail && (
                      <span style={{
                        fontFamily: 'var(--font-heading)', fontSize: 14,
                        lineHeight: '20px', color: 'var(--fg-subtle)',
                      }}>
                        {detail}
                      </span>
                    )}
                    {/* Micro progress bar */}
                    <div style={{ height: 4, background: 'var(--bg-track)', position: 'relative', overflow: 'hidden', marginTop: 4 }}>
                      <div style={{
                        position: 'absolute', top: 0, left: 0, bottom: 0, width: '50%',
                        background: 'var(--accent)',
                        boxShadow: '0 0 10px var(--accent)',
                      }} />
                    </div>
                  </div>
                ) : (
                  /* Done / failed / pending — single line */
                  <div style={{ flex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{
                      fontFamily: 'var(--font-heading)', fontWeight: 500,
                      fontSize: isStepDone ? 16 : 14,
                      lineHeight: isStepDone ? '24px' : '20px',
                      color: isStepFailed ? 'var(--danger)' : 'var(--fg)',
                      opacity: isStepDone ? 0.6 : 1,
                    }}>
                      {step.label}
                    </span>
                    {isStepDone && (
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px',
                        letterSpacing: '-0.5px', textTransform: 'uppercase', color: 'var(--fg-subtle)',
                        flexShrink: 0,
                      }}>
                        Done
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────────── */}
        <div style={{
          borderTop: '1px solid rgba(var(--separator-rgb),0.1)',
          paddingTop: 24,
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        }}>

          {/* Left: stats */}
          <div style={{ display: 'flex', flexDirection: 'row', gap: 32 }}>
            {footerStats.map(({ label, value }) => (
              <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 8, lineHeight: '12px',
                  letterSpacing: '0.8px', textTransform: 'uppercase', color: 'var(--fg-subtle)',
                }}>
                  {label}
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px',
                  color: 'var(--fg)',
                }}>
                  {value}
                </span>
              </div>
            ))}
          </div>

          {/* Right: buttons */}
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 16 }}>
            {(isRunning || isQueued) && (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                style={{
                  background: 'transparent', border: 'none',
                  cursor: cancelling ? 'not-allowed' : 'pointer',
                  padding: '8px 4px',
                  fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px',
                  letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--danger)',
                  opacity: cancelling ? 0.5 : 1,
                }}
              >
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            )}

            {/* Dashboard — always visible so the user can leave */}
            <button
              onClick={() => router.push('/')}
              style={{
                background: 'var(--accent)', border: 'none', cursor: 'pointer',
                padding: '8px 24px',
                fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px',
                letterSpacing: '2px', textTransform: 'uppercase',
                color: 'var(--bg)', fontWeight: 700,
              }}
            >
              Dashboard
            </button>

            {isComplete && (
              <Link
                href="/wiki"
                style={{
                  textDecoration: 'none',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  padding: '8px 24px',
                  border: '1px solid var(--accent)',
                  fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px',
                  letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--accent)',
                }}
              >
                View Wiki
              </Link>
            )}

            {(isFailedStatus || isCancelled || queuedRetry) && (
              <button
                onClick={handleRetry}
                disabled={retrying}
                style={{
                  background: 'transparent', border: '1px solid var(--accent)',
                  cursor: retrying ? 'not-allowed' : 'pointer',
                  padding: '8px 24px',
                  fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px',
                  letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--accent)',
                  opacity: retrying ? 0.5 : 1,
                }}
              >
                {retrying ? 'Retrying…' : 'Retry'}
              </button>
            )}

            {/* Phase 4: retry only per-item failed staging rows. Shows when
                the session reached a terminal state but some items inside
                ingest_{urls,files,texts} skipped. Distinct from the
                session-level Retry above — that one resumes from first
                non-done step, which is a no-op on completed sessions. */}
            {(isComplete || isFailedStatus || isCancelled) &&
             (progress?.failed_stage_count ?? 0) > 0 && (
              <button
                onClick={handleRetryFailed}
                disabled={retryingFailed}
                style={{
                  background: 'transparent', border: '1px solid var(--accent)',
                  cursor: retryingFailed ? 'not-allowed' : 'pointer',
                  padding: '8px 24px',
                  fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px',
                  letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--accent)',
                  opacity: retryingFailed ? 0.5 : 1,
                }}
              >
                {retryingFailed
                  ? 'Retrying…'
                  : `Retry ${progress?.failed_stage_count} failed`}
              </button>
            )}
          </div>
        </div>

        {/* Queued timeout hint */}
        {queuedRetry && !isFailedStatus && (
          <pre style={{
            fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-muted)',
            background: 'rgba(var(--separator-rgb),0.1)', border: '1px solid rgba(var(--separator-rgb),0.2)',
            padding: '12px 16px', margin: 0, overflowX: 'auto',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            Pipeline hasn&apos;t started. The background worker may be unavailable — click Retry to try again.
          </pre>
        )}

        {/* Error detail */}
        {isFailedStatus && progress?.error && (
          <pre style={{
            fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--danger)',
            background: 'rgba(var(--danger-rgb),0.08)', border: '1px solid rgba(var(--danger-rgb),0.2)',
            padding: '12px 16px', margin: 0, overflowX: 'auto',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {progress.error}
          </pre>
        )}

        {/* Inline error from a cancel/retry button click */}
        {actionError && (
          <pre style={{
            fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--danger)',
            background: 'rgba(var(--danger-rgb),0.08)', border: '1px solid rgba(var(--danger-rgb),0.2)',
            padding: '12px 16px', margin: 0, overflowX: 'auto',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {actionError}
          </pre>
        )}
      </div>

      {/* Background hint — below the card, always visible while in-flight */}
      {!isComplete && !isFailedStatus && (
        <p style={{
          maxWidth: 1040, margin: '12px auto 0',
          fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px',
          letterSpacing: '0.5px', color: 'var(--fg-subtle)', textAlign: 'center',
        }}>
          {patienceVisible
            ? 'Taking longer than expected — still running. You can close this tab and come back later.'
            : 'Runs in the background — you can go to the dashboard and come back any time.'}
        </p>
      )}
    </main>
  );
}

export default function ProgressPage() {
  return (
    <Suspense
      fallback={
        <main style={{ maxWidth: 1040, margin: '0 auto', padding: '1.5rem 40px 2.5rem' }}>
          <p style={{
            maxWidth: 1040, margin: '0 auto',
            fontFamily: 'var(--font-mono)', fontSize: 10,
            textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--fg-dim)',
          }}>
            Loading…
          </p>
        </main>
      }
    >
      <ProgressPageInner />
    </Suspense>
  );
}
