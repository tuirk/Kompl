'use client';

/**
 * A page action that asks before it runs (Restore previous version).
 * POSTs to `endpoint`, then refreshes the page; errors show the route's
 * message.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface PageActionButtonProps {
  endpoint: string;
  label: string;
  busyLabel: string;
  confirmText: string;
  confirmLabel: string;
  /** When set, the button is disabled and this explains why. */
  disabledReason?: string | null;
}

const BUTTON = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  padding: '0.25em 0.75em',
  borderRadius: 999,
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--fg-secondary)',
  cursor: 'pointer',
} as const;

export default function PageActionButton({
  endpoint,
  label,
  busyLabel,
  confirmText,
  confirmLabel,
  disabledReason,
}: PageActionButtonProps) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setState('busy');
    setError(null);
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setState('idle');
      if (!res.ok) {
        setError(body.message ?? `Failed (HTTP ${res.status}).`);
        return;
      }
      router.refresh();
    } catch {
      setState('idle');
      setError('Could not reach Kompl. Try again.');
    }
  }

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem' }}>
      {state === 'confirm' ? (
        <span
          role="dialog"
          aria-label={label}
          style={{
            maxWidth: 380,
            padding: '0.75rem 1rem',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg-card)',
            color: 'var(--fg-secondary)',
            fontSize: 13,
            lineHeight: 1.5,
            textAlign: 'left',
          }}
        >
          {confirmText}
          <span style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
            <button type="button" style={BUTTON} onClick={() => setState('idle')}>
              Cancel
            </button>
            <button
              type="button"
              style={{ ...BUTTON, borderColor: 'var(--accent)', color: 'var(--accent)' }}
              onClick={run}
            >
              {confirmLabel}
            </button>
          </span>
        </span>
      ) : (
        <button
          type="button"
          style={{
            ...BUTTON,
            opacity: disabledReason || state === 'busy' ? 0.6 : 1,
            cursor: disabledReason || state === 'busy' ? 'default' : 'pointer',
          }}
          disabled={Boolean(disabledReason) || state === 'busy'}
          title={disabledReason ?? undefined}
          onClick={() => setState('confirm')}
        >
          {state === 'busy' ? busyLabel : label}
        </button>
      )}
      {error && (
        <span role="status" aria-live="polite" style={{ color: 'var(--danger)', fontSize: 12, maxWidth: 380, textAlign: 'right' }}>
          {error}
        </span>
      )}
    </span>
  );
}
