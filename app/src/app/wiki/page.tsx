// Disable static prerendering — reads from SQLite which only exists at runtime.
export const dynamic = 'force-dynamic';

/**
 * /wiki — Wiki index page. SERVER component.
 *
 * Shows all compiled wiki pages grouped by category.
 * Mirrors Karpathy's index.md concept — the browsable map of all knowledge.
 */

import Link from 'next/link';
import { getCategoryGroups } from '../../lib/db';
import WikiSidebar from '../../components/WikiSidebar';

function formatDate(iso: string): string {
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const PAGE_TYPE_BADGE: Record<string, { label: string; color: string }> = {
  'source-summary': { label: 'source', color: 'var(--fg-dim)' },
  concept: { label: 'concept', color: 'var(--accent)' },
  entity: { label: 'entity', color: 'var(--warning)' },
  topic: { label: 'topic', color: 'var(--success)' },
};

export default function WikiIndexPage() {
  const groups = getCategoryGroups();
  const totalPages = groups.reduce((n, g) => n + g.pages.length, 0);

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <WikiSidebar groups={groups} />

      <main style={{ flex: 1, padding: '2rem 2.5rem', maxWidth: 860 }}>
        <header style={{ marginBottom: '2rem' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h1 style={{ margin: 0, fontSize: '1.6rem' }}>Wiki</h1>
            <div style={{ display: 'flex', gap: '1rem', fontSize: 13, color: 'var(--fg-muted)' }}>
              <span>{totalPages} pages</span>
              <Link href="/wiki/graph">Graph view →</Link>
              <Link href="/wiki/search">Search</Link>
            </div>
          </div>
          <p style={{ color: 'var(--fg-muted)', fontSize: 14, margin: '0.5rem 0 0' }}>
            Compiled knowledge base. Each page is LLM-synthesized from ingested sources.
          </p>
        </header>

        {groups.length === 0 ? (
          <div
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '2rem',
              textAlign: 'center',
              color: 'var(--fg-muted)',
            }}
          >
            <p style={{ margin: '0 0 0.5rem', fontSize: 15 }}>No pages compiled yet.</p>
            <p style={{ margin: 0, fontSize: 14 }}>
              <Link href="/">Add a source</Link> to start building the wiki.
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.category} style={{ marginBottom: '2.5rem' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: '0.75rem',
                  marginBottom: '0.75rem',
                  paddingBottom: '0.5rem',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>{group.category}</h2>
                <span style={{ fontSize: 12, color: 'var(--fg-dim)' }}>
                  {group.pages.length} page{group.pages.length !== 1 ? 's' : ''}
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {group.pages.map((page) => {
                  const badge = PAGE_TYPE_BADGE[page.page_type];
                  return (
                    <Link
                      key={page.page_id}
                      href={`/wiki/${page.page_id}`}
                      style={{
                        display: 'block',
                        background: 'var(--bg-card)',
                        border: '1px solid var(--border)',
                        borderRadius: 7,
                        padding: '0.75rem 1rem',
                        textDecoration: 'none',
                        color: 'inherit',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.3rem' }}>
                        <span style={{ fontWeight: 500, fontSize: 14 }}>{page.title}</span>
                        {badge && (
                          <span
                            style={{
                              fontSize: 10,
                              color: badge.color,
                              border: `1px solid ${badge.color}`,
                              padding: '0.05em 0.45em',
                              borderRadius: 999,
                              textTransform: 'uppercase',
                              letterSpacing: '0.06em',
                              flexShrink: 0,
                            }}
                          >
                            {badge.label}
                          </span>
                        )}
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-dim)', flexShrink: 0 }}>
                          {formatDate(page.last_updated)}
                        </span>
                      </div>
                      {page.summary && (
                        <p
                          style={{
                            margin: 0,
                            fontSize: 13,
                            color: 'var(--fg-muted)',
                            lineHeight: 1.5,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                        >
                          {page.summary}
                        </p>
                      )}
                    </Link>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </main>
    </div>
  );
}
