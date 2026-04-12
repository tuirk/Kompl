'use client';

/**
 * /settings — App settings page.
 *
 * Settings:
 *   - auto_approve   — commit wiki changes immediately vs. queue as drafts
 *   - chat_provider  — 'gemini' (API key, ~$0.001/turn) or 'ollama' (local, free)
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function SettingsPage() {
  const [autoApprove, setAutoApprove] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [chatProvider, setChatProviderState] = useState<'gemini' | 'ollama' | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerSaved, setProviderSaved] = useState(false);

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((data: { auto_approve: boolean; chat_provider: 'gemini' | 'ollama' }) => {
        setAutoApprove(data.auto_approve);
        setChatProviderState(data.chat_provider);
      });
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

  async function toggleProvider(next: 'gemini' | 'ollama') {
    if (chatProvider === null || providerSaving || chatProvider === next) return;
    setProviderSaving(true);
    setProviderSaved(false);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_provider: next }),
    });
    setChatProviderState(next);
    setProviderSaving(false);
    setProviderSaved(true);
    setTimeout(() => setProviderSaved(false), 2000);
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

      <section
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
          marginTop: '1rem',
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
              Chat agent provider
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.5 }}>
              <strong>Gemini</strong> (default) uses Gemini 2.5 Flash — requires an API key,
              costs ~$0.001 per chat turn.{' '}
              <strong>Ollama</strong> runs llama3.2:3b locally — free, CPU-only, ~10 tok/s
              (first boot downloads ~2 GB). Compile-time LLM calls always use Gemini.
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
            {(['gemini', 'ollama'] as const).map((p) => (
              <button
                key={p}
                onClick={() => void toggleProvider(p)}
                disabled={chatProvider === null || providerSaving}
                style={{
                  padding: '0.45rem 1rem',
                  borderRadius: 20,
                  border: chatProvider === p ? 'none' : '1px solid var(--border)',
                  cursor:
                    chatProvider === null || providerSaving || chatProvider === p
                      ? 'not-allowed'
                      : 'pointer',
                  background: chatProvider === p ? 'var(--accent, #0070f3)' : 'var(--bg-card)',
                  color: chatProvider === p ? '#fff' : 'var(--fg-muted)',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  opacity: chatProvider === null ? 0.5 : 1,
                  transition: 'background 0.15s',
                  textTransform: 'capitalize',
                }}
              >
                {chatProvider === null ? '…' : p}
              </button>
            ))}
          </div>
        </div>
        {providerSaved && (
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
    </main>
  );
}
