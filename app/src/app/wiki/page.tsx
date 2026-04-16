// Disable static prerendering — reads from SQLite which only exists at runtime.
export const dynamic = 'force-dynamic';

/**
 * /wiki — Wiki index page. SERVER component.
 *
 * Shows all compiled wiki pages grouped by category.
 * Card grid: 4 columns, Stitch design, Kompl color scheme.
 */

import Link from 'next/link';
import { getCategoryGroups } from '../../lib/db';
import WikiSidebar from '../../components/WikiSidebar';
import WikiPageHeader, { formatHeaderDatetime } from '../../components/WikiPageHeader';

// Tinted badge pill styles per page_type. Canonical hex values — keep in sync with
// NODE_COLORS in wiki/graph/page.tsx (canvas can't use CSS vars).
const BADGE_STYLES: Record<string, { bg: string; border: string; text: string }> = {
  concept:          { bg: 'rgba(59,130,246,0.1)',   border: 'rgba(59,130,246,0.2)',   text: '#60A5FA' },
  entity:           { bg: 'rgba(245,158,11,0.1)',   border: 'rgba(245,158,11,0.2)',   text: '#f59e0b' },
  topic:            { bg: 'rgba(16,185,129,0.1)',   border: 'rgba(16,185,129,0.2)',   text: '#10b981' },
  overview:         { bg: 'rgba(16,185,129,0.1)',   border: 'rgba(16,185,129,0.2)',   text: '#10b981' },
  comparison:       { bg: 'rgba(139,92,246,0.1)',   border: 'rgba(139,92,246,0.2)',   text: '#8b5cf6' },
  'source-summary': { bg: 'rgba(107,114,128,0.15)', border: 'rgba(107,114,128,0.25)', text: '#9ca3af' },
};

export default function WikiIndexPage() {
  const groups = getCategoryGroups();
  const totalPages = groups.reduce((n, g) => n + g.pages.length, 0);

  const latestIso = groups
    .flatMap((g) => g.pages.map((p) => p.last_updated))
    .sort()
    .at(-1) ?? null;
  const latestLabel = latestIso ? `last update: ${formatHeaderDatetime(latestIso)}` : undefined;

  return (
    <div style={{ display: 'flex', minHeight: 'calc(100dvh / 0.9)' }}>
      <WikiSidebar groups={groups} />

      <main style={{ flex: 1, padding: '2rem 2.5rem', minWidth: 0 }}>
        <WikiPageHeader
          title="Kompl Wiki"
          label={latestLabel}
          metaText={`${totalPages} pages compiled`}
          showActions
        />

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
              <Link href="/onboarding?mode=add">Add a source</Link> to start building the wiki.
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
                      background: 'linear-gradient(90deg, rgba(71,72,74,0.3) 0%, rgba(71,72,74,0) 100%)',
                    }}
                  />
                </div>

                {/* 4-column card grid — 1px gap shows through as separator */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, 1fr)',
                    gap: 1,
                    background: 'rgba(71,72,74,0.1)',
                  }}
                >
                  {group.pages.map((page) => {
                    const badge = BADGE_STYLES[page.page_type];
                    const dots = Math.min(page.source_count ?? 0, 5);

                    return (
                      <Link
                        key={page.page_id}
                        href={`/wiki/${page.page_id}`}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                          padding: 24,
                          background: 'var(--bg)',
                          textDecoration: 'none',
                          color: 'inherit',
                          borderTop: badge ? `2px solid ${badge.text}` : undefined,
                        }}
                      >
                        {/* Row 1: type badge + source count */}
                        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          {badge ? (
                            <span
                              style={{
                                padding: '2px 8px',
                                background: badge.bg,
                                border: `1px solid ${badge.border}`,
                                fontFamily: 'var(--font-heading)',
                                fontWeight: 700,
                                fontSize: 9,
                                lineHeight: '14px',
                                letterSpacing: -0.45,
                                textTransform: 'uppercase',
                                color: badge.text,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {page.page_type.replace('-', ' ')}
                            </span>
                          ) : null}
                          <span
                            style={{
                              fontFamily: 'var(--font-body)',
                              fontSize: 9,
                              letterSpacing: 0.9,
                              textTransform: 'uppercase',
                              color: 'var(--fg)',
                              opacity: 0.3,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {page.source_count ?? 0} src{(page.source_count ?? 0) !== 1 ? 's' : ''}
                          </span>
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
                          }}
                        >
                          {page.title}
                        </h3>

                        {/* Row 3: summary (2-line clamp) */}
                        {page.summary && (
                          <p
                            style={{
                              fontFamily: 'var(--font-heading)',
                              fontWeight: 400,
                              fontSize: 14,
                              lineHeight: '23px',
                              color: 'var(--fg-muted)',
                              margin: 0,
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                            }}
                          >
                            {page.summary}
                          </p>
                        )}

                        {/* Row 4: footer — last updated + source dots */}
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
                            {formatHeaderDatetime(page.last_updated)}
                          </span>
                          <div style={{ display: 'flex', flexDirection: 'row', gap: 4 }}>
                            {Array.from({ length: dots }).map((_, i) => (
                              <div
                                key={i}
                                style={{
                                  width: 4,
                                  height: 4,
                                  background: 'var(--accent)',
                                  opacity: i === 0 ? 1 : 0.4,
                                  flexShrink: 0,
                                }}
                              />
                            ))}
                          </div>
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
