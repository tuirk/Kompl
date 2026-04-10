'use client';

/**
 * /settings — App settings page.
 *
 * Currently: auto-approve toggle.
 * Future: LLM provider, entity expansion, schema preferences.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function SettingsPage() {
  const [autoApprove, setAutoApprove] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((data: { auto_approve: boolean }) => setAutoApprove(data.auto_approve));
  }, []);

  async function toggle() {
    if (autoApprove === null) return;
    const newVal = !autoApprove;
    setSaving(true);
    setSaved(false);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_approve: newVal }),
    });
    setAutoApprove(newVal);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <main style={{ maxWidth: 680, margin: '0 auto', padding: '3rem 1.5rem 5rem' }}>
      <div style={{ marginBottom: '2rem' }}>
        <Link href="/" style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          ← Dashboard
        </Link>
        <h1 style={{ margin: '0.5rem 0 0', fontSize: '1.6rem' }}>Settings</h1>
      </div>

      <section
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '1.25rem 1.5rem',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '1.5rem',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.35rem' }}>
              Auto-approve wiki changes
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.5 }}>
              When enabled, compiled pages are committed immediately to the wiki.
              When disabled, changes appear as drafts on your dashboard for review before publishing.
            </div>
          </div>
          <button
            onClick={() => void toggle()}
            disabled={autoApprove === null || saving}
            style={{
              flexShrink: 0,
              padding: '0.45rem 1rem',
              borderRadius: 20,
              border: autoApprove ? 'none' : '1px solid var(--border)',
              cursor: autoApprove === null || saving ? 'not-allowed' : 'pointer',
              background: autoApprove ? 'var(--accent, #0070f3)' : 'var(--bg-card)',
              color: autoApprove ? '#fff' : 'var(--fg-muted)',
              fontWeight: 600,
              fontSize: '0.85rem',
              opacity: autoApprove === null ? 0.5 : 1,
              transition: 'background 0.15s',
              minWidth: 80,
            }}
          >
            {autoApprove === null ? '…' : autoApprove ? 'ON' : 'OFF'}
          </button>
        </div>
        {saved && (
          <div
            style={{
              padding: '0.6rem 1.5rem',
              background: 'var(--success-bg, #ecfdf5)',
              borderTop: '1px solid var(--success-border, #a7f3d0)',
              color: 'var(--success, #059669)',
              fontSize: 13,
            }}
          >
            Saved.
          </div>
        )}
      </section>

      <section style={{ marginTop: '2rem' }}>
        <div
          style={{
            padding: '1.25rem 1.5rem',
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--bg-card)',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.35rem', color: 'var(--fg-muted)' }}>
            Entity expansion
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--fg-dim)', lineHeight: 1.5 }}>
            Automatic entity stub generation during compile. Configured via the{' '}
            <code>entity_expansion_enabled</code> settings key.
            Toggle via the database directly or the admin panel (coming in commit 10).
          </div>
        </div>
      </section>
    </main>
  );
}
