'use client';

/**
 * Client component for archive/unarchive and delete actions on a source page.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface SourceActionsProps {
  sourceId: string;
  currentStatus: string;
}

export default function SourceActions({ sourceId, currentStatus }: SourceActionsProps) {
  const router = useRouter();
  const [status, setStatus] = useState(currentStatus);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleArchiveToggle() {
    setBusy(true);
    const newStatus = status === 'active' ? 'archived' : 'active';
    await fetch(`/api/sources/${sourceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    setStatus(newStatus);
    setBusy(false);
  }

  async function handleDelete() {
    setBusy(true);
    await fetch(`/api/sources/${sourceId}`, { method: 'DELETE' });
    router.push('/sources');
  }

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
      <button
        onClick={() => void handleArchiveToggle()}
        disabled={busy}
        style={{
          padding: '0.45rem 1rem',
          borderRadius: 6,
          border: '1px solid var(--border)',
          background: 'var(--bg-card)',
          cursor: busy ? 'not-allowed' : 'pointer',
          fontSize: '0.875rem',
          color: 'var(--fg-muted)',
        }}
      >
        {status === 'active' ? 'Archive' : 'Unarchive'}
      </button>

      {!confirmDelete ? (
        <button
          onClick={() => setConfirmDelete(true)}
          disabled={busy}
          style={{
            padding: '0.45rem 1rem',
            borderRadius: 6,
            border: '1px solid var(--danger, #ef4444)',
            background: 'transparent',
            cursor: busy ? 'not-allowed' : 'pointer',
            fontSize: '0.875rem',
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
              padding: '0.45rem 1rem',
              borderRadius: 6,
              border: 'none',
              background: 'var(--danger, #ef4444)',
              cursor: busy ? 'not-allowed' : 'pointer',
              fontSize: '0.875rem',
              color: '#fff',
              fontWeight: 600,
            }}
          >
            Confirm delete
          </button>
          <button
            onClick={() => setConfirmDelete(false)}
            style={{
              padding: '0.45rem 1rem',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: '0.875rem',
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
