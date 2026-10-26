'use client';

/**
 * "Redo" on the progress page of the most recent compile (GitHub #140,
 * lib/compile-redo/): pick a point, see what it does and costs, confirm.
 * GET/POST /api/compile/redo. Desktop only, plain words, no step names.
 */

import { useEffect, useState } from 'react';
import { formatCostRange, formatDuration, formatSpent } from '@/lib/page-upgrade-estimate';

type Point = 'plan' | 'write' | 'save';
interface Page { page_id: string; title: string }

const POINTS: Array<{ point: Point; label: string; text: string }> = [
  { point: 'plan', label: 'Re-plan the pages', text: 'Decide again which pages these sources make, using your current settings, then write and save them.' },
  { point: 'write', label: 'Re-write the pages', text: 'Keep the plan and write every page of this compile again.' },
  { point: 'save', label: 'Re-save the pages', text: 'Save the drafts this compile held back (too short, or waiting for approval) under your current settings. No new writing.' },
];
const LABEL: Record<Point, string> = { plan: 'Re-plan the pages', write: 'Re-write the pages', save: 'Re-save the pages' };

interface Overview {
  available: boolean;
  reason: string | null;
  message: string | null;
  redo: {
    point: Point;
    status: 'running' | 'finished';
    model_label: string;
    skipped: Page[];
    outcome: { planned: number; saved: number; archived: Page[]; skipped_on_save: number; spent_usd: number | null } | null;
  } | null;
}

interface Preview {
  point: Point;
  model: { id: string; label: string };
  nothing_to_do: boolean;
  pages: number;
  max_pages: number;
  may_archive: Page[];
  skipped: Page[];
  waiting_drafts: number;
  sources: number;
  estimate: { calls_low: number; calls_high: number; cost_usd_low: number; cost_usd_high: number; minutes_low: number; minutes_high: number } | null;
  estimate_error: string | null;
  over_budget: boolean;
}

const BOX: React.CSSProperties = {
  border: '1px solid rgba(var(--separator-rgb),0.3)', background: 'var(--bg-card)', padding: '16px 20px',
  display: 'flex', flexDirection: 'column', gap: 10, fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--fg-secondary)',
};
const BUTTON: React.CSSProperties = {
  background: 'transparent', border: '1px solid var(--accent)', cursor: 'pointer', padding: '8px 20px',
  fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px', letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--accent)',
};
const PRIMARY: React.CSSProperties = { ...BUTTON, background: 'var(--accent)', color: 'var(--bg)', fontWeight: 700 };
const HEAD: React.CSSProperties = { fontFamily: 'var(--font-heading)', fontSize: 15, color: 'var(--fg)', margin: 0 };

function titles(pages: Page[], max = 8): string {
  const shown = pages.slice(0, max).map((p) => p.title).join(', ');
  return pages.length > max ? `${shown} and ${pages.length - max} more` : shown;
}

function whatItDoes(p: Preview): string[] {
  const lines: string[] = [];
  if (p.point === 'plan') {
    lines.push(`Plans the pages of this compile's ${p.sources} sources again from what Kompl already read. Nothing is fetched or read again.`);
    lines.push(`This compile has ${p.pages} pages now; the new plan may have up to ${p.max_pages}.`);
    if (p.may_archive.length > 0) {
      lines.push(`Pages this compile created that the new plan leaves out are archived, not deleted (they stay under Show archived): up to ${p.may_archive.length}.`);
    }
    lines.push('Pages that existed before this compile are never archived.');
  } else if (p.point === 'write') {
    lines.push(`Writes ${p.pages} pages of this compile again. Each page keeps its previous version in its history.`);
  } else {
    lines.push(`Saves ${p.pages} held-back drafts under your current settings. No AI writing.`);
  }
  if (p.waiting_drafts > 0) lines.push(`${p.waiting_drafts} drafts waiting for your approval are replaced.`);
  if (p.skipped.length > 0) lines.push(`Left alone because they changed since the compile: ${titles(p.skipped)}.`);
  return lines;
}

export default function RedoPanel({ sessionId, terminal, onStarted }: { sessionId: string; terminal: boolean; onStarted: () => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    fetch(`/api/compile/redo?session_id=${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Overview | null) => { if (live) setOverview(d); })
      .catch(() => { /* the panel just stays hidden */ });
    return () => { live = false; };
  }, [sessionId, terminal]);

  async function choose(point: Point) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/compile/redo?session_id=${encodeURIComponent(sessionId)}&point=${point}`);
      const body = await r.json();
      if (!r.ok) setError(body.message ?? 'Could not work out what the redo would do.');
      else setPreview(body as Preview);
    } catch {
      setError('Could not reach Kompl. Try again.');
    }
    setBusy(false);
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/compile/redo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, point: preview.point, expected_pages: preview.max_pages, model: preview.model.id }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(body.message ?? 'The redo could not start.');
        setBusy(false);
        return;
      }
      setOpen(false);
      setPreview(null);
      setBusy(false);
      onStarted();
    } catch {
      setError('Could not reach Kompl. Try again.');
      setBusy(false);
    }
  }

  if (!overview) return null;
  const redo = overview.redo;

  if (!terminal) {
    if (redo?.status !== 'running') return null;
    return <div style={BOX}><p style={HEAD}>Redoing this compile: {LABEL[redo.point].toLowerCase()}</p></div>;
  }

  const last = redo && (
    <div style={BOX}>
      <p style={HEAD}>{redo.status === 'running' ? 'The redo stopped before it finished' : `Last redo: ${LABEL[redo.point].toLowerCase()}`}</p>
      {redo.status === 'running' && <span>Press Retry to continue it, or start a new redo.</span>}
      {redo.outcome && (
        <>
          <span>
            {redo.outcome.planned} pages in the plan · {redo.outcome.saved} saved
            {redo.outcome.spent_usd !== null ? ` · ${formatSpent(redo.outcome.spent_usd)} spent on ${redo.model_label}` : ''}
          </span>
          {redo.outcome.archived.length > 0 && <span>Archived (under Show archived): {titles(redo.outcome.archived)}</span>}
          {(redo.skipped.length > 0 || redo.outcome.skipped_on_save > 0) && (
            <span>
              Left alone because they changed since: {redo.skipped.length > 0 ? titles(redo.skipped) : ''}
              {redo.outcome.skipped_on_save > 0 ? ` (${redo.outcome.skipped_on_save} while saving)` : ''}
            </span>
          )}
        </>
      )}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {last}
      {!overview.available ? (
        // Older compile, or something else running: say why only when it is temporary.
        overview.message && overview.reason !== 'not_latest' && overview.reason !== 'no_progress_record' ? (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)' }}>Redo: {overview.message}</span>
        ) : null
      ) : !open ? (
        <div>
          <button style={BUTTON} onClick={() => setOpen(true)}>Redo part of this compile</button>
        </div>
      ) : (
        <div style={BOX}>
          {!preview ? (
            <>
              <p style={HEAD}>Redo part of this compile</p>
              <span>Nothing is fetched or read again. You see what it does and costs before anything starts.</span>
              {POINTS.map((p) => (
                <button key={p.point} disabled={busy} onClick={() => void choose(p.point)}
                  style={{ ...BUTTON, textAlign: 'left', textTransform: 'none', letterSpacing: 0, fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--fg)', borderColor: 'rgba(var(--separator-rgb),0.4)' }}>
                  <strong style={{ color: 'var(--accent)' }}>{p.label}</strong> — {p.text}
                </button>
              ))}
              <div><button style={{ ...BUTTON, border: 'none', color: 'var(--fg-dim)' }} onClick={() => setOpen(false)}>Close</button></div>
            </>
          ) : (
            <>
              <p style={HEAD}>{LABEL[preview.point]}</p>
              {preview.nothing_to_do ? (
                <span>There is nothing to redo from this point.</span>
              ) : (
                <>
                  {whatItDoes(preview).map((line) => <span key={line}>{line}</span>)}
                  {preview.estimate && (
                    <span style={{ color: 'var(--fg)' }}>
                      {preview.estimate.calls_high === 0
                        ? 'No AI cost expected.'
                        : `Up to ${preview.estimate.calls_high} AI calls, costs ${formatCostRange(preview.estimate.cost_usd_low, preview.estimate.cost_usd_high)} and takes about ${formatDuration(preview.estimate.minutes_low, preview.estimate.minutes_high)} on ${preview.model.label}.`}
                    </span>
                  )}
                  {preview.estimate_error && <span style={{ color: 'var(--danger)' }}>{preview.estimate_error}</span>}
                  {preview.over_budget && <span style={{ color: 'var(--danger)' }}>This may pass today&apos;s spending limit; the redo then stops and says what it finished.</span>}
                </>
              )}
              <div style={{ display: 'flex', gap: 12 }}>
                {!preview.nothing_to_do && preview.estimate && (
                  <button style={{ ...PRIMARY, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={() => void confirm()}>
                    {busy ? 'Starting…' : 'Confirm'}
                  </button>
                )}
                <button style={BUTTON} disabled={busy} onClick={() => { setPreview(null); setError(null); }}>Back</button>
              </div>
            </>
          )}
          {error && <span style={{ color: 'var(--danger)' }}>{error}</span>}
        </div>
      )}
    </div>
  );
}
