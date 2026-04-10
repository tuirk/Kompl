'use client';

/**
 * /onboarding/progress — Part 2c-ii progress screen.
 *
 * Polls GET /api/compile/progress?session_id=<id> every 2 seconds.
 * Stops polling when status === 'completed' or status === 'failed'.
 * Has a 15-minute patience message guard (keeps polling, just shows a note).
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 2000;
const PATIENCE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

interface StepState {
  status: string;
  detail?: string;
}

interface ProgressResponse {
  session_id: string;
  status: string;
  current_step: string | null;
  steps: Record<string, StepState>;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
}

const STEPS = [
  { key: 'extract',  label: 'Extracting knowledge' },
  { key: 'resolve',  label: 'Resolving entities' },
  { key: 'plan',     label: 'Planning wiki structure' },
  { key: 'draft',    label: 'Writing pages' },
  { key: 'crossref', label: 'Cross-referencing' },
  { key: 'commit',   label: 'Finalizing' },
  { key: 'schema',   label: 'Setting up wiki structure' },
];

function parseCommittedCount(detail: string | undefined): { pages: number; sources: number } {
  if (!detail) return { pages: 0, sources: 0 };
  const pagesMatch = detail.match(/(\d+)\s+pages?/i);
  const sourcesMatch = detail.match(/(\d+)\s+sources?/i);
  return {
    pages: pagesMatch ? parseInt(pagesMatch[1], 10) : 0,
    sources: sourcesMatch ? parseInt(sourcesMatch[1], 10) : 0,
  };
}

function StepIcon({ status }: { status: string }) {
  if (status === 'done') return <span className="text-green-500">✅</span>;
  if (status === 'running') return <span className="text-amber-500">⏳</span>;
  if (status === 'failed') return <span className="text-red-500">❌</span>;
  return <span className="text-gray-400">⬜</span>;
}

function StepRow({ stepKey, label, state }: { stepKey: string; label: string; state: StepState | undefined }) {
  const status = state?.status ?? 'pending';
  const detail = state?.detail;

  return (
    <div className="flex items-start gap-3 py-2">
      <span className="mt-0.5 text-lg w-6 flex-shrink-0 text-center">
        <StepIcon status={status} />
      </span>
      <div className="flex-1 min-w-0">
        <span
          className={
            status === 'done'
              ? 'text-gray-900 text-sm font-medium'
              : status === 'running'
              ? 'text-amber-700 text-sm font-medium'
              : status === 'failed'
              ? 'text-red-700 text-sm font-medium'
              : 'text-gray-400 text-sm'
          }
        >
          {label}
        </span>
        {detail && status === 'running' && (
          <p className="text-xs text-amber-600 mt-0.5 animate-pulse">{detail}</p>
        )}
        {detail && status === 'done' && (
          <p className="text-xs text-gray-500 mt-0.5">{detail}</p>
        )}
        {detail && status === 'failed' && (
          <p className="text-xs text-red-500 mt-0.5">{detail}</p>
        )}
      </div>
    </div>
  );
}

function ProgressPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const sessionId = searchParams.get('session_id') ?? '';

  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [patienceVisible, setPatienceVisible] = useState(false);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const patienceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isActiveRef = useRef(true);

  function stopPolling() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (patienceTimerRef.current) {
      clearTimeout(patienceTimerRef.current);
      patienceTimerRef.current = null;
    }
  }

  async function fetchProgress() {
    if (!sessionId || !isActiveRef.current) return;
    try {
      const res = await fetch(`/api/compile/progress?session_id=${encodeURIComponent(sessionId)}`);
      if (!res.ok) return;
      const data = await res.json() as ProgressResponse;
      if (!isActiveRef.current) return;
      setProgress(data);
      if (data.status === 'completed' || data.status === 'failed') {
        stopPolling();
      }
    } catch {
      // silent — keep polling
    }
  }

  useEffect(() => {
    if (!sessionId) return;

    // Start polling immediately, then every 2s
    void fetchProgress();
    intervalRef.current = setInterval(fetchProgress, POLL_INTERVAL_MS);

    // Patience message after 15 min if still running/queued
    patienceTimerRef.current = setTimeout(() => {
      setPatienceVisible(true);
    }, PATIENCE_TIMEOUT_MS);

    return () => {
      isActiveRef.current = false;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function handleRetry() {
    if (!sessionId) return;
    setRetrying(true);
    try {
      await fetch('/api/compile/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      // Re-enable polling
      isActiveRef.current = true;
      setProgress(null);
      setRetrying(false);
      void fetchProgress();
      intervalRef.current = setInterval(fetchProgress, POLL_INTERVAL_MS);
    } catch {
      setRetrying(false);
    }
  }

  const status = progress?.status ?? 'queued';
  const steps = progress?.steps ?? {};

  // Parse committed counts from commit step detail
  const commitDetail = steps['commit']?.detail;
  const { pages: committedPages, sources: committedSources } = parseCommittedCount(commitDetail);

  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-sm border border-gray-200 p-8">

        {/* Completed state */}
        {status === 'completed' && (
          <>
            <div className="text-center mb-8">
              <div className="text-4xl mb-3">✅</div>
              <h1 className="text-2xl font-semibold text-gray-900 mb-2">Your wiki is ready!</h1>
              {(committedPages > 0 || committedSources > 0) && (
                <p className="text-gray-500 text-sm">
                  {committedPages > 0 ? `${committedPages} page${committedPages !== 1 ? 's' : ''}` : ''}
                  {committedPages > 0 && committedSources > 0 ? ' created from ' : ''}
                  {committedSources > 0 ? `${committedSources} source${committedSources !== 1 ? 's' : ''}` : ''}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-3">
              <Link
                href="/wiki"
                className="w-full text-center bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-6 rounded-lg transition-colors"
              >
                View your wiki →
              </Link>
              <button
                onClick={() => router.push('/')}
                className="w-full text-center bg-white hover:bg-gray-50 text-gray-700 font-medium py-3 px-6 rounded-lg border border-gray-200 transition-colors"
              >
                ← Back to dashboard
              </button>
            </div>
          </>
        )}

        {/* Failed state */}
        {status === 'failed' && (
          <>
            <div className="text-center mb-8">
              <div className="text-4xl mb-3">❌</div>
              <h1 className="text-2xl font-semibold text-gray-900 mb-2">Something went wrong</h1>
              {progress?.error && (
                <p className="text-red-600 text-sm mt-2 bg-red-50 rounded-lg p-3 text-left font-mono break-words">
                  {progress.error}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-3">
              <button
                onClick={handleRetry}
                disabled={retrying}
                className="w-full text-center bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium py-3 px-6 rounded-lg transition-colors"
              >
                {retrying ? 'Retrying…' : 'Retry'}
              </button>
              <button
                onClick={() => router.push('/')}
                className="w-full text-center bg-white hover:bg-gray-50 text-gray-700 font-medium py-3 px-6 rounded-lg border border-gray-200 transition-colors"
              >
                ← Back to dashboard
              </button>
            </div>
          </>
        )}

        {/* Queued state */}
        {status === 'queued' && (
          <>
            <div className="mb-6">
              <h1 className="text-xl font-semibold text-gray-900 mb-1">Preparing your wiki…</h1>
              <p className="text-gray-500 text-sm">Waiting for the compile pipeline to start.</p>
            </div>
            <div className="divide-y divide-gray-100">
              {STEPS.map(step => (
                <StepRow key={step.key} stepKey={step.key} label={step.label} state={undefined} />
              ))}
            </div>
          </>
        )}

        {/* Running state */}
        {status === 'running' && (
          <>
            <div className="mb-6">
              <h1 className="text-xl font-semibold text-gray-900 mb-1">Building your wiki</h1>
              <p className="text-gray-500 text-sm">This page updates automatically every few seconds.</p>
            </div>
            <div className="divide-y divide-gray-100">
              {STEPS.map(step => (
                <StepRow key={step.key} stepKey={step.key} label={step.label} state={steps[step.key]} />
              ))}
            </div>
          </>
        )}

        {/* Patience message (15 min guard — shown for queued or running) */}
        {patienceVisible && (status === 'queued' || status === 'running') && (
          <p className="mt-6 text-xs text-gray-400 text-center leading-relaxed">
            This is taking longer than expected. The process is still running — you can close this page and come back later.
          </p>
        )}

        {/* Active polling hint for non-terminal states */}
        {(status === 'queued' || status === 'running') && !patienceVisible && (
          <p className="mt-6 text-xs text-gray-400 text-center">
            Updates automatically every few seconds.
          </p>
        )}

      </div>
    </main>
  );
}

export default function ProgressPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <p className="text-gray-500">Loading…</p>
        </div>
      }
    >
      <ProgressPageInner />
    </Suspense>
  );
}
