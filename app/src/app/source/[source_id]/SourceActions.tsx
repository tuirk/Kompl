'use client';

/**
 * Client component for archive/unarchive, delete, and re-compile actions on a
 * source page.
 *
 * Re-compile button is visible for any source not yet fully active:
 *   - enabled:  compile_status IN (failed, pending, in_progress, extracted, collected)
 *   - disabled: compile_status = 'active'  — shown as "Active ✓"
 *   - hidden:   compile_status is null (source never entered compile pipeline)
 *
 * On success, stores session_id in localStorage (triggers ActiveCompileBanner
 * on the dashboard) and redirects to the progress page.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface SourceActionsProps {
  sourceId: string;
  currentStatus: string;
  compileStatus: string | null;
  sessionId: string | null;
}

const BTN: React.CSSProperties = {
  padding: '0.45rem 1rem',
  borderRadius: 6,
  fontSize: '0.875rem',
  cursor: 'pointer',
};

export default function SourceActions({
  sourceId,
  currentStatus,
  compileStatus,
  sessionId,
}: SourceActionsProps) {
  const router = useRouter();
  const [status, setStatus] = useState(currentStatus);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [recompileState, setRecompileState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');

  async function handleArchiveToggle() {
    setBusy(true);
    const newStatus = status === 'active' ? 'archived' : 'active';
    const res = await fetch(`/api/sources/${sourceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    if (res.ok) setStatus(newStatus);
    setBusy(false);
  }

  async function handleDelete() {
    setBusy(true);
    const res = await fetch(`/api/sources/${sourceId}`, { method: 'DELETE' });
    if (res.ok) {
      router.push('/sources');
    } else {
      setBusy(false);
    }
  }

  async function handleRecompile() {
    setRecompileState('loading');
    try {
      const res = await fetch(`/api/sources/${sourceId}/recompile`, { method: 'POST' });
      if (!res.ok && res.status !== 409) throw new Error(`${res.status}`);
      const body = (await res.json()) as { session_id?: string | null; status?: string };
      const sid = body.session_id ?? sessionId;
      if (sid) {
        localStorage.setItem('kompl_active_compile', JSON.stringify({ session_id: sid, source_count: 0 }));
        setRecompileState('done');
        router.push(`/onboarding/progress?session_id=${encodeURIComponent(sid)}`);
      } else {
        // Standalone source (no session) — stay on page, show confirmation
        setRecompileState('done');
        setTimeout(() => setRecompileState('idle'), 3000);
      }
    } catch {
      setRecompileState('error');
      setTimeout(() => setRecompileState('idle'), 3000);
    }
  }

  // Determine re-compile button visibility and state
  const showRecompile = compileStatus !== null;
  const recompileDisabled = compileStatus === 'active';

  return (
    <div
      style={{
        display: 'flex',
        gap: '0.75rem',
        marginTop: '2rem',
        paddingTop: '1.25rem',
        borderTop: '1px solid var(--border)',
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      {/* Re-compile button */}
      {showRecompile && (
        recompileDisabled ? (
          <button
            disabled
            style={{
              ...BTN,
              border: '1px solid var(--border)',
              background: 'var(--bg-card)',
              color: 'var(--fg-dim)',
              cursor: 'not-allowed',
              opacity: 0.5,
            }}
          >
            Active ✓
          </button>
        ) : (
          <button
            onClick={() => void handleRecompile()}
            disabled={recompileState === 'loading' || recompileState === 'done'}
            style={{
              ...BTN,
              border: '1px solid rgba(var(--accent-rgb),0.4)',
              background: 'rgba(var(--accent-rgb),0.07)',
              color: recompileState === 'error' ? 'var(--danger)' : 'var(--accent)',
              cursor: recompileState === 'loading' || recompileState === 'done' ? 'default' : 'pointer',
              opacity: recompileState === 'loading' ? 0.6 : 1,
              transition: 'var(--transition-fast)',
            }}
          >
            {recompileState === 'loading' ? 'Queuing…'
              : recompileState === 'done'  ? 'Queued ✓'
              : recompileState === 'error' ? 'Failed — try again'
              : '↻ Re-compile'}
          </button>
        )
      )}

      {/* Archive / Unarchive */}
      <button
        onClick={() => void handleArchiveToggle()}
        disabled={busy}
        style={{
          ...BTN,
          border: '1px solid var(--border)',
          background: 'var(--bg-card)',
          cursor: busy ? 'not-allowed' : 'pointer',
          color: 'var(--fg-muted)',
        }}
      >
        {status === 'active' ? 'Archive' : 'Unarchive'}
      </button>

      {/* Delete */}
      {!confirmDelete ? (
        <button
          onClick={() => setConfirmDelete(true)}
          disabled={busy}
          style={{
            ...BTN,
            border: '1px solid var(--danger, #ef4444)',
            background: 'transparent',
            cursor: busy ? 'not-allowed' : 'pointer',
            color: 'var(--danger, #ef4444)',
          }}
        >
          Delete
        </button>
      ) : (
        <>
          <span style={{ fontSize: '0.875rem', color: 'var(--fg-muted)' }}>
            Delete this source and cascade-archive orphaned pages?
          </span>
          <button
            onClick={() => void handleDelete()}
            disabled={busy}
            style={{
              ...BTN,
              border: 'none',
              background: 'var(--danger, #ef4444)',
              cursor: busy ? 'not-allowed' : 'pointer',
              color: 'var(--fg)',
              fontWeight: 600,
            }}
          >
            Confirm delete
          </button>
          <button
            onClick={() => setConfirmDelete(false)}
            style={{
              ...BTN,
              border: '1px solid var(--border)',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--fg-muted)',
            }}
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
