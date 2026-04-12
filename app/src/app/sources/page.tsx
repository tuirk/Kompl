// Disable static prerendering — reads from SQLite at runtime.
export const dynamic = 'force-dynamic';

/**
 * /sources — Browse all ingested sources.
 * SERVER component — badge styles are inlined (no client imports).
 */

import Link from 'next/link';
import { getAllSources, getDb, type SourceRow } from '../../lib/db';

function formatDate(iso: string): string {
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  if (isNaN(d.getTime())) return iso;
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

interface BadgeCfg {
  bg: string;
  border: string;
  color: string;
  label: string;
}

function getStatusBadge(source: SourceRow): BadgeCfg {
  if (source.status === 'archived') {
    return { bg: 'rgba(71,72,74,0.1)', border: 'rgba(71,72,74,0.2)', color: 'var(--fg-dim)', label: 'ARCHIVED' };
  }
  switch (source.compile_status) {
    case 'compiled':
      return { bg: 'rgba(71,72,74,0.1)', border: 'rgba(71,72,74,0.2)', color: 'var(--fg)', label: 'COMPILED' };
    case 'failed':
      return { bg: 'rgba(255,113,108,0.1)', border: 'rgba(255,113,108,0.2)', color: 'var(--danger)', label: 'FAILED' };
    case 'in_progress':
    case 'extracted':
      return { bg: 'rgba(137,240,203,0.1)', border: 'rgba(137,240,203,0.2)', color: 'var(--accent)', label: 'INDEXING' };
    default:
      return { bg: 'rgba(71,72,74,0.1)', border: 'rgba(71,72,74,0.2)', color: 'var(--fg-dim)', label: 'PENDING' };
  }
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

  // Shared column widths
  const COL = '120px 1fr 140px 100px';

  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '2rem 40px 5rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 24, letterSpacing: '1.8px', textTransform: 'uppercase', color: 'var(--fg)', margin: 0 }}>
            Sources
          </h1>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', letterSpacing: '0.5px', margin: '4px 0 0' }}>
            {activeCount} active · {total} total
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
        <div style={{ background: 'var(--bg-card)' }}>
          {/* Table header */}
          <div style={{ display: 'grid', gridTemplateColumns: COL, background: 'var(--bg-card-hover)', padding: '0 24px' }}>
            {['Date', 'Source', 'Status', 'Action'].map((col, i) => (
              <div key={col} style={{ padding: '16px 0', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 10, letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--fg-dim)', textAlign: i === 3 ? 'right' : 'left' }}>
                {col}
              </div>
            ))}
          </div>

          {/* Rows */}
          {withCounts.map((s) => {
            const badge = getStatusBadge(s);
            return (
              <div
                key={s.source_id}
                style={{ display: 'grid', gridTemplateColumns: COL, padding: '0 24px', borderTop: '1px solid rgba(71,72,74,0.1)', alignItems: 'center' }}
              >
                <div style={{ padding: '20px 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-secondary)' }}>
                  {formatDate(s.date_ingested)}
                </div>
                <div style={{ padding: '16px 0', minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 400, fontSize: 14, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.title}
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', marginTop: 2 }}>
                    {s.source_type}
                    {s.page_count > 0 ? ` · ${s.page_count} page${s.page_count !== 1 ? 's' : ''}` : ''}
                  </div>
                </div>
                <div style={{ padding: '17px 0' }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center',
                    padding: '2px 8px',
                    background: badge.bg, border: `1px solid ${badge.border}`,
                    fontFamily: 'var(--font-heading)', fontWeight: 700,
                    fontSize: 9, letterSpacing: '0.45px', textTransform: 'uppercase',
                    color: badge.color, whiteSpace: 'nowrap',
                  }}>
                    {badge.label}
                  </span>
                </div>
                <div style={{ padding: '20px 0', textAlign: 'right' }}>
                  <Link
                    href={`/source/${s.source_id}`}
                    style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 10, letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--fg-dim)', textDecoration: 'none' }}
                  >
                    View
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
