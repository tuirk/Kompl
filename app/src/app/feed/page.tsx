'use client';

/**
 * /feed — Full activity log, no row limit.
 * Polls /api/activity via the shared ActivityTable component.
 */

import Link from 'next/link';
import { ActivityTable } from '@/components/ActivityTable';

export default function FeedPage() {
  return (
    <main
      style={{
        maxWidth: 880,
        margin: '0 auto',
        padding: '3rem 1.5rem 5rem',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: '2rem',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1.8rem' }}>Activity Feed</h1>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <Link href="/wiki">Browse wiki →</Link>
          <Link href="/">← Dashboard</Link>
        </div>
      </header>

      <ActivityTable />
    </main>
  );
}
