'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search, Upload, Network } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { PAGE_TYPE_VAR } from '../lib/page-type-palette';

const ACTION_WIDTH = 220;

interface SearchResult {
  page_id: string;
  title: string;
  page_type: string;
  category: string | null;
}

function debounce<T extends (...args: Parameters<T>) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

export default function WikiPageHeaderActions() {
  const router = useRouter();

  const [query,    setQuery]    = useState('');
  const [results,  setResults]  = useState<SearchResult[]>([]);
  const [open,     setOpen]     = useState(false);
  const [selIndex, setSelIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);

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

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const total = results.length + 1;
    if (e.key === 'Escape') { setQuery(''); setResults([]); setOpen(false); setSelIndex(-1); return; }
    if (e.key === 'ArrowDown' && open) { e.preventDefault(); setSelIndex((i) => (i + 1) % total); return; }
    if (e.key === 'ArrowUp'   && open) { e.preventDefault(); setSelIndex((i) => (i - 1 + total) % total); return; }
    if (e.key === 'Enter' && query.trim()) {
      e.preventDefault();
      if (open && selIndex >= 0 && selIndex < results.length) {
        router.push(`/wiki/${results[selIndex].page_id}`);
      } else {
        router.push(`/wiki/search?q=${encodeURIComponent(query.trim())}`);
      }
      setOpen(false); setSelIndex(-1);
    }
  }

  const showDropdown = open && query.trim().length >= 2;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0, width: ACTION_WIDTH }}>

      {/* Graph — outline */}
      <Link
        href="/wiki/graph"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%', padding: '9px 14px', boxSizing: 'border-box',
          background: 'var(--bg-card-hover)',
          border: '1px solid rgba(var(--accent-rgb),0.2)',
          fontFamily: 'var(--font-heading)',
          fontWeight: 700, fontSize: 10, lineHeight: '15px',
          letterSpacing: 1, textTransform: 'uppercase',
          color: 'var(--accent)', textDecoration: 'none',
        }}
      >
        Knowledge Graph
        <Network size={12} style={{ opacity: 0.7 }} />
      </Link>

      {/* Add Sources — filled */}
      <Link
        href="/onboarding?mode=add"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%', padding: '9px 14px', boxSizing: 'border-box',
          background: 'var(--accent)',
          border: 'none',
          fontFamily: 'var(--font-heading)',
          fontWeight: 700, fontSize: 10, lineHeight: '15px',
          letterSpacing: 1, textTransform: 'uppercase',
          color: 'var(--accent-text)', textDecoration: 'none',
        }}
      >
        Add Sources
        <Upload size={12} style={{ color: 'var(--accent-text)' }} />
      </Link>

      {/* Search bar */}
      <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
        <input
          type="text"
          placeholder="Search wiki"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (results.length > 0) setOpen(true); }}
          style={{
            width: '100%', boxSizing: 'border-box',
            height: 34,
            background: 'var(--bg-card-hover)',
            border: showDropdown
              ? '1px solid rgba(var(--accent-rgb),0.3)'
              : '1px solid rgba(var(--accent-rgb),0.12)',
            borderRadius: showDropdown ? '4px 4px 0 0' : 4,
            padding: '0 32px 0 12px',
            fontFamily: 'var(--font-body)',
            fontSize: 11, letterSpacing: '1.2px', textTransform: 'uppercase',
            color: 'var(--fg-secondary)', outline: 'none',
          }}
        />
        <Search
          size={12}
          style={{
            position: 'absolute', right: 10, top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--accent)', opacity: 0.5, pointerEvents: 'none',
          }}
        />

        {showDropdown && (
          <div
            style={{
              position: 'absolute', top: '100%', right: 0,
              width: Math.max(ACTION_WIDTH, 300),
              background: 'var(--bg-card)',
              border: '1px solid var(--border)', borderTop: 'none',
              borderRadius: '0 0 6px 6px',
              zIndex: 200, overflow: 'hidden',
            }}
          >
            {results.length === 0 ? (
              <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--fg-dim)', fontFamily: 'var(--font-body)' }}>
                No pages found
              </div>
            ) : (
              results.map((r, i) => (
                <button
                  key={r.page_id}
                  onMouseDown={() => { setOpen(false); setQuery(''); setResults([]); router.push(`/wiki/${r.page_id}`); }}
                  onMouseEnter={() => setSelIndex(i)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    width: '100%', padding: '9px 14px', textAlign: 'left',
                    background: selIndex === i ? 'var(--bg-card-hover)' : 'transparent',
                    border: 'none', borderBottom: '1px solid rgba(var(--separator-rgb),0.08)',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: PAGE_TYPE_VAR[r.page_type as keyof typeof PAGE_TYPE_VAR] ?? 'var(--fg-dim)',
                    flexShrink: 0,
                  }} />
                  <span style={{
                    flex: 1, fontSize: 13, color: 'var(--fg)', fontFamily: 'var(--font-body)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {r.title}
                  </span>
                  {r.category && (
                    <span style={{ fontSize: 10, color: 'var(--fg-dim)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                      {r.category}
                    </span>
                  )}
                </button>
              ))
            )}
            <button
              onMouseDown={() => { setOpen(false); setSelIndex(-1); router.push(`/wiki/search?q=${encodeURIComponent(query.trim())}`); }}
              onMouseEnter={() => setSelIndex(results.length)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', padding: '9px 14px', textAlign: 'left',
                background: selIndex === results.length ? 'var(--bg-card-hover)' : 'transparent',
                border: 'none', cursor: 'pointer',
              }}
            >
              <Search size={11} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: 'var(--accent)', fontFamily: 'var(--font-body)' }}>
                See all results for &ldquo;{query}&rdquo;
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
