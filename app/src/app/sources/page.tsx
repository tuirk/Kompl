// Disable static prerendering — reads from SQLite at runtime.
export const dynamic = 'force-dynamic';

/**
 * /sources — Browse all ingested sources.
 * SERVER component — fetches data and passes to SourcesTable client component.
 */

import Link from 'next/link';
import { getAllSources, getDb } from '../../lib/db';
import SourcesTable, { type SourceWithCount } from './SourcesTable';

export default async function SourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ older_than?: string }>;
}) {
  const params = await searchParams;
  const olderThan = params.older_than ? parseInt(params.older_than, 10) : null;

  const sources = getAllSources({ sort_by: 'date_ingested', sort_order: 'desc', limit: 500 });
  const db = getDb();

  const withCounts: SourceWithCount[] = sources
    .filter((s) => {
      if (!olderThan || olderThan <= 0) return true;
      const ingestedMs = new Date(s.date_ingested.replace(' ', 'T') + 'Z').getTime();
      const daysOld = (Date.now() - ingestedMs) / 86_400_000;
      return daysOld > olderThan;
    })
    .map((s) => {
      const row = db
        .prepare('SELECT COUNT(DISTINCT page_id) AS n FROM provenance WHERE source_id = ?')
        .get(s.source_id) as { n: number };
      return { ...s, page_count: row.n };
    });

  const total = sources.length;
  const activeCount = sources.filter((s) => s.status === 'active').length;

  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '2rem 40px 5rem' }}>
      {/* Back link */}
      <Link
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
      </Link>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 24, letterSpacing: '1.8px', textTransform: 'uppercase', color: 'var(--fg)', margin: 0 }}>
            Sources
          </h1>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', letterSpacing: '0.5px', margin: '4px 0 0' }}>
            {olderThan && olderThan > 0
              ? <>{withCounts.length} stale (older than {olderThan} days) · <a href="/sources" style={{ color: 'var(--fg-dim)', textDecoration: 'underline' }}>show all</a></>
              : <>{activeCount} active · {total} total</>
            }
          </p>
        </div>
        <Link
          href="/onboarding?mode=add"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '10px 20px',
            background: 'var(--accent)',
            fontFamily: 'var(--font-heading)',
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: '1px',
            textTransform: 'uppercase',
            color: 'var(--accent-text)',
            textDecoration: 'none',
          }}
        >
          + Add Sources
        </Link>
      </div>

      {withCounts.length === 0 ? (
        <p style={{ color: 'var(--fg-dim)', fontFamily: 'var(--font-mono)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>No sources yet.</p>
      ) : (
        <SourcesTable initialSources={withCounts} />
      )}
    </main>
  );
}
