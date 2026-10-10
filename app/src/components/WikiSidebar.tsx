'use client';

/**
 * WikiSidebar — shared left panel for /wiki and every article page.
 *
 * Collapses to a 52px icon rail: the button at its top-left or Ctrl+.
 * toggles it, the choice is kept in localStorage, and with no choice yet,
 * windows under 1200px start collapsed.
 * Expanded, it lists recent pages, the categories (open ones remembered) and
 * comparisons, with the current page highlighted and scrolled into view.
 *
 * No flash and no hydration mismatch: the server always renders the expanded
 * state, and SIDEBAR_BOOT_SCRIPT, the first child, sets data-collapsed from
 * localStorage before the first paint; globals.css derives width and
 * visibility from that attribute. Hydration renders the server state again
 * (useSyncExternalStore's server snapshot), so only that one attribute can
 * differ, hence suppressHydrationWarning on this element. React then adopts
 * the stored state and drops the script. Mounted by a client-side
 * navigation, it reads localStorage directly and renders no script.
 */

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpen, ChevronRight, History, Network, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { CategoryGroup, PageRow } from '../lib/db';
import { PAGE_TYPE_VAR, ARCHIVED_COLOR } from '../lib/page-type-palette';
import {
  NARROW_QUERY,
  SIDEBAR_BOOT_SCRIPT,
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_OPEN_KEY,
  createLocalPref,
  isToggleShortcut,
  parseOpenCategories,
  resolveCollapsed,
  serializeOpenCategories,
} from '../lib/wiki-sidebar-prefs';

interface WikiSidebarProps {
  initialGroups: CategoryGroup[];
  activePageId?: string;
  activeCategory?: string;
}

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

const collapsedPref = createLocalPref(SIDEBAR_COLLAPSED_KEY);
const openPref = createLocalPref(SIDEBAR_OPEN_KEY);

function isNarrowWindow(): boolean {
  try {
    return window.matchMedia(NARROW_QUERY).matches;
  } catch {
    return false;
  }
}

/** Stored choice, plus the window width while there is none. */
function subscribeCollapsed(onChange: () => void): () => void {
  const unsubscribe = collapsedPref.subscribe(onChange);
  let query: MediaQueryList | null = null;
  try {
    query = window.matchMedia(NARROW_QUERY);
    query.addEventListener('change', onChange);
  } catch {
    query = null;
  }
  return () => {
    unsubscribe();
    query?.removeEventListener('change', onChange);
  };
}

const readCollapsed = () => resolveCollapsed(collapsedPref.read(), isNarrowWindow());
// The server can't see localStorage: it renders expanded, every category open.
const serverCollapsed = () => false;
const serverOpenRaw = () => null;
const neverChanges = () => () => {};
const onClient = () => true;
const onServer = () => false;

const QUICK_LINKS = [
  { href: '/wiki', label: 'All pages', Icon: BookOpen },
  { href: '/wiki/graph', label: 'Graph', Icon: Network },
  { href: '/feed', label: 'Activity', Icon: History },
] as const;

const LIST: CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };
const SECTION_LABEL: CSSProperties = { margin: '0 0 6px', padding: '0 4px' };
const TRUNCATE: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const CURRENT_TINT = 'rgba(var(--accent-rgb), 0.08)';

function PageLink({
  page,
  active,
  nested = false,
  reveal = false,
}: {
  page: PageRow;
  active: boolean;
  /** Inside a category: draws the category's guide line. */
  nested?: boolean;
  /** The row to scroll into view for the current page. */
  reveal?: boolean;
}) {
  const archived = page.page_type === 'archived';
  const dot = archived
    ? ARCHIVED_COLOR
    : PAGE_TYPE_VAR[page.page_type as keyof typeof PAGE_TYPE_VAR] ?? ARCHIVED_COLOR;
  return (
    <Link
      href={`/wiki/${page.page_id}`}
      className="wiki-sb-item"
      aria-current={active ? 'page' : undefined}
      data-sidebar-reveal={reveal ? '' : undefined}
      title={archived ? `${page.title} (archived)` : page.title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: `4px 8px 4px ${nested ? 12 : 8}px`,
        borderRadius: nested ? '0 6px 6px 0' : 6,
        fontSize: 14,
        lineHeight: '20px',
        textDecoration: 'none',
        // The current page turns the guide line into an accent bar.
        boxShadow: nested
          ? `inset ${active ? '2px 0 0 var(--accent)' : '1px 0 0 var(--border-hover)'}`
          : undefined,
        ...(active
          ? { color: 'var(--fg)', background: CURRENT_TINT, fontWeight: 500 }
          : archived
            ? { color: 'var(--fg-dim)', fontStyle: 'italic' }
            : null),
      }}
    >
      <span
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: '50%', background: dot, flexShrink: 0 }}
      />
      <span style={TRUNCATE}>{page.title}</span>
    </Link>
  );
}

export default function WikiSidebar({ initialGroups, activePageId, activeCategory }: WikiSidebarProps) {
  const pathname = usePathname();
  const ids = useId();
  const panelId = `${ids}-panel`;
  // False on the server and while hydrating; true afterwards and on client-side mounts.
  const hydrated = useSyncExternalStore(neverChanges, onClient, onServer);
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, serverCollapsed);
  const openRaw = useSyncExternalStore(openPref.subscribe, openPref.read, serverOpenRaw);
  const [showArchived, setShowArchived] = useState(false);
  const [groups, setGroups] = useState(initialGroups);
  const [dismissedCategory, setDismissedCategory] = useState<string | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Sync groups when server re-renders a new page (initialGroups changes via App Router).
  // Without this, useState persists stale groups across soft navigations in the shared layout.
  useEffect(() => {
    if (!showArchived) setGroups(initialGroups);
  }, [initialGroups, showArchived]);

  function setCollapsed(next: boolean) {
    // Collapsing hides the page lists and the archive toggle. Focus in there
    // would be lost, so it moves to the collapse button, which stays.
    const focused = document.activeElement;
    if (next && focused instanceof Element && focused.closest('.wiki-sb-full')) {
      toggleRef.current?.focus();
    }
    collapsedPref.write(next ? '1' : '0');
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || !isToggleShortcut(e)) return;
      e.preventDefault();
      setCollapsed(!readCollapsed());
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setCollapsed only uses refs and module state
  }, []);

  // Bring the current page's row into view: on load (once the stored open
  // categories apply), on navigation, and when the panel reopens.
  useEffect(() => {
    if (!hydrated || collapsed) return;
    const box = scrollRef.current;
    const row = box?.querySelector<HTMLElement>('[data-sidebar-reveal]');
    if (!box || !row || row.offsetParent !== box) return;
    const top = row.offsetTop;
    if (top >= box.scrollTop && top + row.offsetHeight <= box.scrollTop + box.clientHeight) return;
    box.scrollTop = top - (box.clientHeight - row.offsetHeight) / 2;
  }, [hydrated, collapsed, activePageId]);

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

  // With nothing stored, every category with a non-comparison page is open.
  const defaultOpen = useMemo(
    () =>
      initialGroups
        .filter((g) => g.pages.some((p) => p.page_type !== 'comparison'))
        .map((g) => g.category),
    [initialGroups],
  );
  const openCategories = useMemo(() => parseOpenCategories(openRaw, defaultOpen), [openRaw, defaultOpen]);
  // The current page's category opens by itself, without being saved, unless
  // the reader closes it.
  const autoOpen = activeCategory && activeCategory !== dismissedCategory ? activeCategory : null;
  const isOpen = (category: string) => openCategories.has(category) || category === autoOpen;

  function toggleCategory(category: string) {
    const next = new Set(openCategories);
    if (isOpen(category)) {
      next.delete(category);
      if (category === autoOpen) setDismissedCategory(category);
    } else {
      next.add(category);
    }
    openPref.write(serializeOpenCategories(next));
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
      className="wiki-sb"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label="Wiki sidebar"
      suppressHydrationWarning
      style={{
        flexShrink: 0,
        position: 'sticky',
        // Below the fixed 65px TopNav; the height compensates for html { zoom: 0.9 }.
        top: 65,
        alignSelf: 'flex-start',
        height: 'calc(100dvh / 0.9 - 65px)',
        borderRight: '1px solid var(--border)',
        // Clips the full-width content while collapsed and during the width
        // animation. clip, not hidden: no scroll container, sticky still works.
        overflow: 'clip',
      }}
    >
      {!hydrated && (
        <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: SIDEBAR_BOOT_SCRIPT }} />
      )}

      {/* Fixed width, so text doesn't rewrap while the sidebar animates. */}
      <div
        style={{
          width: 'calc(var(--wiki-sb-width) - 1px)',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '12px 10px 6px',
          }}
        >
          <button
            ref={toggleRef}
            type="button"
            className="wiki-sb-btn"
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            aria-controls={panelId}
            aria-keyshortcuts="Control+."
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar (Ctrl+.)' : 'Collapse sidebar (Ctrl+.)'}
            style={{
              width: 32,
              height: 32,
              flexShrink: 0,
              padding: 0,
              border: 'none',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {/* Both icons render; CSS shows the one for the current state. */}
            <PanelLeftClose size={18} aria-hidden className="wiki-sb-full" />
            <PanelLeftOpen size={18} aria-hidden className="wiki-sb-rail" />
          </button>
          <button
            type="button"
            className="wiki-sb-btn wiki-sb-full"
            onClick={handleToggle}
            aria-pressed={showArchived}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 28,
              padding: '0 8px',
              border: 'none',
              borderRadius: 6,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              fontWeight: 400,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              ...(showArchived ? { color: 'var(--accent)' } : null),
            }}
          >
            {/* Checkbox mark: the state shows by more than colour. */}
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                border: '1px solid currentColor',
                background: showArchived ? 'currentColor' : 'transparent',
              }}
            />
            Show archived
          </button>
        </div>

        <nav aria-label="Wiki" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Entry points: icon + label expanded, the icons alone form the rail. */}
          <ul style={{ ...LIST, display: 'flex', flexDirection: 'column', gap: 2, padding: '0 10px 10px' }}>
            {QUICK_LINKS.map(({ href, label, Icon }) => {
              const current = pathname === href;
              return (
                <li key={href}>
                  <Link
                    href={href}
                    className="wiki-sb-item wiki-sb-quick"
                    aria-label={label}
                    aria-current={current ? 'page' : undefined}
                    title={collapsed ? label : undefined}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      height: 32,
                      padding: '0 7px',
                      borderRadius: 6,
                      fontSize: 14,
                      textDecoration: 'none',
                      whiteSpace: 'nowrap',
                      ...(current ? { color: 'var(--fg)', background: CURRENT_TINT } : null),
                    }}
                  >
                    <Icon size={18} aria-hidden style={{ flexShrink: 0 }} />
                    <span className="wiki-sb-full">{label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>

          <div
            id={panelId}
            ref={scrollRef}
            className="wiki-sb-full"
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              scrollbarWidth: 'thin',
              scrollbarGutter: 'stable',
              position: 'relative', // offsetTop of the rows is measured from here
              padding: '14px 6px 24px 10px',
              borderTop: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: 22,
            }}
          >
            {recentPages.length > 0 && (
              <div>
                <div id={`${ids}-recent`} className="meta" style={SECTION_LABEL}>
                  Recently compiled
                </div>
                <ul aria-labelledby={`${ids}-recent`} style={LIST}>
                  {recentPages.map((p) => (
                    <li key={p.page_id}>
                      <PageLink page={p} active={p.page_id === activePageId} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <div id={`${ids}-categories`} className="meta" style={SECTION_LABEL}>
                Categories
              </div>
              {categoryGroups.length === 0 ? (
                <p style={{ margin: 0, padding: '0 4px', fontSize: 13, color: 'var(--fg-dim)' }}>
                  No pages yet.
                </p>
              ) : (
                <ul aria-labelledby={`${ids}-categories`} style={LIST}>
                  {categoryGroups.map((group, i) => {
                    const open = isOpen(group.category);
                    const listId = `${ids}-category-${i}`;
                    return (
                      <li key={group.category}>
                        <button
                          type="button"
                          className="wiki-sb-btn"
                          onClick={() => toggleCategory(group.category)}
                          aria-expanded={open}
                          aria-controls={listId}
                          title={group.category}
                          style={{
                            width: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            height: 30,
                            padding: '0 8px 0 4px',
                            border: 'none',
                            borderRadius: 6,
                            fontFamily: 'inherit',
                            fontSize: 14,
                            fontWeight: 600,
                            textAlign: 'left',
                            color: group.category === activeCategory ? 'var(--fg)' : 'var(--fg-secondary)',
                          }}
                        >
                          <ChevronRight
                            size={14}
                            aria-hidden
                            style={{
                              flexShrink: 0,
                              color: 'var(--fg-dim)',
                              transform: open ? 'rotate(90deg)' : undefined,
                            }}
                          />
                          <span style={{ ...TRUNCATE, flex: 1 }}>{group.category}</span>
                          <span
                            style={{
                              flexShrink: 0,
                              fontSize: 12,
                              fontWeight: 400,
                              color: 'var(--fg-dim)',
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {group.pages.length}
                          </span>
                        </button>
                        <ul id={listId} hidden={!open} style={{ ...LIST, margin: '2px 0 8px 11px' }}>
                          {group.pages.map((p) => {
                            const active = p.page_id === activePageId;
                            return (
                              <li key={p.page_id}>
                                <PageLink page={p} active={active} nested reveal={active} />
                              </li>
                            );
                          })}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {comparisonPages.length > 0 && (
              <div>
                <div id={`${ids}-comparisons`} className="meta" style={SECTION_LABEL}>
                  Comparisons
                </div>
                <ul aria-labelledby={`${ids}-comparisons`} style={LIST}>
                  {comparisonPages.map((p) => {
                    const active = p.page_id === activePageId;
                    return (
                      <li key={p.page_id}>
                        <PageLink page={p} active={active} reveal={active} />
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        </nav>
      </div>
    </aside>
  );
}
