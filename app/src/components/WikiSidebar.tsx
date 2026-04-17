'use client';

/**
 * WikiSidebar — shared left panel for all /wiki/* pages.
 * Client component: manages "Show archived" toggle with client-side state.
 * Receives initialGroups from the parent server component.
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { CategoryGroup, PageRow } from '../lib/db';

interface WikiSidebarProps {
  initialGroups: CategoryGroup[];
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

/** Client-side equivalent of getCategoryGroups() — groups PageRow[] by category. */
function buildCategoryGroups(pages: PageRow[]): CategoryGroup[] {
  const map = new Map<string, PageRow[]>();
  for (const p of pages) {
    const cat = p.category ?? 'Uncategorized';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(p);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([category, pages]) => ({ category, pages }));
}

export default function WikiSidebar({ initialGroups, activePageId, activeCategory }: WikiSidebarProps) {
  const [showArchived, setShowArchived] = useState(false);
  const [groups, setGroups] = useState(initialGroups);

  // Sync groups when server re-renders a new page (initialGroups changes via App Router).
  // Without this, useState persists stale groups across soft navigations in the shared layout.
  useEffect(() => {
    if (!showArchived) setGroups(initialGroups);
  }, [initialGroups, showArchived]);

  async function handleToggle() {
    const next = !showArchived;
    setShowArchived(next);
    if (next) {
      try {
        const res = await fetch('/api/wiki/index?include_archived=true');
        if (res.ok) {
          const data = (await res.json()) as { pages: PageRow[] };
          setGroups(buildCategoryGroups(data.pages));
        }
      } catch {
        // Non-fatal: toggle still flips, just may not show archived pages
      }
    } else {
      setGroups(initialGroups);
    }
  }

  // Pull comparison pages out of the category tree — they get their own section.
  const comparisonPages = groups.flatMap((g) => g.pages).filter((p) => p.page_type === 'comparison');
  const categoryGroups = groups
    .map((g) => ({ ...g, pages: g.pages.filter((p) => p.page_type !== 'comparison') }))
    .filter((g) => g.pages.length > 0);

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
      {/* Index link + archive toggle row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Link
          href="/wiki"
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: 12,
            color: 'var(--fg-muted)',
            textDecoration: 'none',
            padding: '0.3em 0.5em',
          }}
        >
          Index
        </Link>
        <button
          onClick={handleToggle}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: showArchived ? 'var(--accent)' : 'var(--fg-dim)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '0.3em 0.5em',
          }}
        >
          {showArchived ? 'Hide Archived' : 'Show Archived'}
        </button>
      </div>

      {/* Recently Compiled */}
      {recentPages.length > 0 && (
        <section
          style={{
            padding: 16,
            background: 'rgba(30, 32, 34, 0.5)',
            border: '1px solid rgba(var(--separator-rgb), 0.1)',
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
        {categoryGroups.map((group) => {
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
                    opacity: p.page_type === 'archived' ? 0.45 : 1,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: p.page_type === 'archived' ? 'var(--fg-dim)' : (PAGE_TYPE_COLORS[p.page_type] ?? 'var(--fg-dim)'),
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

      {/* Comparisons */}
      {comparisonPages.length > 0 && (
        <section>
          <div
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: 10,
              letterSpacing: 2,
              textTransform: 'uppercase',
              color: 'var(--fg-dim)',
              marginBottom: '0.5rem',
            }}
          >
            Comparisons
          </div>
          {comparisonPages.map((p) => (
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
                  background: PAGE_TYPE_COLORS['comparison'],
                  flexShrink: 0,
                }}
              />
              {p.title}
            </Link>
          ))}
        </section>
      )}
    </aside>
  );
}
