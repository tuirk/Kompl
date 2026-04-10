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
  topic: 'var(--success)',
};

export default function WikiSidebar({ groups, activePageId, activeCategory }: WikiSidebarProps) {
  const recentPages = groups
    .flatMap((g) => g.pages)
    .sort((a, b) => (b.last_updated > a.last_updated ? 1 : -1))
    .slice(0, 5);

  return (
    <aside
      style={{
        width: 240,
        flexShrink: 0,
        borderRight: '1px solid var(--border)',
        padding: '1.5rem 1rem',
        overflowY: 'auto',
        maxHeight: 'calc(100vh - 60px)',
        position: 'sticky',
        top: 60,
        alignSelf: 'flex-start',
      }}
    >
      <div style={{ marginBottom: '1.5rem' }}>
        <Link
          href="/wiki/graph"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            fontSize: 13,
            color: 'var(--accent)',
            padding: '0.4em 0.6em',
            borderRadius: 5,
            border: '1px solid var(--border)',
          }}
        >
          ⬡ Knowledge Graph
        </Link>
      </div>

      <div style={{ marginBottom: '1.5rem' }}>
        <Link
          href="/wiki/search"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            fontSize: 13,
            color: 'var(--fg-muted)',
            padding: '0.4em 0.6em',
            borderRadius: 5,
            border: '1px solid var(--border)',
          }}
        >
          ⌕ Search wiki
        </Link>
      </div>

      {recentPages.length > 0 && (
        <section style={{ marginBottom: '1.5rem' }}>
          <div
            style={{
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color: 'var(--fg-dim)',
              marginBottom: '0.5rem',
            }}
          >
            Recently compiled
          </div>
          {recentPages.map((p) => (
            <Link
              key={p.page_id}
              href={`/wiki/${p.page_id}`}
              style={{
                display: 'block',
                fontSize: 12,
                padding: '0.25em 0.4em',
                borderRadius: 4,
                color: activePageId === p.page_id ? 'var(--fg)' : 'var(--fg-muted)',
                background: activePageId === p.page_id ? 'var(--bg-card-hover)' : 'transparent',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                marginBottom: 1,
              }}
            >
              {p.title}
            </Link>
          ))}
        </section>
      )}

      <section>
        <div
          style={{
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            color: 'var(--fg-dim)',
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

      <div
        style={{
          marginTop: '1.5rem',
          paddingTop: '1rem',
          borderTop: '1px solid var(--border)',
        }}
      >
        <Link href="/wiki" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          ← All pages
        </Link>
        <br />
        <Link href="/" style={{ fontSize: 12, color: 'var(--fg-muted)', display: 'block', marginTop: '0.4rem' }}>
          ⚙ Manage
        </Link>
        <Link href="/chat" style={{ fontSize: 12, color: 'var(--fg-muted)', display: 'block', marginTop: '0.4rem' }}>
          💬 Chat
        </Link>
      </div>
    </aside>
  );
}
