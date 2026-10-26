'use client';

/**
 * The owner's verdict on one disagreement in the page panel: Confirm or
 * Dismiss while it is possible, Undo once decided. POSTs to
 * /api/disagreements/[id]/verdict, then refreshes the page. A later compile
 * never overwrites the verdict (lib/disagreements.ts).
 */

import { useRouter } from 'next/navigation';
import { useState, type CSSProperties } from 'react';

type Status = 'possible' | 'confirmed' | 'dismissed';

const BUTTON: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  lineHeight: '16px',
  padding: '0 0.5em',
  borderRadius: 999,
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--fg-dim)',
  cursor: 'pointer',
};

const DONE: Record<Exclude<Status, 'possible'>, string> = {
  confirmed: 'Confirmed by you',
  dismissed: 'Dismissed by you',
};

export default function DisagreementVerdict({ id, status, topic }: { id: string; status: Status; topic: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(verdict: Exclude<Status, 'possible'> | null) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/disagreements/${encodeURIComponent(id)}/verdict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? `Failed (HTTP ${res.status}).`);
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach Kompl. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 }}>
      {status === 'possible' ? (
        <>
          <button
            type="button"
            style={BUTTON}
            disabled={busy}
            onClick={() => send('confirmed')}
            aria-label={`Confirm the disagreement: ${topic}`}
          >
            Confirm
          </button>
          <button
            type="button"
            style={BUTTON}
            disabled={busy}
            onClick={() => send('dismissed')}
            aria-label={`Dismiss the disagreement: ${topic}`}
          >
            Dismiss
          </button>
        </>
      ) : (
        <>
          <span style={{ fontSize: 11, color: status === 'confirmed' ? 'var(--accent)' : 'var(--fg-dim)' }}>{DONE[status]}</span>
          <button
            type="button"
            style={BUTTON}
            disabled={busy}
            onClick={() => send(null)}
            aria-label={`Undo your verdict on: ${topic}`}
          >
            Undo
          </button>
        </>
      )}
      {error && (
        <span role="status" aria-live="polite" style={{ fontSize: 11, color: 'var(--danger)' }}>
          {error}
        </span>
      )}
    </span>
  );
}
