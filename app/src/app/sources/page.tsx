// Disable static prerendering — reads from SQLite at runtime.
export const dynamic = 'force-dynamic';

/**
 * /sources — Browse all ingested sources with filtering and sorting.
 * SERVER component.
 */

import Link from 'next/link';
import { getAllSources, getDb, type SourceRow } from '../../lib/db';

const SOURCE_TYPE_ICON: Record<string, string> = {
  url: '🔗',
  file: '📄',
  tweet: '🐦',
  text: '📝',
  bookmarks: '🔖',
  upnote: '📓',
};

function formatDate(iso: string): string {
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

interface SourceWithCount extends SourceRow {
  page_count: number;
}

export default async function SourcesPage() {
  const sources = getAllSources({ sort_by: 'date_ingested', sort_order: 'desc', limit: 500 });
  const db = getDb();

  const withCounts: SourceWithCount[] = sources.map((s) => {
    const row = db
      .prepare('SELECT COUNT(DISTINCT page_id) AS n FROM provenance WHERE source_id = ?')
      .get(s.source_id) as { n: number };
    return { ...s, page_count: row.n };
  });

  const total = sources.length;
  const activeCount = sources.filter((s) => s.status === 'active').length;

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: '3rem 1.5rem 5rem' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: '2rem',
        }}
      >
        <div>
          <Link href="/" style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
            ← Dashboard
          </Link>
          <h1 style={{ margin: '0.5rem 0 0', fontSize: '1.6rem' }}>
            Sources{' '}
            <span style={{ fontSize: '1rem', fontWeight: 400, color: 'var(--fg-muted)' }}>
              ({activeCount} active, {total} total)
            </span>
          </h1>
        </div>
        <Link
          href="/onboarding?mode=add"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.55rem 1.2rem',
            borderRadius: 6,
            background: 'var(--accent)',
            color: '#fff',
            fontWeight: 600,
            fontSize: '0.9rem',
            textDecoration: 'none',
          }}
        >
          + Add Sources
        </Link>
      </header>

      {withCounts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem 0', color: 'var(--fg-muted)' }}>
          <p style={{ fontSize: '1rem', marginBottom: '1rem' }}>No sources ingested yet.</p>
          <Link href="/onboarding" style={{ color: 'var(--accent)' }}>
            Add your first source →
          </Link>
        </div>
      ) : (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          {withCounts.map((s, i) => (
            <Link
              key={s.source_id}
              href={`/source/${s.source_id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.9rem 1.25rem',
                borderTop: i > 0 ? '1px solid var(--border)' : 'none',
                background: 'transparent',
                textDecoration: 'none',
                color: 'inherit',
              }}
            >
              <span style={{ fontSize: 18, flexShrink: 0, width: 24, textAlign: 'center' }}>
                {SOURCE_TYPE_ICON[s.source_type] ?? '📄'}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 500,
                    fontSize: '0.9rem',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    color: 'var(--fg)',
                  }}
                >
                  {s.title}
                </div>
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                  {s.page_count > 0 ? `→ ${s.page_count} page${s.page_count !== 1 ? 's' : ''}` : 'not compiled'}
                  {' · '}
                  <span
                    style={{
                      padding: '0.1em 0.4em',
                      borderRadius: 3,
                      fontSize: 11,
                      background: s.status === 'active' ? 'var(--success-bg, #ecfdf5)' : 'var(--bg-card)',
                      color: s.status === 'active' ? 'var(--success, #059669)' : 'var(--fg-dim)',
                      border: `1px solid ${s.status === 'active' ? 'var(--success-border, #a7f3d0)' : 'var(--border)'}`,
                    }}
                  >
                    {s.status}
                  </span>
                </div>
              </div>
              <div
                style={{
                  flexShrink: 0,
                  fontSize: 12,
                  color: 'var(--fg-dim)',
                  textAlign: 'right',
                }}
              >
                <div>{s.source_type}</div>
                <div>{formatDate(s.date_ingested)}</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
