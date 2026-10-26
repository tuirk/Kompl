'use client';

/**
 * /wiki/search — hybrid search: keyword and meaning matches together, so
 * plain-language questions find the right page (lib/search-client.ts).
 * Client component: search-as-you-type; a newer query cancels the one in
 * flight. Seeds from `?q=` so TopNav / header "See all" does not force
 * retyping.
 */

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createSearch, debounce, type SearchHit } from '../../../lib/search-client';
import WikiPageHeader from '../../../components/WikiPageHeader';
import { PAGE_TYPE_VAR } from '../../../lib/page-type-palette';
import { stripWikilinkBrackets } from '../../../lib/wikilink-render';
import { highlightParts } from '../../../lib/search-highlight';

/** The search API's default page size: a full list may have more behind it. */
const RESULT_LIMIT = 20;

/** Default export wraps the searchParams-dependent body in Suspense for Next prerender. */
export default function WikiSearchPage() {
  return (
    <Suspense
      fallback={
        <main style={{ maxWidth: 1040, margin: '0 auto', padding: '2.5rem 1.5rem' }}>
          <WikiPageHeader title="Search" />
          <p style={{ color: 'var(--fg-muted)', fontSize: 14 }}>Loading…</p>
        </main>
      }
    >
      <WikiSearchInner />
    </Suspense>
  );
}

function WikiSearchInner() {
  const searchParams = useSearchParams();
  const initialQ = (searchParams.get('q') ?? '').trim();
  const [query, setQuery] = useState(initialQ);
  // The query the shown results belong to, so marking matched words never
  // runs ahead of a search still waiting on the typing pause.
  const [resultQuery, setResultQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(!!initialQ);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // One runner for this box: a newer query cancels the one still in flight.
  // Lazy state keeps the runner and its debouncer for the component's life.
  const [runSearch] = useState(() => createSearch());
  const [search] = useState(() =>
    debounce(async (q: string) => {
      try {
        const items = await runSearch(q);
        // Replaced by a newer search, which ends the loading state, or by an
        // emptied box, which already did.
        if (items === null) return;
        setResults(items);
        setResultQuery(q);
        setError(null);
        setLoading(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'search error');
        setLoading(false);
      }
    }, 250)
  );

  // Empty box: drop the search waiting on the pause and the one in flight,
  // so neither fills the page afterwards.
  const clearSearch = useCallback(() => {
    search.cancel();
    runSearch.cancel();
    setResults([]);
    setError(null);
    setLoading(false);
  }, [search, runSearch]);

  // Leaving the page drops them too.
  useEffect(() => () => {
    search.cancel();
    runSearch.cancel();
  }, [search, runSearch]);

  // Seed from URL on mount and whenever `?q=` changes (TopNav push).
  useEffect(() => {
    const q = (searchParams.get('q') ?? '').trim();
    setQuery(q);
    if (q) {
      setLoading(true);
      search(q);
    } else {
      clearSearch();
    }
    inputRef.current?.focus();
  }, [searchParams, search, clearSearch]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value;
    setQuery(q);
    if (q.trim()) {
      setLoading(true);
      search(q);
    } else {
      clearSearch();
    }
  }

  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '2.5rem 1.5rem' }}>
      <WikiPageHeader title="Search" />

      <input
        ref={inputRef}
        type="text"
        placeholder="Search wiki…"
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

      <div role="status" aria-live="polite">
        {!loading && !error && query && results.length === 0 && (
          <div style={{ fontSize: 14 }}>
            <p style={{ margin: '0 0 0.35rem', color: 'var(--fg-secondary)' }}>
              No pages match &ldquo;{query}&rdquo;.
            </p>
            <p style={{ margin: 0, color: 'var(--fg-muted)' }}>
              Your wiki has nothing on this yet. Try other words, or add a source about it.
            </p>
          </div>
        )}
        {!loading && !error && query && results.length > 0 && (
          <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: '0 0 0.75rem' }}>
            {resultCountLabel(results.length)}
          </p>
        )}
      </div>

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
                background: PAGE_TYPE_VAR[page.page_type as keyof typeof PAGE_TYPE_VAR] ?? 'var(--fg-dim)',
                flexShrink: 0,
              }}
            />
            <span style={{ fontWeight: 500, fontSize: 14 }}>
              <Highlighted text={page.title} query={resultQuery} />
            </span>
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
              <Highlighted text={stripWikilinkBrackets(page.summary)} query={resultQuery} />
            </p>
          )}
        </Link>
      ))}
    </main>
  );
}

function resultCountLabel(n: number): string {
  if (n >= RESULT_LIMIT) return `Best ${n} matching pages`;
  return n === 1 ? '1 matching page' : `${n} matching pages`;
}

/** Text with the query's words marked (lib/search-highlight.ts). */
function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, i) =>
        part.match ? (
          <mark
            key={i}
            style={{
              background: 'rgba(var(--accent-rgb), 0.18)',
              color: 'var(--fg)',
              borderRadius: 2,
              padding: '0 1px',
            }}
          >
            {part.text}
          </mark>
        ) : (
          part.text
        )
      )}
    </>
  );
}
