'use client';

/**
 * /onboarding/progress — Post-confirm progress screen.
 *
 * Polls GET /api/activity?since=<iso>&limit=50 every 3 seconds for
 * source_compiled events (same pattern as /feed). Shows "N / M done"
 * until all queued sources are compiled or 10 minutes pass.
 *
 * Messaging is intentionally generic — the drain compiles sources
 * one-at-a-time via the existing pipeline. Entity/concept pages and
 * multi-source synthesis come in Part 2.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

interface ActivityRow {
  id: number;
  timestamp: string;
  action_type: string;
  source_id: string | null;
  details: unknown;
}

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function ProgressPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const sessionId = searchParams.get('session_id') ?? '';
  const isReturning = searchParams.get('mode') === 'add';
  const queuedParam = parseInt(searchParams.get('queued') ?? '0', 10);
  const queued = isNaN(queuedParam) || queuedParam < 1 ? 1 : queuedParam;

  const [compiled, setCompiled] = useState(0);
  const [timedOut, setTimedOut] = useState(false);

  const sinceRef = useRef<string>(new Date().toISOString());
  const compiledRef = useRef<number>(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const done = compiled >= queued;

  useEffect(() => {
    // Timeout guard
    timeoutTimerRef.current = setTimeout(() => {
      setTimedOut(true);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    }, POLL_TIMEOUT_MS);

    async function poll() {
      if (compiledRef.current >= queued) return;
      try {
        const since = encodeURIComponent(sinceRef.current);
        const res = await fetch(`/api/activity?limit=50&since=${since}`);
        if (!res.ok) return;
        const body = await res.json() as { items: ActivityRow[]; count: number };
        const newCompiled = body.items.filter(a => a.action_type === 'source_compiled').length;
        if (newCompiled > 0) {
          compiledRef.current += newCompiled;
          setCompiled(c => c + newCompiled);
          if (body.items.length > 0) {
            sinceRef.current = body.items[body.items.length - 1].timestamp;
          }
        }
      } catch {
        // silent — keep polling
      }

      if (compiledRef.current < queued) {
        pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);

    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
    };
  }, [queued]);

  return (
    <main
      style={{
        maxWidth: 600,
        margin: '8rem auto',
        padding: '0 1.5rem',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: '1.8rem', marginBottom: '2rem' }}>
        {isReturning ? 'Adding to your wiki' : 'Building your wiki'}
      </h1>

      {/* Step list */}
      <div style={{ textAlign: 'left', marginBottom: '2.5rem' }}>
        <StepRow icon="✅" label="Sources collected" done />
        <StepRow icon="✅" label="Review complete" done />
        <StepRow
          icon={done ? '✅' : '⏳'}
          label={
            done
              ? `Done — ${compiled} source${compiled !== 1 ? 's' : ''} ${isReturning ? 'added' : 'compiled'}.`
              : `Compiling… ${compiled} / ${queued} done`
          }
          done={done}
          active={!done && !timedOut}
        />
      </div>

      {/* Done state */}
      {done && (
        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => router.push('/wiki')} style={{ padding: '0.7rem 1.5rem' }}>
            View your wiki →
          </button>
          {isReturning && (
            <button
              onClick={() => router.push('/')}
              style={{
                padding: '0.7rem 1.5rem',
                background: 'none',
                border: '1px solid var(--border)',
                color: 'var(--fg)',
                cursor: 'pointer',
                borderRadius: 6,
              }}
            >
              ← Back to dashboard
            </button>
          )}
          <button
            onClick={() => router.push('/feed')}
            style={{
              padding: '0.7rem 1.5rem',
              background: 'none',
              border: '1px solid var(--border)',
              color: 'var(--fg)',
              cursor: 'pointer',
              borderRadius: 6,
            }}
          >
            See activity feed
          </button>
        </div>
      )}

      {/* Timeout state */}
      {timedOut && !done && (
        <div>
          <p style={{ color: 'var(--fg-muted)', marginBottom: '1.5rem' }}>
            This is taking longer than expected. Check the activity feed for status.
          </p>
          <button onClick={() => router.push('/feed')} style={{ padding: '0.7rem 1.5rem' }}>
            See activity feed →
          </button>
        </div>
      )}

      {/* Active polling hint */}
      {!done && !timedOut && (
        <p style={{ color: 'var(--fg-dim)', fontSize: '0.85rem', marginTop: '2rem' }}>
          Each source is compiled one at a time. This page updates automatically.
        </p>
      )}
    </main>
  );
}

function StepRow({
  icon,
  label,
  done,
  active,
}: {
  icon: string;
  label: string;
  done?: boolean;
  active?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.5rem 0',
        color: done ? 'var(--fg)' : active ? 'var(--fg)' : 'var(--fg-dim)',
      }}
    >
      <span style={{ fontSize: '1.1rem', width: 24, textAlign: 'center' }}>{icon}</span>
      <span style={{ fontSize: '0.95rem' }}>{label}</span>
    </div>
  );
}

export default function ProgressPage() {
  return <Suspense><ProgressPageInner /></Suspense>;
}
