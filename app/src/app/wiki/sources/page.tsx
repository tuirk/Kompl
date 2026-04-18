// Disable static prerendering — reads from SQLite which only exists at runtime.
export const dynamic = 'force-dynamic';

/**
 * /wiki/sources — Sources index. SERVER component.
 *
 * Lists every ingested source, grouped by the category of its source-summary
 * (or original-source) page. Each card links to /source/{source_id}, which
 * renders the raw gzipped markdown. Archive gate via ?archived=1.
 */

import Link from 'next/link';
import { getCategoryGroups, getSourceCategoryGroups } from '../../../lib/db';
import WikiSidebar from '../../../components/WikiSidebar';
import WikiPageHeader, { formatHeaderDatetime } from '../../../components/WikiPageHeader';

// Tint per source_type — deliberately muted; source_type is metadata, not primary hierarchy.
const SOURCE_TYPE_STYLES: Record<string, { bg: string; border: string; text: string }> = {
  url:          { bg: 'rgba(59,130,246,0.10)',  border: 'rgba(59,130,246,0.22)',  text: '#60A5FA' },
  tweet:        { bg: 'rgba(29,161,242,0.10)',  border: 'rgba(29,161,242,0.22)',  text: '#1DA1F2' },
  'file-upload':{ bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.22)',  text: '#f59e0b' },
  text:         { bg: 'rgba(107,114,128,0.15)', border: 'rgba(107,114,128,0.25)', text: '#9ca3af' },
  youtube:      { bg: 'rgba(239,68,68,0.10)',   border: 'rgba(239,68,68,0.22)',   text: '#ef4444' },
};

const FALLBACK_STYLE = { bg: 'rgba(107,114,128,0.15)', border: 'rgba(107,114,128,0.25)', text: '#9ca3af' };

interface PageProps {
  searchParams: Promise<{ archived?: string }>;
}

export default async function WikiSourcesPage({ searchParams }: PageProps) {
  const { archived } = await searchParams;
  const showArchived = archived === '1';

  const groups = getSourceCategoryGroups(showArchived);
  const sidebarGroups = getCategoryGroups();
  const totalSources = groups.reduce((n, g) => n + g.sources.length, 0);

  return (
    <div style={{ display: 'flex', minHeight: 'calc(100dvh / 0.9)' }}>
      <WikiSidebar initialGroups={sidebarGroups} />

      <main style={{ flex: 1, padding: '2rem 2.5rem', minWidth: 0 }}>
        <WikiPageHeader
          title="Sources"
          label="Kompl Wiki · Sources"
          metaText={`${totalSources} source${totalSources !== 1 ? 's' : ''}${showArchived ? ' (archived included)' : ''}`}
        />

        {/* Archive toggle */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 24 }}>
          <Link
            href={showArchived ? '/wiki/sources' : '/wiki/sources?archived=1'}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              color: showArchived ? 'var(--accent)' : 'var(--fg-dim)',
              textDecoration: 'none',
              padding: '0.3em 0.5em',
              border: '1px solid rgba(var(--separator-rgb),0.3)',
            }}
          >
            {showArchived ? 'Hide Archived' : 'Show Archived'}
          </Link>
        </div>

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
            <p style={{ margin: '0 0 0.5rem', fontSize: 15 }}>No sources yet.</p>
            <p style={{ margin: 0, fontSize: 14 }}>
              <Link href="/onboarding?mode=add">Add a source</Link> to start.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 64 }}>
            {groups.map((group) => (
              <section key={group.category}>

                {/* Category header: name + gradient divider */}
                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 24 }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontWeight: 700,
                      fontSize: 14,
                      lineHeight: '20px',
                      letterSpacing: 3.5,
                      textTransform: 'uppercase',
                      color: 'var(--fg)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {group.category}
                  </span>
                  <div
                    style={{
                      flex: 1,
                      height: 1,
                      background: 'linear-gradient(90deg, rgba(var(--separator-rgb),0.3) 0%, rgba(var(--separator-rgb),0) 100%)',
                    }}
                  />
                </div>

                {/* 4-column card grid */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, 1fr)',
                    gap: 1,
                    background: 'rgba(var(--separator-rgb),0.1)',
                  }}
                >
                  {group.sources.map((src) => {
                    const style = SOURCE_TYPE_STYLES[src.source_type] ?? FALLBACK_STYLE;
                    const isArchived = src.status === 'archived';

                    return (
                      <Link
                        key={src.source_id}
                        href={`/source/${src.source_id}`}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                          padding: 24,
                          background: 'var(--bg)',
                          textDecoration: 'none',
                          color: 'inherit',
                          borderTop: `2px solid ${style.text}`,
                          opacity: isArchived ? 0.55 : 1,
                        }}
                      >
                        {/* Row 1: source_type badge + archived pill */}
                        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <span
                            style={{
                              padding: '2px 8px',
                              background: style.bg,
                              border: `1px solid ${style.border}`,
                              fontFamily: 'var(--font-heading)',
                              fontWeight: 700,
                              fontSize: 9,
                              lineHeight: '14px',
                              letterSpacing: -0.45,
                              textTransform: 'uppercase',
                              color: style.text,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {src.source_type.replace('-', ' ')}
                          </span>
                          {isArchived && (
                            <span
                              style={{
                                padding: '2px 8px',
                                background: 'rgba(var(--separator-rgb),0.1)',
                                border: '1px solid rgba(var(--separator-rgb),0.2)',
                                fontFamily: 'var(--font-heading)',
                                fontWeight: 700,
                                fontSize: 9,
                                lineHeight: '14px',
                                letterSpacing: -0.45,
                                textTransform: 'uppercase',
                                color: 'var(--fg-dim)',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              Archived
                            </span>
                          )}
                        </div>

                        {/* Row 2: title */}
                        <h3
                          style={{
                            fontFamily: 'var(--font-heading)',
                            fontWeight: 700,
                            fontSize: 20,
                            lineHeight: '28px',
                            letterSpacing: -0.5,
                            textTransform: 'uppercase',
                            color: 'var(--fg)',
                            margin: 0,
                            paddingTop: 8,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                        >
                          {src.title}
                        </h3>

                        {/* Row 3: URL (if any, 1-line clamp) */}
                        {src.source_url && (
                          <p
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 11,
                              lineHeight: '16px',
                              color: 'var(--fg-muted)',
                              margin: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {src.source_url}
                          </p>
                        )}

                        {/* Row 4: footer — ingest date */}
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'row',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            paddingTop: 16,
                            marginTop: 'auto',
                          }}
                        >
                          <span
                            style={{
                              fontFamily: 'var(--font-body)',
                              fontSize: 10,
                              letterSpacing: 1,
                              textTransform: 'uppercase',
                              color: 'var(--fg)',
                              opacity: 0.4,
                            }}
                          >
                            {formatHeaderDatetime(src.date_ingested)}
                          </span>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
