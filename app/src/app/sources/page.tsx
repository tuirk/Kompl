'use client';

/**
 * /sources — Browse all ingested sources.
 * Client component — fetches from /api/sources and provides live filter controls.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import SourcesTable, { type SourceWithCount } from './SourcesTable';

// ─── Shared input/select style ────────────────────────────────────────────────

const controlStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  color: 'var(--fg)',
  borderRadius: '6px',
  padding: '0.4rem 0.75rem',
  fontSize: '0.85rem',
  fontFamily: 'var(--font-mono)',
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SourcesPage() {
  const [sources, setSources] = useState<SourceWithCount[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // ── Init from URL params (once on mount) ──
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const olderThan = p.get('older_than');
    if (olderThan && parseInt(olderThan, 10) > 0) {
      const cutoff = new Date(Date.now() - parseInt(olderThan, 10) * 24 * 60 * 60 * 1000);
      setDateTo(cutoff.toISOString().split('T')[0]);
    }
    if (p.get('status'))      setStatusFilter(p.get('status')!);
    if (p.get('source_type')) setTypeFilter(p.get('source_type')!);
    if (p.get('date_from'))   setDateFrom(p.get('date_from')!);
    if (p.get('date_to'))     setDateTo(p.get('date_to')!);
    if (p.get('search'))      { setSearchQuery(p.get('search')!); setDebouncedSearch(p.get('search')!); }
  }, []);

  // ── Debounce search 300ms ──
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // ── Fetch on any filter change ──
  useEffect(() => {
    const controller = new AbortController();

    const p = new URLSearchParams();
    if (statusFilter)    p.set('status',      statusFilter);
    if (typeFilter)      p.set('source_type', typeFilter);
    if (dateFrom)        p.set('date_from',   dateFrom);
    if (dateTo)          p.set('date_to',     dateTo);
    if (debouncedSearch) p.set('search',      debouncedSearch);
    p.set('limit', '500');

    setError(null);
    setLoading(true);
    fetch(`/api/sources?${p}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data: { sources: SourceWithCount[]; total: number }) => {
        setSources(data.sources);
        setTotal(data.total);
      })
      .catch((err) => {
        if ((err as Error).name !== 'AbortError') {
          setError('Failed to load sources — try refreshing.');
        }
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [statusFilter, typeFilter, dateFrom, dateTo, debouncedSearch]);

  // ── Refetch for mutation-triggered refreshes (archive/delete) ──
  // Separate from the useEffect above — no AbortController needed for
  // deliberate single-shot refreshes triggered by user actions in SourcesTable.
  const refetch = useCallback(() => {
    const p = new URLSearchParams();
    if (statusFilter)    p.set('status',      statusFilter);
    if (typeFilter)      p.set('source_type', typeFilter);
    if (dateFrom)        p.set('date_from',   dateFrom);
    if (dateTo)          p.set('date_to',     dateTo);
    if (debouncedSearch) p.set('search',      debouncedSearch);
    p.set('limit', '500');

    setError(null);
    setLoading(true);
    fetch(`/api/sources?${p}`)
      .then((r) => r.json())
      .then((data: { sources: SourceWithCount[]; total: number }) => {
        setSources(data.sources);
        setTotal(data.total);
      })
      .catch(() => {
        setError('Failed to load sources. Try refreshing.');
      })
      .finally(() => setLoading(false));
  }, [statusFilter, typeFilter, dateFrom, dateTo, debouncedSearch]);

  // ── Filter indicators ──
  // showClearButton: visible as soon as user starts typing (even during debounce)
  const showClearButton = !!(statusFilter || typeFilter || dateFrom || dateTo || searchQuery);
  // activeFiltersApplied: truthful — reflects what was actually fetched
  const activeFiltersApplied = !!(statusFilter || typeFilter || dateFrom || dateTo || debouncedSearch);

  const clearAllFilters = () => {
    setStatusFilter('');
    setTypeFilter('');
    setDateFrom('');
    setDateTo('');
    setSearchQuery('');
  };

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '2rem 40px 5rem' }}>
      {/* Back link */}
      <Link
        href="/"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontFamily: 'var(--font-mono)', fontSize: 10,
          textTransform: 'uppercase', letterSpacing: '1px',
          color: 'var(--fg-dim)', textDecoration: 'none',
          marginBottom: 24,
        }}
      >
        ← Dashboard
      </Link>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 24, letterSpacing: '1.8px', textTransform: 'uppercase', color: 'var(--fg)', margin: 0 }}>
            Sources
          </h1>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', letterSpacing: '0.5px', margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 8 }}>
            {loading
              ? 'Loading…'
              : activeFiltersApplied
                ? <>{total} filtered · <a href="/sources" style={{ color: 'var(--fg-dim)', textDecoration: 'underline' }}>show all</a></>
                : <>{total} total</>
            }
          </p>
        </div>
        <Link
          href="/onboarding?mode=add"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '10px 20px',
            background: 'var(--accent)',
            fontFamily: 'var(--font-heading)',
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: '1px',
            textTransform: 'uppercase',
            color: 'var(--accent-text)',
            textDecoration: 'none',
          }}
        >
          + Add Sources
        </Link>
      </div>

      {/* Filter bar */}
      <div style={{
        display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center',
        padding: '1rem 0', borderBottom: '1px solid var(--border)', marginBottom: '1.5rem',
      }}>
        {/* Status */}
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={controlStyle}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="failed">Failed</option>
        </select>

        {/* Source type */}
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={controlStyle}>
          <option value="">All types</option>
          <option value="url">URL</option>
          <option value="file-upload">File upload</option>
          <option value="text">Note</option>
          <option value="tweet">Tweet</option>
        </select>

        {/* Date range */}
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          style={controlStyle}
          title="Ingested from"
        />
        <span style={{ color: 'var(--fg-secondary)', fontSize: '0.85rem' }}>—</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          style={controlStyle}
          title="Ingested to"
        />

        {/* Title search */}
        <input
          type="search"
          placeholder="Search titles…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{ ...controlStyle, minWidth: '200px' }}
        />

        {/* Clear filters */}
        {showClearButton && (
          <button
            onClick={clearAllFilters}
            style={{
              fontSize: '0.8rem', color: 'var(--accent)', background: 'none',
              border: 'none', cursor: 'pointer', padding: '0.4rem',
              fontFamily: 'var(--font-mono)',
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <p style={{ color: 'var(--danger)', fontFamily: 'var(--font-mono)', fontSize: 12, marginBottom: '1rem' }}>
          {error}
        </p>
      )}

      {/* Content */}
      {loading ? (
        <p style={{ color: 'var(--fg-dim)', fontFamily: 'var(--font-mono)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Loading…</p>
      ) : sources.length === 0 ? (
        <p style={{ color: 'var(--fg-dim)', fontFamily: 'var(--font-mono)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {activeFiltersApplied ? 'No sources match the current filters.' : 'No sources yet.'}
        </p>
      ) : (
        <SourcesTable initialSources={sources} onMutation={refetch} />
      )}
    </main>
  );
}
