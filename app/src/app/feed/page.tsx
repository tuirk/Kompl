'use client';

/**
 * /feed — Full activity log, no row limit.
 * Polls /api/activity via the shared ActivityTable component.
 */

import Link from 'next/link';
import { ActivityTable } from '@/components/ActivityTable';

export default function FeedPage() {
  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '2rem 40px calc(5rem + 32px)' }}>

      {/* Back link */}
      <a
        href="/"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontFamily: 'var(--font-mono)', fontSize: 10,
          textTransform: 'uppercase', letterSpacing: '1px',
          color: 'var(--fg-dim)', textDecoration: 'none',
          marginBottom: 24,
        }}
      >
        ← Dashboard
      </a>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 }}>
        <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 24, letterSpacing: '1.8px', textTransform: 'uppercase', color: 'var(--fg)', margin: 0 }}>
          All Activity
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <Link
            href="/sessions"
            style={{
              fontFamily: 'var(--font-mono)', fontSize: 10,
              textTransform: 'uppercase', letterSpacing: '1px',
              color: 'var(--accent)', textDecoration: 'none',
              border: '1px solid var(--accent)',
              padding: '6px 14px',
            }}
          >
            Sessions →
          </Link>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', letterSpacing: '0.5px' }}>
            [ Refresh Interval: 2s ]
          </span>
        </div>
      </div>

      <ActivityTable pollInterval={2000} />
    </main>
  );
}
