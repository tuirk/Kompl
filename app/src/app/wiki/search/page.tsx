'use client';

/**
 * /wiki/search — Full-text search against pages_fts (FTS5).
 * Client component: search-as-you-type via /api/pages/search.
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageRow } from '../../../lib/db';
import WikiPageHeader from '../../../components/WikiPageHeader';

interface SearchResult {
  items: PageRow[];
  count: number;
}

function debounce<T extends (...args: Parameters<T>) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

const PAGE_TYPE_COLORS: Record<string, string> = {
  'source-summary': 'var(--fg-dim)',
  concept: 'var(--accent)',
  entity: 'var(--warning)',
  topic: 'var(--success)',
};

export default function WikiSearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const search = useCallback(
    debounce(async (q: string) => {
      if (!q.trim()) {
        setResults([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const res = await fetch(`/api/pages/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error(`search failed: ${res.status}`);
        const data = (await res.json()) as SearchResult;
        setResults(data.items);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'search error');
      } finally {
        setLoading(false);
      }
    }, 250),
    []
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value;
    setQuery(q);
    setLoading(!!q.trim());
    search(q);
  }

  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '2.5rem 1.5rem' }}>
      <WikiPageHeader title="Search" />

      <input
        ref={inputRef}
        type="text"
        placeholder="Search pages…"
        value={query}
        onChange={handleChange}
        style={{ marginBottom: '1.5rem', fontSize: 15 }}
      />

      {error && (
        <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: '1rem' }}>{error}</div>
      )}

      {loading && (
        <p style={{ color: 'var(--fg-muted)', fontSize: 14 }}>Searching…</p>
      )}

      {!loading && query && results.length === 0 && (
        <p style={{ color: 'var(--fg-muted)', fontSize: 14 }}>
          No pages found for &ldquo;{query}&rdquo;.
        </p>
      )}

      {results.map((page) => (
        <Link
          key={page.page_id}
          href={`/wiki/${page.page_id}`}
          style={{
            display: 'block',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 7,
            padding: '0.85rem 1rem',
            marginBottom: '0.6rem',
            color: 'inherit',
            textDecoration: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.3rem' }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: PAGE_TYPE_COLORS[page.page_type] ?? 'var(--fg-dim)',
                flexShrink: 0,
              }}
            />
            <span style={{ fontWeight: 500, fontSize: 14 }}>{page.title}</span>
            {page.category && (
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 11,
                  color: 'var(--fg-dim)',
                  flexShrink: 0,
                }}
              >
                {page.category}
              </span>
            )}
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
      ))}
    </main>
  );
}
