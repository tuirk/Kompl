'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SavedLinkRow } from '../../../lib/db';
import { LocalDayMonth } from '../../../components/LocalDate';

interface ParsedMetadata {
  title?: string | null;
  description?: string | null;
  og_image?: string | null;
  author?: string | null;
  tweet_url?: string | null;
  date_saved?: string | null;
}

function parseMetadata(raw: string | null): ParsedMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as ParsedMetadata;
  } catch {
    /* ignore malformed JSON */
  }
  return {};
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

type ModalState =
  | { kind: 'delete-single'; failureId: string; title: string }
  | { kind: 'delete-bulk'; ids: string[] };

const COL = '40px 110px 1fr 110px';

const btnBase: React.CSSProperties = {
  fontFamily: 'var(--font-body)',
  fontWeight: 700,
  fontSize: 9,
  letterSpacing: '0.8px',
  textTransform: 'uppercase',
  padding: '3px 7px',
  background: 'transparent',
  cursor: 'pointer',
  border: 'none',
  lineHeight: 1.4,
};

const btnDanger: React.CSSProperties = {
  ...btnBase,
  color: 'var(--danger)',
  border: '1px solid rgba(var(--danger-rgb),0.35)',
};

const btnSolid: React.CSSProperties = {
  ...btnBase,
  color: 'var(--danger)',
  background: 'rgba(var(--danger-rgb),0.1)',
  border: '1px solid rgba(var(--danger-rgb),0.5)',
  padding: '5px 14px',
  fontSize: 10,
};

const btnOutline: React.CSSProperties = {
  ...btnBase,
  color: 'var(--fg-dim)',
  border: '1px solid rgba(var(--separator-rgb),0.4)',
  padding: '5px 14px',
  fontSize: 10,
};

export default function SavedLinksInteractive({
  initialLinks,
}: {
  initialLinks: SavedLinkRow[];
}) {
  const [links, setLinks] = useState<SavedLinkRow[]>(initialLinks);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [errorIds, setErrorIds] = useState<Map<string, string>>(new Map());
  const [modal, setModal] = useState<ModalState | null>(null);

  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) return;
    const all = links.length > 0 && selectedIds.size === links.length;
    const some = selectedIds.size > 0 && selectedIds.size < links.length;
    el.checked = all;
    el.indeterminate = some;
  }, [selectedIds, links.length]);

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) =>
      prev.size === links.length ? new Set() : new Set(links.map((l) => l.failure_id)),
    );
  }, [links]);

  const toggleRow = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleDelete = useCallback(async (failureId: string) => {
    setModal(null);

    const saved = links.find((l) => l.failure_id === failureId);
    const savedIndex = links.findIndex((l) => l.failure_id === failureId);

    setLoadingIds((prev) => new Set(prev).add(failureId));
    setErrorIds((prev) => { const m = new Map(prev); m.delete(failureId); return m; });
    setLinks((prev) => prev.filter((l) => l.failure_id !== failureId));
    setSelectedIds((prev) => { const n = new Set(prev); n.delete(failureId); return n; });

    try {
      const res = await fetch(`/api/saved-links/${failureId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`${res.status}`);
    } catch {
      if (saved !== undefined) {
        setLinks((prev) => {
          const next = [...prev];
          next.splice(savedIndex, 0, saved);
          return next;
        });
      }
      setErrorIds((prev) => new Map(prev).set(failureId, 'Failed — try again'));
    } finally {
      setLoadingIds((prev) => { const s = new Set(prev); s.delete(failureId); return s; });
    }
  }, [links]);

  const handleBulkDelete = useCallback(async (ids: string[]) => {
    setModal(null);

    const saved = new Map(ids.map((id) => {
      const idx = links.findIndex((l) => l.failure_id === id);
      return [id, { row: links[idx], idx }] as [string, { row: SavedLinkRow; idx: number }];
    }));

    setLoadingIds((prev) => { const s = new Set(prev); ids.forEach((id) => s.add(id)); return s; });
    setLinks((prev) => prev.filter((l) => !ids.includes(l.failure_id)));
    setSelectedIds(new Set());

    try {
      const res = await fetch('/api/saved-links', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ failure_ids: ids }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
    } catch {
      setLinks((prev) => {
        const next = [...prev];
        [...ids]
          .map((id) => saved.get(id)!)
          .filter((s) => s?.row)
          .sort((a, b) => a.idx - b.idx)
          .forEach(({ row, idx }) => next.splice(Math.min(idx, next.length), 0, row));
        return next;
      });
      setErrorIds((prev) => {
        const m = new Map(prev);
        ids.forEach((id) => m.set(id, 'Failed — try again'));
        return m;
      });
    } finally {
      setLoadingIds((prev) => { const s = new Set(prev); ids.forEach((id) => s.delete(id)); return s; });
    }
  }, [links]);

  const selectedArray = useMemo(() => [...selectedIds], [selectedIds]);

  if (links.length === 0) {
    return (
      <div style={{
        padding: '2rem',
        fontFamily: 'var(--font-body)',
        fontSize: 14,
        color: 'var(--fg-muted)',
        border: '1px solid rgba(var(--separator-rgb),0.15)',
        background: 'var(--bg-card)',
      }}>
        All saved links have been imported into your wiki.
      </div>
    );
  }

  return (
    <>
      {selectedIds.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 24px',
          background: 'var(--bg-card-hover)',
          border: '1px solid rgba(var(--separator-rgb),0.15)',
          borderBottom: 'none',
        }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', letterSpacing: '0.5px' }}>
            {selectedIds.size} selected
          </span>
          <button
            style={{ ...btnDanger, padding: '5px 14px', fontSize: 10, opacity: loadingIds.size > 0 ? 0.5 : 1 }}
            disabled={loadingIds.size > 0}
            onClick={() => setModal({ kind: 'delete-bulk', ids: selectedArray })}
          >
            Remove ({selectedIds.size})
          </button>
        </div>
      )}

      <div style={{ background: 'var(--bg-card)' }}>
        {/* Header */}
        <div style={{ display: 'grid', gridTemplateColumns: COL, background: 'var(--bg-card-hover)', padding: '0 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '16px 0' }}>
            <input
              ref={selectAllRef}
              type="checkbox"
              onChange={toggleAll}
              style={{ accentColor: 'var(--accent)', cursor: 'pointer', margin: 0 }}
              aria-label="Select all saved links"
            />
          </div>
          {['Date', 'Link', 'Action'].map((col, i) => (
            <div
              key={col}
              style={{
                padding: '16px 0',
                fontFamily: 'var(--font-body)', fontWeight: 700,
                fontSize: 10, letterSpacing: '1px', textTransform: 'uppercase',
                color: 'var(--fg-dim)',
                textAlign: i === 2 ? 'right' : 'left',
              }}
            >
              {col}
            </div>
          ))}
        </div>

        {links.map((link) => {
          const meta = parseMetadata(link.metadata);
          const isLoading = loadingIds.has(link.failure_id);
          const errorMsg = errorIds.get(link.failure_id);
          const isSelected = selectedIds.has(link.failure_id);
          const displayTitle = link.title ?? meta.title ?? link.source_url;
          const author = meta.author ?? null;
          const metaParts = [
            author,
            hostnameOf(link.source_url),
            link.error,
          ].filter((p): p is string => !!p);

          return (
            <div
              key={link.failure_id}
              style={{
                display: 'grid',
                gridTemplateColumns: COL,
                padding: '0 24px',
                borderTop: '1px solid rgba(var(--separator-rgb),0.1)',
                alignItems: 'center',
                background: isSelected ? 'rgba(152,255,217,0.03)' : undefined,
                transition: 'background 150ms',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleRow(link.failure_id)}
                  style={{ accentColor: 'var(--accent)', cursor: 'pointer', margin: 0 }}
                  aria-label={`Select ${displayTitle}`}
                />
              </div>

              <div style={{ padding: '20px 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-secondary)' }}>
                <LocalDayMonth iso={link.date_saved ?? link.date_attempted} />
              </div>

              <div style={{ padding: '16px 0', minWidth: 0 }}>
                <div style={{
                  fontFamily: 'var(--font-heading)', fontWeight: 400, fontSize: 14,
                  color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {displayTitle}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', marginTop: 2 }}>
                  {metaParts.join(' · ')}
                </div>
                {meta.description && (
                  <div style={{
                    fontFamily: 'var(--font-body)', fontStyle: 'italic', fontSize: 12,
                    color: 'var(--fg-muted)', marginTop: 4, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {meta.description}
                  </div>
                )}
                {errorMsg && (
                  <div style={{
                    fontFamily: 'var(--font-mono)', fontSize: 9,
                    color: 'var(--danger)', marginTop: 3, letterSpacing: '0.3px',
                  }}>
                    {errorMsg}
                  </div>
                )}
              </div>

              <div style={{ padding: '20px 0', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                <a
                  href={link.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 10,
                    letterSpacing: '1px', textTransform: 'uppercase',
                    color: 'var(--accent)', textDecoration: 'none',
                  }}
                >
                  View
                </a>
                {isLoading ? (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', minWidth: 60, textAlign: 'right' }}>
                    …
                  </span>
                ) : (
                  <button
                    style={btnDanger}
                    onClick={() => setModal({
                      kind: 'delete-single',
                      failureId: link.failure_id,
                      title: displayTitle,
                    })}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {modal && (
        <div
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(13,14,16,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setModal(null)}
        >
          <div
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-hover)',
              padding: '28px 32px',
              minWidth: 360,
              maxWidth: 440,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <p style={{
              fontFamily: 'var(--font-heading)', fontWeight: 700,
              fontSize: 14, letterSpacing: '1px', textTransform: 'uppercase',
              color: 'var(--fg)', margin: '0 0 12px',
            }}>
              {modal.kind === 'delete-bulk' ? `Remove ${modal.ids.length} Saved Links` : 'Remove Saved Link'}
            </p>
            <p style={{
              fontFamily: 'var(--font-body)', fontSize: 13,
              color: 'var(--fg-secondary)', lineHeight: 1.6,
              margin: '0 0 24px',
            }}>
              {modal.kind === 'delete-single'
                ? <>Remove <strong>{modal.title}</strong> from this list? You can reingest them later through add sources.</>
                : <>Remove <strong>{modal.ids.length} saved link{modal.ids.length !== 1 ? 's' : ''}</strong> from this list? You can reingest them later through add sources.</>
              }
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={btnOutline} onClick={() => setModal(null)}>
                Cancel
              </button>
              <button
                style={btnSolid}
                onClick={() =>
                  modal.kind === 'delete-single'
                    ? handleDelete(modal.failureId)
                    : handleBulkDelete(modal.ids)
                }
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
