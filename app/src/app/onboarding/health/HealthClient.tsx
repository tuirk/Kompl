'use client';

/**
 * HealthClient — pre-stage health-check step rendered at /onboarding/health.
 *
 * Fetches /api/health once on mount and renders a table of deterministic
 * configuration checks. Red rows block the Next button; amber rows let
 * Next through with a note. No recheck button by design — fixing env vars
 * requires `docker compose restart` which kills the browser session, so
 * the user naturally re-enters this page on return.
 *
 * Connector-list handoff matches the source-selector pattern:
 *   - kompl_connectors and kompl_connector_idx sessionStorage keys are
 *     read here and forwarded to /onboarding/${connectors[0]}?session_id=…
 *     when Next is clicked.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import {
  evaluateHealth,
  type HealthApiResponse,
  type HealthRow,
} from '@/lib/onboarding-health-evaluator';
import { getRemediation } from '@/lib/service-errors';

type FetchState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: HealthRow[] };

export default function HealthClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('session_id') ?? '';

  const [state, setState] = useState<FetchState>({ kind: 'loading' });

  useEffect(() => {
    void fetch('/api/health', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok && r.status !== 500) {
          throw new Error(`HTTP ${r.status}`);
        }
        const body = (await r.json()) as HealthApiResponse;
        setState({ kind: 'ready', rows: evaluateHealth(body) });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message });
      });
  }, []);

  const redFailing =
    state.kind === 'ready'
      ? state.rows.some((r) => r.severity === 'red' && r.status === 'fail')
      : true;
  const allPass =
    state.kind === 'ready' ? state.rows.every((r) => r.status === 'pass') : false;
  const amberFailing =
    state.kind === 'ready'
      ? state.rows.some((r) => r.severity === 'amber' && r.status === 'fail')
      : false;

  function handleNext() {
    if (redFailing) return;
    if (!sessionId) {
      router.push('/onboarding');
      return;
    }
    const raw = typeof window !== 'undefined' ? sessionStorage.getItem('kompl_connectors') : null;
    if (!raw) {
      router.push('/onboarding');
      return;
    }
    let connectors: string[];
    try {
      const parsed = JSON.parse(raw) as unknown;
      connectors = Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      connectors = [];
    }
    if (connectors.length === 0) {
      router.push('/onboarding');
      return;
    }
    router.push(`/onboarding/${connectors[0]}?session_id=${sessionId}`);
  }

  let nextLabel = 'Next';
  if (state.kind === 'ready') {
    if (allPass) nextLabel = 'Next — all clear';
    else if (amberFailing && !redFailing) nextLabel = 'Next — amber notes acknowledged';
  }

  return (
    <>
      <main style={{ maxWidth: 1040, margin: '0 auto', padding: '1.5rem 40px 100px' }}>
        {/* Header */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 32 }}>
          <Link
            href="/onboarding"
            style={{
              fontFamily: 'var(--font-body)',
              fontWeight: 400,
              fontSize: 10,
              lineHeight: '15px',
              letterSpacing: 3,
              textTransform: 'uppercase',
              color: 'var(--accent)',
              textDecoration: 'none',
            }}
          >
            ← Sources
          </Link>
          <h1 style={{
            fontFamily: 'var(--font-heading)',
            fontWeight: 700,
            fontSize: 52,
            lineHeight: '54px',
            letterSpacing: '-2.6px',
            color: 'var(--fg)',
            margin: 0,
          }}>
            Pre-flight checks.
          </h1>
          <p style={{
            fontFamily: 'var(--font-body)',
            fontWeight: 400,
            fontSize: 13,
            lineHeight: '20px',
            letterSpacing: '0.2px',
            color: 'var(--fg-dim)',
            margin: 0,
          }}>
            Resolve red rows before continuing. Amber rows are informational — proceed
            only if you accept that those item types will fail at compile time.
          </p>
        </section>

        {state.kind === 'loading' && (
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-muted)' }}>
            Loading health checks…
          </p>
        )}

        {state.kind === 'error' && (
          <div style={{
            borderLeft: '3px solid var(--danger)',
            background: 'rgba(var(--danger-rgb),0.08)',
            padding: 16,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--danger)',
          }}>
            Could not reach /api/health ({state.message}). Is the app container running?
          </div>
        )}

        {state.kind === 'ready' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {state.rows.map((row) => (
              <HealthRowCard key={row.id} row={row} />
            ))}
          </div>
        )}
      </main>

      {/* Inline footer nav — matches OnboardingClient.tsx pattern */}
      <div style={{
        position: 'fixed',
        bottom: 32, left: 0, right: 0,
        zIndex: 50,
        background: 'var(--bg)',
        borderTop: '1px solid rgba(var(--separator-rgb),0.12)',
        padding: '16px 56px',
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            lineHeight: '15px',
            letterSpacing: '1px',
            textTransform: 'uppercase',
            color: 'var(--fg-dim)',
          }}>
            {state.kind === 'ready'
              ? redFailing
                ? 'Resolve red rows to continue'
                : allPass
                  ? 'All checks passing'
                  : 'Amber notes only'
              : ' '}
          </span>
        </div>

        <button
          onClick={handleNext}
          disabled={redFailing}
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '16px 32px',
            background: 'var(--accent)',
            border: 'none',
            opacity: redFailing ? 0.45 : 1,
            cursor: redFailing ? 'not-allowed' : 'pointer',
            fontFamily: 'var(--font-mono)',
            fontWeight: 700,
            fontSize: 10,
            lineHeight: '15px',
            letterSpacing: '1px',
            textTransform: 'uppercase',
            color: 'var(--accent-text)',
          }}
        >
          {nextLabel}
          <ArrowRight size={9} style={{ color: 'var(--accent-text)', flexShrink: 0 }} />
        </button>
      </div>
    </>
  );
}

function HealthRowCard({ row }: { row: HealthRow }) {
  const failing = row.status === 'fail';
  const remediation = failing ? getRemediation(row.code) : undefined;
  const borderColor =
    !failing                ? 'rgba(var(--accent-rgb),0.3)' :
    row.severity === 'red'  ? 'var(--danger)' :
                              'rgba(var(--warning-rgb),0.6)';
  const labelColor =
    !failing                ? 'var(--fg-secondary)' :
    row.severity === 'red'  ? 'var(--danger)' :
                              'var(--fg-secondary)';

  return (
    <div style={{
      background: 'var(--bg-card)',
      borderLeft: `3px solid ${borderColor}`,
      padding: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        letterSpacing: '0.3px',
        color: labelColor,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span aria-hidden="true">{failing ? '✗' : '✓'}</span>
        <strong>{row.label}</strong>
      </div>

      {remediation && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
          <p style={{
            fontFamily: 'var(--font-body)',
            fontSize: 13,
            lineHeight: '20px',
            color: 'var(--fg-secondary)',
            margin: 0,
          }}>
            {remediation.title}
          </p>
          <p style={{
            fontFamily: 'var(--font-body)',
            fontSize: 12,
            lineHeight: '18px',
            color: 'var(--fg-dim)',
            margin: 0,
          }}>
            {remediation.body}
          </p>
          <code style={{
            display: 'block',
            background: 'rgba(var(--separator-rgb),0.12)',
            padding: '8px 10px',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: '16px',
            color: 'var(--fg)',
            userSelect: 'text',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            {remediation.fix}
          </code>
        </div>
      )}
    </div>
  );
}
