'use client';

/**
 * /onboarding/review — Review all collected sources before compiling.
 *
 * Calls GET /api/onboarding/review?session_id=<id> on mount.
 * Renders sources grouped by source_type with checkboxes.
 * Duplicates (by content hash) are auto-unchecked and badged.
 *
 * "Build your wiki" → POST /api/onboarding/confirm → /onboarding/progress
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useToast } from '../../../components/Toast';

interface SourceRow {
  source_id: string;
  title: string;
  source_type: string;
  source_url: string | null;
  content_hash: string;
  file_path: string;
  status: string;
  date_ingested: string;
  metadata: string | null;
  onboarding_session_id: string | null;
}

interface ReviewResponse {
  session_id: string;
  sources: Record<string, SourceRow[]>;
  duplicate_source_ids: string[];
  total: number;
}

const TYPE_LABELS: Record<string, string> = {
  webpage: 'Webpages',
  pdf: 'PDFs',
  docx: 'Word Documents',
  pptx: 'PowerPoint',
  xlsx: 'Spreadsheets',
  txt: 'Text Files',
  md: 'Markdown',
  html: 'HTML',
  image: 'Images',
  audio: 'Audio',
  file: 'Files',
};

function typeLabel(type: string): string {
  return TYPE_LABELS[type.toLowerCase()] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

function sourceDomain(row: SourceRow): string {
  if (row.source_url) {
    try {
      return new URL(row.source_url).hostname.replace(/^www\./, '');
    } catch {
      return row.source_url;
    }
  }
  // Fall back to filename from file_path
  return row.file_path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
}

export default function ReviewPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast, showToast } = useToast();

  const sessionId = searchParams.get('session_id') ?? '';

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ReviewResponse | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/onboarding/review?session_id=${encodeURIComponent(sessionId)}`)
      .then(r => r.json())
      .then((body: ReviewResponse) => {
        setData(body);
        // Default: all checked except duplicates
        const initChecked: Record<string, boolean> = {};
        const dupSet = new Set(body.duplicate_source_ids);
        for (const group of Object.values(body.sources)) {
          for (const s of group) {
            initChecked[s.source_id] = !dupSet.has(s.source_id);
          }
        }
        setChecked(initChecked);
      })
      .catch(e => showToast(e instanceof Error ? e.message : 'Failed to load sources', 'error'))
      .finally(() => setLoading(false));
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleAll(group: SourceRow[], value: boolean) {
    setChecked(prev => {
      const next = { ...prev };
      for (const s of group) next[s.source_id] = value;
      return next;
    });
  }

  async function handleConfirm() {
    if (!data || confirming) return;
    const allSources = Object.values(data.sources).flat();
    const selectedIds = allSources.filter(s => checked[s.source_id]).map(s => s.source_id);
    const deletedIds = allSources.filter(s => !checked[s.source_id]).map(s => s.source_id);

    if (selectedIds.length === 0) {
      showToast('Select at least one source to compile.', 'error');
      return;
    }

    setConfirming(true);
    try {
      const res = await fetch('/api/onboarding/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          selected_source_ids: selectedIds,
          deleted_source_ids: deletedIds,
        }),
      });
      const body = await res.json() as { queued?: number; error?: string };
      if (!res.ok) {
        showToast(body.error ?? `Confirm failed (${res.status})`, 'error');
        return;
      }
      router.push(
        `/onboarding/progress?session_id=${encodeURIComponent(sessionId)}&queued=${body.queued ?? selectedIds.length}`
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Network error', 'error');
    } finally {
      setConfirming(false);
    }
  }

  const selectedCount = Object.values(checked).filter(Boolean).length;

  // ── Loading ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <main style={{ maxWidth: 760, margin: '8rem auto', padding: '0 1.5rem', textAlign: 'center' }}>
        <p style={{ color: 'var(--fg-muted)' }}>Loading your sources…</p>
      </main>
    );
  }

  if (!data || data.total === 0) {
    return (
      <main style={{ maxWidth: 760, margin: '8rem auto', padding: '0 1.5rem', textAlign: 'center' }}>
        <p style={{ color: 'var(--fg-muted)', marginBottom: '1.5rem' }}>No sources found for this session.</p>
        <a href={`/onboarding${sessionId ? `?session_id=${sessionId}` : ''}`}>← Add sources</a>
      </main>
    );
  }

  const dupSet = new Set(data.duplicate_source_ids);
  const groups = Object.entries(data.sources);

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '3.5rem 1.5rem 8rem' }}>

      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.8rem' }}>Review your sources</h1>
        <p style={{ color: 'var(--fg-muted)', marginTop: '0.5rem' }}>
          {data.total} source{data.total !== 1 ? 's' : ''} ready to compile.
          Uncheck anything you don&apos;t want.
        </p>
      </header>

      {/* Source groups */}
      {groups.map(([type, sources]) => (
        <section key={type} style={{ marginBottom: '2rem' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '0.6rem',
              paddingBottom: '0.4rem',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
              {typeLabel(type)}
              <span style={{ color: 'var(--fg-muted)', fontWeight: 400, marginLeft: '0.5rem' }}>
                ({sources.length})
              </span>
            </h2>
            <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.8rem' }}>
              <button
                onClick={() => toggleAll(sources, true)}
                style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0 }}
              >
                All
              </button>
              <button
                onClick={() => toggleAll(sources, false)}
                style={{ background: 'none', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 0 }}
              >
                None
              </button>
            </div>
          </div>

          {sources.map(s => {
            const isDuplicate = dupSet.has(s.source_id);
            return (
              <label
                key={s.source_id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.75rem',
                  padding: '0.6rem 0',
                  borderBottom: '1px solid var(--border)',
                  cursor: 'pointer',
                  opacity: checked[s.source_id] === false ? 0.5 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked[s.source_id] ?? true}
                  onChange={e =>
                    setChecked(prev => ({ ...prev, [s.source_id]: e.target.checked }))
                  }
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        maxWidth: '100%',
                        fontSize: '0.95rem',
                      }}
                    >
                      {s.title || '(untitled)'}
                    </span>
                    {isDuplicate && (
                      <span
                        style={{
                          fontSize: '0.7rem',
                          border: '1px solid var(--warning)',
                          color: 'var(--warning)',
                          padding: '0.1em 0.5em',
                          borderRadius: 999,
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          flexShrink: 0,
                        }}
                      >
                        Duplicate
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--fg-muted)', marginTop: '0.15rem' }}>
                    {sourceDomain(s)}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: '0.7rem',
                    border: '1px solid var(--border)',
                    padding: '0.1em 0.5em',
                    borderRadius: 999,
                    color: 'var(--fg-dim)',
                    flexShrink: 0,
                    alignSelf: 'center',
                  }}
                >
                  {s.source_type}
                </span>
              </label>
            );
          })}
        </section>
      ))}

      {/* Add more link */}
      <p style={{ color: 'var(--fg-muted)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
        <a href={`/onboarding?session_id=${encodeURIComponent(sessionId)}`}>
          ← Add more sources
        </a>
      </p>
      <p style={{ color: 'var(--fg-dim)', fontSize: '0.85rem', marginBottom: '3rem' }}>
        You can always add more sources later.
      </p>

      {/* Sticky footer */}
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '1rem 1.5rem',
          background: 'var(--bg)',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          zIndex: 10,
        }}
      >
        <span style={{ color: 'var(--fg-muted)', fontSize: '0.95rem' }}>
          {selectedCount} of {data.total} selected
        </span>
        <button
          onClick={handleConfirm}
          disabled={confirming || selectedCount === 0}
          style={{ padding: '0.7rem 2rem', fontSize: '1rem', fontWeight: 600 }}
        >
          {confirming ? 'Queuing…' : 'Build your wiki →'}
        </button>
      </div>

      {toast}
    </main>
  );
}
