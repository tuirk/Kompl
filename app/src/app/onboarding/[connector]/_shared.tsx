'use client';

/**
 * _shared.tsx — shared types, navigation helper, button styles, and BottomNav.
 * Imported by page.tsx, twitter-connector.tsx, and apple-notes-connector.tsx.
 * Define once here; never duplicate in connector files.
 */

import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConnectorProps {
  sessionId: string;
  connectors: string[];
  connectorIdx: number;
  showToast: (msg: string, type?: 'error') => void;
  /**
   * 'wizard' (default) — linear onboarding flow with step progress tracker.
   * 'resume' — user arrived here from the review page's "Add more" link;
   * hide the progress tracker, show an "you've already added N" banner,
   * and navigate back to /onboarding/review instead of the next connector.
   */
  mode?: 'wizard' | 'resume';
}

// ── Staging helper ────────────────────────────────────────────────────────────

/**
 * POST items to /api/onboarding/stage. Shared by all 6 connectors so they
 * don't duplicate fetch/error-unwrap logic. Throws an Error whose message is
 * the server's `error_code` (if present) else `error` else `stage_failed_<status>`
 * so callers can pass it straight to `toUserMessage()`.
 *
 * display-payload construction stays per-connector — each connector knows
 * its own display-worthy fields (filename+size vs hostname vs @author+excerpt).
 */
export async function stageItems(
  sessionId: string,
  connector: 'url' | 'file-upload' | 'text' | 'saved-link',
  items: Array<Record<string, unknown>>,
): Promise<{ stage_ids: string[] }> {
  const res = await fetch('/api/onboarding/stage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, connector, items }),
  });
  const body = (await res.json()) as {
    session_id?: string;
    stage_ids?: string[];
    error?: string;
    error_code?: string;
  };
  if (!res.ok) {
    throw new Error(body.error_code ?? body.error ?? `stage_failed_${res.status}`);
  }
  return { stage_ids: body.stage_ids ?? [] };
}

// ── Navigation ────────────────────────────────────────────────────────────────

export function navigateNext(
  sessionId: string,
  connectors: string[],
  connectorIdx: number,
  router: AppRouterInstance,
  mode: 'wizard' | 'resume' = 'wizard',
) {
  // In resume mode (came from review's "Add more" link), the wizard
  // sequence is bypassed — save returns the user to the review page
  // rather than advancing to the next connector.
  if (mode === 'resume') {
    router.push(`/onboarding/review?session_id=${encodeURIComponent(sessionId)}`);
    return;
  }
  const nextIdx = connectorIdx + 1;
  if (nextIdx >= connectors.length) {
    router.push(`/onboarding/review?session_id=${encodeURIComponent(sessionId)}`);
  } else {
    sessionStorage.setItem('kompl_connector_idx', String(nextIdx));
    router.push(`/onboarding/${connectors[nextIdx]}?session_id=${encodeURIComponent(sessionId)}`);
  }
}

export function navigateBack(
  sessionId: string,
  connectors: string[],
  connectorIdx: number,
  router: AppRouterInstance,
  mode: 'wizard' | 'resume' = 'wizard',
) {
  // In resume mode, Back returns to review — symmetric with Save.
  if (mode === 'resume') {
    router.push(`/onboarding/review?session_id=${encodeURIComponent(sessionId)}`);
    return;
  }
  if (connectorIdx <= 0) {
    // First connector — go back to selector, preserving session so the landing
    // page resumes the existing UUID rather than generating a fresh one.
    router.push(`/onboarding?session_id=${encodeURIComponent(sessionId)}`);
  } else {
    // Go to previous connector
    const prevIdx = connectorIdx - 1;
    sessionStorage.setItem('kompl_connector_idx', String(prevIdx));
    router.push(`/onboarding/${connectors[prevIdx]}?session_id=${encodeURIComponent(sessionId)}`);
  }
}

// ── Button styles ─────────────────────────────────────────────────────────────

export const BTN_PRIMARY: React.CSSProperties = {
  display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
  gap: 8, padding: '16px 32px',
  background: 'var(--accent)', border: 'none', cursor: 'pointer',
  fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 10,
  lineHeight: '15px', letterSpacing: '1px', textTransform: 'uppercase',
  color: 'var(--accent-text)',
};

export const BTN_PRIMARY_DISABLED: React.CSSProperties = {
  ...BTN_PRIMARY,
  opacity: 0.45,
  cursor: 'not-allowed',
};

export const BTN_GHOST: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '16px 32px',
  background: 'transparent', border: '1px solid var(--separator)', cursor: 'pointer',
  fontFamily: 'var(--font-mono)', fontWeight: 400, fontSize: 10,
  lineHeight: '15px', letterSpacing: '1px', textTransform: 'uppercase',
  color: 'var(--fg)',
};

// ── BottomNav ─────────────────────────────────────────────────────────────────

/**
 * Two phases only in Phase 2: idle (user can click Save) and loading
 * (upload or multi-POST in flight). The legacy 'done' phase went away
 * when connectors stopped rendering post-scrape SummaryCards — staging
 * is <50ms and the review page is the real confirmation surface.
 */
export function BottomNav({
  phase,
  hasInput,
  onIngest,
  onSkip,
  onBack,
  primaryLabel = 'Save & Continue',
}: {
  phase: 'idle' | 'loading';
  hasInput: boolean;
  onIngest: () => void;
  onSkip: () => void;
  onBack: () => void;
  primaryLabel?: string;
}) {
  return (
    <div style={{
      position: 'fixed',
      bottom: 32, left: 0, right: 0,
      zIndex: 50,
      background: 'var(--bg)',
      borderTop: '1px solid rgba(var(--separator-rgb),0.12)',
      padding: '16px 56px',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
    }}>
      {/* Left: back */}
      <button
        onClick={onBack}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          fontFamily: 'var(--font-mono)', fontSize: 10,
          lineHeight: '15px', letterSpacing: '1px', textTransform: 'uppercase',
          color: 'var(--fg-dim)',
        }}
      >
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
          <path d="M8 4.5H1M1 4.5L4.5 1M1 4.5L4.5 8" style={{ stroke: 'var(--fg-muted)' }} strokeWidth="1.2" strokeLinecap="square"/>
        </svg>
        Back
      </button>

      {/* Right: skip + primary action */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 16 }}>
        <button
          onClick={onSkip}
          disabled={phase === 'loading'}
          style={phase === 'loading' ? { ...BTN_GHOST, opacity: 0.4, cursor: 'not-allowed' } : BTN_GHOST}
        >
          Skip
        </button>

        {phase === 'idle' ? (
          <button
            onClick={onIngest}
            disabled={!hasInput}
            style={!hasInput ? BTN_PRIMARY_DISABLED : BTN_PRIMARY}
          >
            {primaryLabel}
            <svg width="9" height="12" viewBox="0 0 9 12" fill="none">
              <path d="M1 1L8 6L1 11" stroke="var(--accent-text)" strokeWidth="1.5" strokeLinecap="square"/>
            </svg>
          </button>
        ) : (
          <button disabled style={BTN_PRIMARY_DISABLED}>
            Saving…
          </button>
        )}
      </div>
    </div>
  );
}
