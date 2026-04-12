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
  mode?: string;
}

// ── Navigation ────────────────────────────────────────────────────────────────

export function navigateNext(
  sessionId: string,
  connectors: string[],
  connectorIdx: number,
  router: AppRouterInstance,
  mode?: string,
) {
  const nextIdx = connectorIdx + 1;
  const modeParam = mode === 'add' ? '&mode=add' : '';
  if (nextIdx >= connectors.length) {
    router.push(`/onboarding/review?session_id=${encodeURIComponent(sessionId)}${modeParam}`);
  } else {
    sessionStorage.setItem('kompl_connector_idx', String(nextIdx));
    router.push(`/onboarding/${connectors[nextIdx]}?session_id=${encodeURIComponent(sessionId)}${modeParam}`);
  }
}

export function navigateBack(
  sessionId: string,
  connectors: string[],
  connectorIdx: number,
  router: AppRouterInstance,
  mode?: string,
) {
  const modeParam = mode === 'add' ? '&mode=add' : '';
  if (connectorIdx <= 0) {
    // First connector — go back to selector
    router.push(`/onboarding${mode === 'add' ? '?mode=add' : ''}`);
  } else {
    // Go to previous connector
    const prevIdx = connectorIdx - 1;
    sessionStorage.setItem('kompl_connector_idx', String(prevIdx));
    router.push(`/onboarding/${connectors[prevIdx]}?session_id=${encodeURIComponent(sessionId)}${modeParam}`);
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
  background: 'rgba(137,240,203,0.2)',
  cursor: 'not-allowed',
};

export const BTN_GHOST: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '16px 32px',
  background: 'transparent', border: '1px solid #47484A', cursor: 'pointer',
  fontFamily: 'var(--font-mono)', fontWeight: 400, fontSize: 10,
  lineHeight: '15px', letterSpacing: '1px', textTransform: 'uppercase',
  color: 'var(--fg)',
};

// ── BottomNav ─────────────────────────────────────────────────────────────────

export function BottomNav({
  phase,
  hasInput,
  onIngest,
  onSkip,
  onContinue,
  onBack,
}: {
  phase: 'idle' | 'loading' | 'done';
  hasInput: boolean;
  onIngest: () => void;
  onSkip: () => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  return (
    <div style={{ marginTop: 48, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
          <path d="M8 4.5H1M1 4.5L4.5 1M1 4.5L4.5 8" stroke="#ABABAD" strokeWidth="1.2" strokeLinecap="square"/>
        </svg>
        Back
      </button>

      {/* Right: skip + primary action */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 16 }}>
        {phase !== 'done' && (
          <button
            onClick={onSkip}
            disabled={phase === 'loading'}
            style={phase === 'loading' ? { ...BTN_GHOST, opacity: 0.4, cursor: 'not-allowed' } : BTN_GHOST}
          >
            Skip
          </button>
        )}

        {phase === 'idle' && (
          <button
            onClick={onIngest}
            disabled={!hasInput}
            style={!hasInput ? BTN_PRIMARY_DISABLED : BTN_PRIMARY}
          >
            Save &amp; Continue
            <svg width="9" height="12" viewBox="0 0 9 12" fill="none">
              <path d="M1 1L8 6L1 11" stroke="#005A44" strokeWidth="1.5" strokeLinecap="square"/>
            </svg>
          </button>
        )}

        {phase === 'loading' && (
          <button disabled style={BTN_PRIMARY_DISABLED}>
            Saving…
          </button>
        )}

        {phase === 'done' && (
          <button onClick={onContinue} style={BTN_PRIMARY}>
            Continue
            <svg width="9" height="12" viewBox="0 0 9 12" fill="none">
              <path d="M1 1L8 6L1 11" stroke="#005A44" strokeWidth="1.5" strokeLinecap="square"/>
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
