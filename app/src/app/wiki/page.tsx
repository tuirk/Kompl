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
import WikiPageHeader from '../../components/WikiPageHeader';
import { LocalDatetime } from '../../components/LocalDate';
import WikiCategorySection from '../../components/WikiCategorySection';
import { PAGE_TYPE_HEX } from '../../lib/page-type-palette';
import { stripWikilinkBrackets } from '../../lib/wikilink-render';

// Tinted badge pill styles per page_type. Derived from the shared PAGE_TYPE_HEX
// palette so the index cards stay aligned with sidebar dots + graph legend.
function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}
function makeBadge(hex: string) {
  const rgb = hexToRgb(hex);
  return { bg: `rgba(${rgb},0.1)`, border: `rgba(${rgb},0.2)`, text: hex };
}
const BADGE_STYLES: Record<string, { bg: string; border: string; text: string }> = {
  ...Object.fromEntries(
    Object.entries(PAGE_TYPE_HEX).map(([k, hex]) => [k, makeBadge(hex)])
  ),
  // Legacy key — never produced by backend; retained intentionally.
  topic: makeBadge('#10b981'),
};

export default function WikiIndexPage() {
  const groups = getCategoryGroups();
  const totalPages = groups.reduce((n, g) => n + g.pages.length, 0);

  const latestIso = groups
    .flatMap((g) => g.pages.map((p) => p.last_updated))
    .sort()
    .at(-1) ?? null;
  const latestLabel = latestIso ? <>last update: <LocalDatetime iso={latestIso} /></> : undefined;

  return (
    <div style={{ display: 'flex', minHeight: 'calc(100dvh / 0.9)' }}>
      <WikiSidebar initialGroups={groups} />

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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {groups.map((group, idx) => {
              const groupLatest = group.pages
                .map((p) => p.last_updated)
                .sort()
                .at(-1) ?? null;
              const groupLabel = groupLatest
                ? <>last update: <LocalDatetime iso={groupLatest} /></>
                : undefined;
              return (
              <WikiCategorySection
                key={group.category}
                category={group.category}
                pageCount={group.pages.length}
                lastUpdatedLabel={groupLabel}
                defaultOpen={idx === 0}
              >
                {/* 4-column card grid — 1px gap shows through as separator.
                    minmax(0, 1fr) overrides the default `auto` min so nowrap children
                    (title/summary ellipsis) can truncate instead of blowing out the column. */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                    gap: 1,
                    background: 'rgba(var(--separator-rgb),0.1)',
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
                            {page.source_count ?? 0} source{(page.source_count ?? 0) !== 1 ? 's' : ''}
                          </span>
                        </div>

                        {/* Row 2: title — single-line truncate, matches dashboard Recently Processed */}
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
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {page.title}
                        </h3>

                        {/* Row 3: summary — single-line truncate, always rendered so every
                            card has identical 4-row content. Null summary (Gate 1 raw-content
                            pages, missing frontmatter) still reserves the slot via nbsp. */}
                        <p
                          style={{
                            fontFamily: 'var(--font-heading)',
                            fontWeight: 400,
                            fontSize: 14,
                            lineHeight: '23px',
                            color: 'var(--fg-muted)',
                            margin: 0,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {page.summary ? stripWikilinkBrackets(page.summary) : ' '}
                        </p>

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
                            <LocalDatetime iso={page.last_updated} />
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
              </WikiCategorySection>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
