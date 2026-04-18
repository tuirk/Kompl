'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { SourceRow } from '../../lib/db';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SourceWithCount extends SourceRow {
  page_count: number;
}

interface BadgeCfg {
  bg: string;
  border: string;
  color: string;
  label: string;
}

type ModalState =
  | { kind: 'delete-single'; sourceId: string; title: string }
  | { kind: 'delete-bulk'; ids: string[] };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  if (isNaN(d.getTime())) return iso;
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function getStatusBadge(source: SourceRow): BadgeCfg {
  if (source.status === 'archived') {
    return { bg: 'rgba(var(--separator-rgb),0.1)', border: 'rgba(var(--separator-rgb),0.2)', color: 'var(--fg-dim)', label: 'ARCHIVED' };
  }
  switch (source.compile_status) {
    case 'active':
      return { bg: 'rgba(var(--separator-rgb),0.1)', border: 'rgba(var(--separator-rgb),0.2)', color: 'var(--fg)', label: 'ACTIVE' };
    case 'failed':
      return { bg: 'rgba(var(--danger-rgb),0.1)', border: 'rgba(var(--danger-rgb),0.2)', color: 'var(--danger)', label: 'FAILED' };
    case 'in_progress':
    case 'extracted':
      return { bg: 'rgba(var(--accent-rgb),0.1)', border: 'rgba(var(--accent-rgb),0.2)', color: 'var(--accent)', label: 'INDEXING' };
    default:
      return { bg: 'rgba(var(--separator-rgb),0.1)', border: 'rgba(var(--separator-rgb),0.2)', color: 'var(--fg-dim)', label: 'PENDING' };
  }
}

// ─── Button style helpers ──────────────────────────────────────────────────────

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

const btnGhost: React.CSSProperties = {
  ...btnBase,
  color: 'var(--fg-dim)',
  border: '1px solid rgba(var(--separator-rgb),0.3)',
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

// ─── Column template ───────────────────────────────────────────────────────────

const COL = '40px 120px 1fr 140px 200px';

// ─── Main component ───────────────────────────────────────────────────────────

export default function SourcesTable({ initialSources, onMutation }: { initialSources: SourceWithCount[]; onMutation?: () => void }) {
  const [sources, setSources] = useState<SourceWithCount[]>(initialSources);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [errorIds, setErrorIds] = useState<Map<string, string>>(new Map());
  const [modal, setModal] = useState<ModalState | null>(null);

  // "Select all" checkbox ref for indeterminate state
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) return;
    const all = sources.length > 0 && selectedIds.size === sources.length;
    const some = selectedIds.size > 0 && selectedIds.size < sources.length;
    el.checked = all;
    el.indeterminate = some;
  }, [selectedIds, sources.length]);

  // Sync rows whenever the parent passes new filtered data.
  // useState(initialSources) only captures the mount-time value — without this
  // effect, filter changes in the parent page never update the table rows.
  // Selection is also cleared: filtered views show different rows, so stale
  // selections would cause phantom "X selected" display and broken checkbox state.
  useEffect(() => {
    setSources(initialSources);
    setSelectedIds(new Set());
  }, [initialSources]);

  // ─── Selection helpers ──────────────────────────────────────────────────────

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) =>
      prev.size === sources.length ? new Set() : new Set(sources.map((s) => s.source_id))
    );
  }, [sources]);

  const toggleRow = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // ─── Archive single ─────────────────────────────────────────────────────────

  const handleArchive = useCallback(async (sourceId: string, currentStatus: string) => {
    const newStatus = currentStatus === 'archived' ? 'active' : 'archived';

    setLoadingIds((prev) => new Set(prev).add(sourceId));
    setErrorIds((prev) => { const m = new Map(prev); m.delete(sourceId); return m; });

    // Optimistic update
    setSources((prev) => prev.map((s) => s.source_id === sourceId ? { ...s, status: newStatus } : s));

    try {
      const res = await fetch(`/api/sources/${sourceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      onMutation?.();
    } catch {
      // Revert
      setSources((prev) => prev.map((s) => s.source_id === sourceId ? { ...s, status: currentStatus } : s));
      setErrorIds((prev) => new Map(prev).set(sourceId, 'Failed — try again'));
    } finally {
      setLoadingIds((prev) => { const s = new Set(prev); s.delete(sourceId); return s; });
    }
  }, [onMutation]);

  // ─── Delete single ──────────────────────────────────────────────────────────

  const handleDelete = useCallback(async (sourceId: string) => {
    setModal(null);

    // Save for rollback
    const saved = sources.find((s) => s.source_id === sourceId);
    const savedIndex = sources.findIndex((s) => s.source_id === sourceId);

    setLoadingIds((prev) => new Set(prev).add(sourceId));
    setErrorIds((prev) => { const m = new Map(prev); m.delete(sourceId); return m; });
    setSources((prev) => prev.filter((s) => s.source_id !== sourceId));
    setSelectedIds((prev) => { const n = new Set(prev); n.delete(sourceId); return n; });

    try {
      const res = await fetch(`/api/sources/${sourceId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`${res.status}`);
      onMutation?.();
    } catch {
      // Revert — re-insert at original index
      if (saved !== undefined) {
        setSources((prev) => {
          const next = [...prev];
          next.splice(savedIndex, 0, saved);
          return next;
        });
      }
      setErrorIds((prev) => new Map(prev).set(sourceId, 'Failed — try again'));
    } finally {
      setLoadingIds((prev) => { const s = new Set(prev); s.delete(sourceId); return s; });
    }
  }, [sources, onMutation]);

  // ─── Bulk archive / unarchive ───────────────────────────────────────────────

  const bulkSetStatus = useCallback(async (
    ids: string[],
    target: 'archived' | 'active',
  ) => {
    if (ids.length === 0) return;
    setLoadingIds((prev) => { const s = new Set(prev); ids.forEach((id) => s.add(id)); return s; });

    const prev_statuses = new Map(ids.map((id) => {
      const s = sources.find((r) => r.source_id === id);
      return [id, s?.status ?? 'active'] as [string, string];
    }));
    setSources((prev) => prev.map((s) => ids.includes(s.source_id) ? { ...s, status: target } : s));

    const results = await Promise.allSettled(
      ids.map((id) =>
        fetch(`/api/sources/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: target }),
        }).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return id; })
      )
    );

    const failed = new Set<string>();
    results.forEach((r, i) => { if (r.status === 'rejected') failed.add(ids[i]); });

    if (failed.size > 0) {
      setSources((prev) => prev.map((s) =>
        failed.has(s.source_id) ? { ...s, status: prev_statuses.get(s.source_id) ?? 'active' } : s
      ));
      setErrorIds((prev) => {
        const m = new Map(prev);
        failed.forEach((id) => m.set(id, 'Failed — try again'));
        return m;
      });
    }

    setLoadingIds((prev) => { const s = new Set(prev); ids.forEach((id) => s.delete(id)); return s; });
    setSelectedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => { if (!failed.has(id)) next.delete(id); });
      return next;
    });
    onMutation?.();
  }, [sources, onMutation]);

  const { archivableIds, unarchivableIds } = useMemo(() => {
    const arch: string[] = [];
    const unarch: string[] = [];
    for (const id of selectedIds) {
      const s = sources.find((r) => r.source_id === id);
      if (!s) continue;
      if (s.status === 'archived') unarch.push(id);
      else arch.push(id);
    }
    return { archivableIds: arch, unarchivableIds: unarch };
  }, [selectedIds, sources]);

  const handleBulkArchive = useCallback(
    () => bulkSetStatus(archivableIds, 'archived'),
    [bulkSetStatus, archivableIds],
  );
  const handleBulkUnarchive = useCallback(
    () => bulkSetStatus(unarchivableIds, 'active'),
    [bulkSetStatus, unarchivableIds],
  );

  // ─── Bulk delete ────────────────────────────────────────────────────────────

  const handleBulkDelete = useCallback(async (ids: string[]) => {
    setModal(null);

    // Save for rollback
    const saved = new Map(ids.map((id) => {
      const idx = sources.findIndex((s) => s.source_id === id);
      return [id, { row: sources[idx], idx }] as [string, { row: SourceWithCount; idx: number }];
    }));

    setLoadingIds((prev) => { const s = new Set(prev); ids.forEach((id) => s.add(id)); return s; });
    setSources((prev) => prev.filter((s) => !ids.includes(s.source_id)));
    setSelectedIds(new Set());

    const results = await Promise.allSettled(
      ids.map((id) =>
        fetch(`/api/sources/${id}`, { method: 'DELETE' })
          .then((r) => { if (!r.ok && r.status !== 204) throw new Error(`${r.status}`); return id; })
      )
    );

    const failed = new Set<string>();
    results.forEach((r, i) => { if (r.status === 'rejected') failed.add(ids[i]); });

    if (failed.size > 0) {
      // Re-insert failed rows at their original positions
      setSources((prev) => {
        const next = [...prev];
        [...failed]
          .map((id) => saved.get(id)!)
          .sort((a, b) => a.idx - b.idx)
          .forEach(({ row, idx }) => next.splice(Math.min(idx, next.length), 0, row));
        return next;
      });
      setErrorIds((prev) => {
        const m = new Map(prev);
        failed.forEach((id) => m.set(id, 'Failed — try again'));
        return m;
      });
    }

    setLoadingIds((prev) => { const s = new Set(prev); ids.forEach((id) => s.delete(id)); return s; });
    onMutation?.();
  }, [sources, onMutation]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Bulk toolbar */}
      {selectedIds.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 24px',
          background: 'var(--bg-card-hover)',
          border: '1px solid rgba(var(--separator-rgb),0.15)',
          borderBottom: 'none',
          marginBottom: 0,
        }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', letterSpacing: '0.5px' }}>
            {selectedIds.size} selected
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            {archivableIds.length > 0 && (
              <button
                style={{ ...btnOutline, opacity: loadingIds.size > 0 ? 0.5 : 1 }}
                disabled={loadingIds.size > 0}
                onClick={handleBulkArchive}
              >
                Archive ({archivableIds.length})
              </button>
            )}
            {unarchivableIds.length > 0 && (
              <button
                style={{ ...btnOutline, opacity: loadingIds.size > 0 ? 0.5 : 1 }}
                disabled={loadingIds.size > 0}
                onClick={handleBulkUnarchive}
              >
                Unarchive ({unarchivableIds.length})
              </button>
            )}
            <button
              style={{ ...btnDanger, padding: '5px 14px', fontSize: 10, opacity: loadingIds.size > 0 ? 0.5 : 1 }}
              disabled={loadingIds.size > 0}
              onClick={() => setModal({ kind: 'delete-bulk', ids: [...selectedIds] })}
            >
              Delete ({selectedIds.size})
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div style={{ background: 'var(--bg-card)' }}>
        {/* Header */}
        <div style={{ display: 'grid', gridTemplateColumns: COL, background: 'var(--bg-card-hover)', padding: '0 24px' }}>
          {/* Checkbox column */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '16px 0' }}>
            <input
              ref={selectAllRef}
              type="checkbox"
              onChange={toggleAll}
              style={{ accentColor: 'var(--accent)', cursor: 'pointer', margin: 0 }}
              aria-label="Select all sources"
            />
          </div>
          {['Date', 'Source', 'Status', 'Action'].map((col, i) => (
            <div
              key={col}
              style={{
                padding: '16px 0',
                fontFamily: 'var(--font-body)', fontWeight: 700,
                fontSize: 10, letterSpacing: '1px', textTransform: 'uppercase',
                color: 'var(--fg-dim)',
                textAlign: i === 3 ? 'right' : 'left',
              }}
            >
              {col}
            </div>
          ))}
        </div>

        {/* Rows */}
        {sources.map((s) => {
          const badge = getStatusBadge(s);
          const isLoading = loadingIds.has(s.source_id);
          const error = errorIds.get(s.source_id);
          const isSelected = selectedIds.has(s.source_id);

          return (
            <div
              key={s.source_id}
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
              {/* Checkbox */}
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleRow(s.source_id)}
                  style={{ accentColor: 'var(--accent)', cursor: 'pointer', margin: 0 }}
                  aria-label={`Select ${s.title}`}
                />
              </div>

              {/* Date */}
              <div style={{ padding: '20px 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-secondary)' }}>
                {formatDate(s.date_ingested)}
              </div>

              {/* Source title + meta */}
              <div style={{ padding: '16px 0', minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 400, fontSize: 14, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.title}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', marginTop: 2 }}>
                  {s.source_type}
                  {s.page_count > 0 ? ` · ${s.page_count} page${s.page_count !== 1 ? 's' : ''}` : ''}
                </div>
                {error && (
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--danger)', marginTop: 3, letterSpacing: '0.3px' }}>
                    {error}
                  </div>
                )}
              </div>

              {/* Status badge */}
              <div style={{ padding: '17px 0' }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center',
                  padding: '2px 8px',
                  background: badge.bg, border: `1px solid ${badge.border}`,
                  fontFamily: 'var(--font-heading)', fontWeight: 700,
                  fontSize: 9, letterSpacing: '0.45px', textTransform: 'uppercase',
                  color: badge.color, whiteSpace: 'nowrap',
                }}>
                  {badge.label}
                </span>
              </div>

              {/* Actions */}
              <div style={{ padding: '20px 0', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                <Link
                  href={`/source/${s.source_id}`}
                  style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 10, letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--accent)', textDecoration: 'none' }}
                >
                  View
                </Link>

                {isLoading ? (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', minWidth: 90, textAlign: 'right' }}>
                    …
                  </span>
                ) : (
                  <>
                    <button
                      style={{ ...btnBase, color: 'var(--warning)', border: '1px solid rgba(var(--warning-rgb),0.35)', fontSize: 9, letterSpacing: '0.8px' }}
                      onClick={() => handleArchive(s.source_id, s.status)}
                    >
                      {s.status === 'archived' ? 'Unarchive' : 'Archive'}
                    </button>
                    <button
                      style={btnDanger}
                      onClick={() => setModal({ kind: 'delete-single', sourceId: s.source_id, title: s.title })}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Confirmation modal */}
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
              {modal.kind === 'delete-bulk' ? `Delete ${modal.ids.length} Sources` : 'Delete Source'}
            </p>
            <p style={{
              fontFamily: 'var(--font-body)', fontSize: 13,
              color: 'var(--fg-secondary)', lineHeight: 1.6,
              margin: '0 0 24px',
            }}>
              {modal.kind === 'delete-single'
                ? <>This will permanently delete <strong>{modal.title}</strong> and cascade-archive any orphaned pages. This cannot be undone.</>
                : <>This will permanently delete <strong>{modal.ids.length} sources</strong> and cascade-archive any orphaned pages. This cannot be undone.</>
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
                    ? handleDelete(modal.sourceId)
                    : handleBulkDelete(modal.ids)
                }
              >
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
