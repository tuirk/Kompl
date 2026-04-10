'use client';

/**
 * DashboardClient — returning-user dashboard rendered by the root page.
 *
 * Sections:
 *   1. Header: "Kompl" + "View Wiki →"
 *   2. Quick Actions: "+ Add Sources" and "Browse Wiki →"
 *   3. Recent Activity: last 50 items via ActivityTable
 *   4. Pending Drafts: placeholder (wired in Part 2c)
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ActivityTable } from '@/components/ActivityTable';

interface DraftRow {
  plan_id: string;
  title: string;
  page_type: string;
  action: string;
  session_id: string;
  draft_content_preview: string | null;
  created_at: string;
}

function PendingDrafts() {
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/drafts/pending')
      .then((r) => r.json())
      .then((data: { drafts: DraftRow[] }) => setDrafts(data.drafts));
  }, []);

  async function approve(planId: string) {
    setBusy(planId);
    await fetch(`/api/drafts/${planId}/approve`, { method: 'POST' });
    setDrafts((prev) => prev.filter((d) => d.plan_id !== planId));
    setBusy(null);
  }

  async function reject(planId: string) {
    setBusy(planId);
    await fetch(`/api/drafts/${planId}/reject`, { method: 'POST' });
    setDrafts((prev) => prev.filter((d) => d.plan_id !== planId));
    setBusy(null);
  }

  if (drafts.length === 0) {
    return (
      <p style={{ color: 'var(--fg-muted)', fontSize: '0.9rem', margin: 0 }}>
        No pending drafts.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {drafts.map((d) => (
        <div
          key={d.plan_id}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '0.9rem 1.1rem',
            background: 'var(--bg-card)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: '0.9rem', marginBottom: '0.25rem' }}>{d.title}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                {d.page_type}
                {d.action !== 'create' ? ` · ${d.action}` : ''}
                {d.session_id.startsWith('chat-') ? ' · from chat' : ''}
              </div>
              {d.draft_content_preview && (
                <div
                  style={{
                    marginTop: '0.4rem',
                    fontSize: 12,
                    color: 'var(--fg-dim)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {d.draft_content_preview}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
              <button
                onClick={() => void approve(d.plan_id)}
                disabled={busy === d.plan_id}
                style={{
                  padding: '0.35rem 0.8rem',
                  borderRadius: 6,
                  border: 'none',
                  background: 'var(--success, #059669)',
                  color: '#fff',
                  cursor: busy === d.plan_id ? 'not-allowed' : 'pointer',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                }}
              >
                ✓ Approve
              </button>
              <button
                onClick={() => void reject(d.plan_id)}
                disabled={busy === d.plan_id}
                style={{
                  padding: '0.35rem 0.8rem',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'transparent',
                  cursor: busy === d.plan_id ? 'not-allowed' : 'pointer',
                  fontSize: '0.8rem',
                  color: 'var(--fg-muted)',
                }}
              >
                ✗ Reject
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function DashboardClient() {
  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '3rem 1.5rem 5rem' }}>

      {/* Header */}
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: '2.5rem',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1.8rem' }}>Kompl</h1>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <Link href="/settings" style={{ fontSize: '0.875rem', color: 'var(--fg-muted)' }}>⚙ Settings</Link>
          <Link href="/wiki">View Wiki →</Link>
        </div>
      </header>

      {/* Quick Actions */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '3rem', flexWrap: 'wrap' }}>
        <Link
          href="/onboarding?mode=add"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.7rem 1.5rem',
            borderRadius: 6,
            background: 'var(--accent)',
            color: '#fff',
            textDecoration: 'none',
            fontWeight: 600,
            fontSize: '0.95rem',
          }}
        >
          + Add Sources
        </Link>
        <Link
          href="/chat"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '0.7rem 1.5rem',
            borderRadius: 6,
            border: '1px solid #b2dfcc',
            background: '#f0faf4',
            color: '#1a7a4a',
            textDecoration: 'none',
            fontSize: '0.95rem',
          }}
        >
          Ask your wiki →
        </Link>
        <Link
          href="/wiki"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '0.7rem 1.5rem',
            borderRadius: 6,
            border: '1px solid var(--border)',
            color: 'var(--fg)',
            textDecoration: 'none',
            fontSize: '0.95rem',
          }}
        >
          Browse Wiki →
        </Link>
      </div>

      {/* Recent Activity */}
      <section style={{ marginBottom: '3rem' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            marginBottom: '1rem',
          }}
        >
          <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Recent Activity</h2>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <Link href="/sources" style={{ fontSize: '0.9rem', color: 'var(--fg-muted)' }}>
              View all sources →
            </Link>
            <Link href="/feed" style={{ fontSize: '0.9rem', color: 'var(--fg-muted)' }}>
              View all activity →
            </Link>
          </div>
        </div>
        <ActivityTable limit={50} />
      </section>

      {/* Pending Drafts */}
      <section>
        <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.75rem' }}>
          Pending Drafts
        </h2>
        <PendingDrafts />
      </section>

    </main>
  );
}
