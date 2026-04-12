/**
 * WikiSidebar — shared left panel for all /wiki/* pages.
 * Server component: receives pre-fetched category groups from the parent.
 */

import Link from 'next/link';
import type { CategoryGroup } from '../lib/db';

interface WikiSidebarProps {
  groups: CategoryGroup[];
  activePageId?: string;
  activeCategory?: string;
}

const PAGE_TYPE_COLORS: Record<string, string> = {
  'source-summary': 'var(--fg-dim)',
  concept: 'var(--accent)',
  entity: 'var(--warning)',
  comparison: 'var(--danger)',
  overview: 'var(--success)',
};

export default function WikiSidebar({ groups, activePageId, activeCategory }: WikiSidebarProps) {
  const recentPages = groups
    .flatMap((g) => g.pages)
    .sort((a, b) => (b.last_updated > a.last_updated ? 1 : -1))
    .slice(0, 3);

  return (
    <aside
      style={{
        width: 288,
        flexShrink: 0,
        borderRight: '1px solid var(--border)',
        padding: '1.5rem 1rem',
        overflowY: 'auto',
        maxHeight: 'calc(100dvh / 0.9 - 65px)',
        position: 'sticky',
        top: 65,
        alignSelf: 'flex-start',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
      }}
    >
      {/* Index link */}
      <Link
        href="/wiki"
        style={{
          display: 'block',
          fontFamily: 'var(--font-body)',
          fontSize: 12,
          color: 'var(--fg-muted)',
          textDecoration: 'none',
          padding: '0.3em 0.5em',
        }}
      >
        Index
      </Link>

      {/* Recently Compiled */}
      {recentPages.length > 0 && (
        <section
          style={{
            padding: 16,
            background: 'rgba(30, 32, 34, 0.5)',
            border: '1px solid rgba(71, 72, 74, 0.1)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {/* Header: label + All Activity link */}
          <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <span
              style={{
                fontFamily: 'var(--font-body)',
                fontWeight: 400,
                fontSize: 10,
                lineHeight: '15px',
                letterSpacing: 2,
                textTransform: 'uppercase',
                color: 'var(--accent)',
              }}
            >
              Recently Compiled
            </span>
            <Link
              href="/feed"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: 'var(--fg-dim)',
                textDecoration: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              All Activity →
            </Link>
          </div>

          {/* Item list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {recentPages.map((p) => (
              <Link
                key={p.page_id}
                href={`/wiki/${p.page_id}`}
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: 8,
                  textDecoration: 'none',
                }}
              >
                {/* Accent tick */}
                <div style={{ paddingTop: 2, flexShrink: 0 }}>
                  <div style={{ width: 2, height: 12, background: 'var(--accent)' }} />
                </div>
                {/* Title */}
                <span
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 400,
                    fontSize: 11,
                    lineHeight: '16px',
                    color: 'var(--fg)',
                    opacity: activePageId === p.page_id ? 1 : 0.7,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {p.title}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Categories */}
      <section>
        <div
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: 10,
            letterSpacing: 2,
            textTransform: 'uppercase',
            color: 'var(--accent)',
            marginBottom: '0.5rem',
          }}
        >
          Categories
        </div>
        {groups.map((group) => {
          const isActive = activeCategory === group.category;
          return (
            <div key={group.category} style={{ marginBottom: '0.75rem' }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: isActive ? 'var(--fg)' : 'var(--fg-muted)',
                  padding: '0.2em 0.4em',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span>{group.category}</span>
                <span style={{ color: 'var(--fg-dim)' }}>{group.pages.length}</span>
              </div>
              {group.pages.map((p) => (
                <Link
                  key={p.page_id}
                  href={`/wiki/${p.page_id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    fontSize: 12,
                    padding: '0.2em 0.4em 0.2em 1em',
                    borderRadius: 4,
                    color: activePageId === p.page_id ? 'var(--fg)' : 'var(--fg-muted)',
                    background: activePageId === p.page_id ? 'var(--bg-card-hover)' : 'transparent',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    textDecoration: 'none',
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: PAGE_TYPE_COLORS[p.page_type] ?? 'var(--fg-dim)',
                      flexShrink: 0,
                    }}
                  />
                  {p.title}
                </Link>
              ))}
            </div>
          );
        })}
      </section>
    </aside>
  );
}
