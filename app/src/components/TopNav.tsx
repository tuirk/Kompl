'use client';

/**
 * TopNav — global top ribbon present on all app pages.
 *
 * Layout (Obsidian Kinetic, matches Stitch spec):
 *   Left  — KOMPL logo (links to /)
 *   Center — primary nav: Home · Wiki · Chat · Sources
 *   Right  — search archive input (with live dropdown) · settings icon
 *
 * Search behaviour:
 *   - Typing ≥ 2 chars fetches /api/pages/search?q=...&limit=3 (250ms debounce)
 *   - Dropdown shows top 3 results + "See all →" as 4th row
 *   - Arrow ↑↓ navigates rows; Enter opens selected (or goes to search page)
 *   - Enter with no selection → /wiki/search?q=...
 *   - Escape clears and closes
 *   - Click outside closes
 *
 * Hidden on /onboarding/* (standalone flow, no nav needed).
 */

import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search, Settings } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { PAGE_TYPE_VAR } from '../lib/page-type-palette';

const NAV_ITEMS = [
  { href: '/',     label: 'Home', isActive: (p: string) => p === '/' },
  { href: '/wiki', label: 'Wiki', isActive: (p: string) => p.startsWith('/wiki') },
  { href: '/chat', label: 'Chat', isActive: (p: string) => p.startsWith('/chat') },
] as const;

interface SearchResult {
  page_id: string;
  title: string;
  page_type: string;
  category: string | null;
  summary: string | null;
}

function debounce<T extends (...args: Parameters<T>) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

export default function TopNav() {
  const pathname     = usePathname();
  const router       = useRouter();
  const searchParams = useSearchParams();
  const isAddMode    = searchParams.get('mode') === 'add';

  const [query,     setQuery]     = useState('');
  const [results,   setResults]   = useState<SearchResult[]>([]);
  const [open,      setOpen]      = useState(false);
  const [selIndex,  setSelIndex]  = useState(-1); // -1 = nothing, 0-2 = result, 3 = "see all"

  const containerRef = useRef<HTMLDivElement>(null);

  // ── Close on outside click ──────────────────────────────────────────────────
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSelIndex(-1);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  // ── Live search (debounced 250ms) ───────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fetchResults = useCallback(
    debounce(async (q: string) => {
      if (q.trim().length < 2) { setResults([]); setOpen(false); return; }
      try {
        const res  = await fetch(`/api/pages/search?q=${encodeURIComponent(q.trim())}&limit=3`);
        const data = (await res.json()) as { items: SearchResult[] };
        setResults(data.items);
        setOpen(true);
        setSelIndex(-1);
      } catch {
        setResults([]);
      }
    }, 250),
    [],
  );

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value;
    setQuery(q);
    if (q.trim().length < 2) { setResults([]); setOpen(false); setSelIndex(-1); }
    else fetchResults(q);
  }

  // ── Keyboard navigation ─────────────────────────────────────────────────────
  // Total rows: results.length (0–3) + 1 "see all" = results.length + 1
  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const total = results.length + 1; // results + "see all" row

    if (e.key === 'Escape') {
      setQuery(''); setResults([]); setOpen(false); setSelIndex(-1);
      return;
    }

    if (e.key === 'ArrowDown' && open) {
      e.preventDefault();
      setSelIndex((i) => (i + 1) % total);
      return;
    }

    if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      setSelIndex((i) => (i - 1 + total) % total);
      return;
    }

    if (e.key === 'Enter' && query.trim()) {
      e.preventDefault();
      if (open && selIndex >= 0 && selIndex < results.length) {
        // Navigate to selected wiki page
        router.push(`/wiki/${results[selIndex].page_id}`);
      } else {
        // "See all" row selected, or no selection — go to full search page
        router.push(`/wiki/search?q=${encodeURIComponent(query.trim())}`);
      }
      setOpen(false);
      setSelIndex(-1);
    }
  }

  function goToResult(pageId: string) {
    setOpen(false); setQuery(''); setResults([]); setSelIndex(-1);
    router.push(`/wiki/${pageId}`);
  }

  function goToSearch() {
    setOpen(false); setSelIndex(-1);
    router.push(`/wiki/search?q=${encodeURIComponent(query.trim())}`);
  }

  const showDropdown = open && query.trim().length >= 2;



  return (
    <header
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0,
        height: 65,
        zIndex: 100,
        background: 'var(--bg)',
        borderBottom: '1px solid rgba(var(--separator-rgb), 0.1)',
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '0 56px',
      }}
    >
      {/* Left — logo */}
      <Link href="/" style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <Image
          src="/kompl.png"
          alt="Kompl"
          width={150}
          height={32}
          style={{ objectFit: 'contain', objectPosition: 'left center' }}
          priority
        />
      </Link>

      {/* Center — primary nav */}
      <nav style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 32 }}>
        {NAV_ITEMS.map((item) => {
          const active = item.isActive(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              style={{
                fontFamily: 'var(--font-heading)',
                fontSize: 16,
                fontWeight: 400,
                letterSpacing: '-0.4px',
                color: active ? 'var(--accent)' : 'var(--fg-secondary)',
                opacity: active ? 1 : 0.7,
                paddingBottom: active ? 4 : 0,
                borderBottom: active ? '2px solid var(--accent)' : 'none',
                textDecoration: 'none',
                whiteSpace: 'nowrap',
                transition: 'color var(--transition-fast), opacity var(--transition-fast)',
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Right — search + settings */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 16, flexShrink: 0 }}>

        {/* Search with live dropdown */}
        <div ref={containerRef} style={{ position: 'relative' }}>
          <input
            type="text"
            className="topnav-search"
            placeholder="Search wiki"
            value={query}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => { if (results.length > 0) setOpen(true); }}
            style={{
              width: 192,
              height: 32,
              background: 'var(--bg-card-hover)',
              border: 'none',
              borderRadius: showDropdown ? '4px 4px 0 0' : 4,
              padding: '0 32px 0 12px',
              fontFamily: 'var(--font-body)',
              fontSize: 11,
              letterSpacing: '1.2px',
              textTransform: 'uppercase',
              color: 'var(--fg-secondary)',
              outline: 'none',
            }}
          />
          <Search
            size={13}
            style={{
              position: 'absolute',
              right: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--accent)',
              opacity: 0.5,
              pointerEvents: 'none',
            }}
          />

          {/* Dropdown */}
          {showDropdown && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                width: 320,
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderTop: 'none',
                borderRadius: '0 0 6px 6px',
                zIndex: 200,
                overflow: 'hidden',
              }}
            >
              {results.length === 0 ? (
                <div
                  style={{
                    padding: '10px 14px',
                    fontSize: 12,
                    color: 'var(--fg-dim)',
                    fontFamily: 'var(--font-body)',
                  }}
                >
                  No pages found
                </div>
              ) : (
                results.map((r, i) => (
                  <button
                    key={r.page_id}
                    onMouseDown={() => goToResult(r.page_id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      padding: '9px 14px',
                      background: selIndex === i ? 'var(--bg-card-hover)' : 'transparent',
                      border: 'none',
                      borderBottom: '1px solid rgba(var(--separator-rgb),0.08)',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                    onMouseEnter={() => setSelIndex(i)}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: PAGE_TYPE_VAR[r.page_type as keyof typeof PAGE_TYPE_VAR] ?? 'var(--fg-dim)',
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        fontSize: 13,
                        color: 'var(--fg)',
                        fontFamily: 'var(--font-body)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {r.title}
                    </span>
                    {r.category && (
                      <span
                        style={{
                          fontSize: 10,
                          color: 'var(--fg-dim)',
                          fontFamily: 'var(--font-mono)',
                          flexShrink: 0,
                        }}
                      >
                        {r.category}
                      </span>
                    )}
                  </button>
                ))
              )}

              {/* See all row */}
              <button
                onMouseDown={goToSearch}
                onMouseEnter={() => setSelIndex(results.length)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '9px 14px',
                  background: selIndex === results.length ? 'var(--bg-card-hover)' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <Search size={11} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--accent)',
                    fontFamily: 'var(--font-body)',
                  }}
                >
                  See all results for &ldquo;{query}&rdquo;
                </span>
              </button>
            </div>
          )}
        </div>

        {/* Settings */}
        <Link
          href="/settings"
          style={{
            display: 'flex',
            alignItems: 'center',
            color: pathname.startsWith('/settings') ? 'var(--accent)' : 'var(--fg-muted)',
            transition: 'color var(--transition-fast)',
          }}
        >
          <Settings size={16} />
        </Link>
      </div>
    </header>
  );
}
