'use client';

import { useCallback, useState } from 'react';

interface RetryButtonProps {
  sourceId: string;
}

export function RetryButton({ sourceId }: RetryButtonProps) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');

  const handleRetry = useCallback(async () => {
    setState('loading');
    try {
      const res = await fetch(`/api/sources/${sourceId}/recompile`, { method: 'POST' });
      if (!res.ok && res.status !== 409) throw new Error(`${res.status}`);
      const body = (await res.json()) as { session_id?: string | null };
      if (body.session_id) {
        localStorage.setItem('kompl_active_compile', JSON.stringify({ session_id: body.session_id, source_count: 0 }));
      }
      setState('done');
    } catch {
      setState('error');
      setTimeout(() => setState('idle'), 3000);
    }
  }, [sourceId]);

  const base: React.CSSProperties = {
    fontFamily: 'var(--font-body)',
    fontWeight: 700,
    fontSize: 10,
    letterSpacing: '1px',
    textTransform: 'uppercase',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    padding: 0,
    transition: 'var(--transition-fast)',
  };

  if (state === 'done') {
    return <span style={{ ...base, color: 'var(--accent)', cursor: 'default' }}>QUEUED</span>;
  }
  if (state === 'error') {
    return <span style={{ ...base, color: 'var(--danger)', cursor: 'default' }}>ERR</span>;
  }
  return (
    <button
      onClick={handleRetry}
      disabled={state === 'loading'}
      style={{ ...base, color: state === 'loading' ? 'var(--fg-dim)' : 'var(--danger)', opacity: state === 'loading' ? 0.5 : 1 }}
    >
      {state === 'loading' ? '…' : '↻'}
    </button>
  );
}
