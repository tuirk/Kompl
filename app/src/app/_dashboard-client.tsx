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
import { ActivityTable } from '@/components/ActivityTable';

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
        <Link href="/wiki">View Wiki →</Link>
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
          <Link href="/feed" style={{ fontSize: '0.9rem', color: 'var(--fg-muted)' }}>
            View all →
          </Link>
        </div>
        <ActivityTable limit={50} />
      </section>

      {/* Pending Drafts — placeholder until Part 2c */}
      <section>
        <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.75rem' }}>
          Pending Drafts
        </h2>
        <p style={{ color: 'var(--fg-muted)', fontSize: '0.9rem', margin: 0 }}>
          Draft approval will appear here once your wiki is compiled.
        </p>
      </section>

    </main>
  );
}
