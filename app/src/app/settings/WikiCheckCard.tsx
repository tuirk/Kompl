'use client';

/**
 * Settings > Wiki health: the whole-wiki check for disagreements between
 * sources (plan 3.6, lib/claim-check/wiki-check.ts, /api/wiki/claim-check).
 *
 * Says how many claim pairs are not checked yet, how many the next run
 * checks, and what that costs and takes with the current model, before
 * anything runs. One confirmed action; while it runs, progress with a Stop
 * button. Each run picks up where the last one stopped, so successive runs
 * check every pair. Findings appear on the pages' Disagreements panel and in
 * the activity feed, for the owner to confirm or dismiss.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import type { WikiCheckOverview, WikiCheckRun } from '@/lib/claim-check/wiki-check';
import { formatCostRange, formatDuration, formatUsd } from '@/lib/page-upgrade-estimate';
import { Details, SettingCard, type BadgeTone } from './_ui';

const POLL_MS = 2000;

const PILL: CSSProperties = { padding: '0.45rem 1rem', borderRadius: 20, fontSize: '0.85rem' };
const TEXT: CSSProperties = { margin: '0 0 0.6rem', fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.55 };
const PANEL: CSSProperties = {
  margin: '0.75rem 0',
  padding: '0.75rem 1rem',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-card)',
  fontSize: '0.85rem',
  color: 'var(--fg-secondary)',
  lineHeight: 1.55,
};
const WARNING: CSSProperties = {
  margin: '0 0 0.75rem',
  fontSize: '0.83rem',
  lineHeight: 1.5,
  color: 'var(--warning)',
  background: 'rgba(var(--warning-rgb), 0.08)',
  border: '1px solid rgba(var(--warning-rgb), 0.25)',
  borderRadius: 6,
  padding: '0.55rem 0.8rem',
};

const STOP_TEXT: Record<string, string> = {
  user: 'The last check was stopped.',
  daily_cost_ceiling: "The last check stopped at today's spending limit.",
  rate_limited: 'The last check stopped: the AI provider was rate limiting.',
  failures: 'The last check stopped after 3 failed calls in a row.',
  error: 'The last check stopped on an unexpected error.',
};

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

export default function WikiCheckCard() {
  const [overview, setOverview] = useState<WikiCheckOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const lastStatus = useRef<string | null>(null);

  const load = useCallback(async (withEstimate: boolean) => {
    try {
      const res = await fetch(`/api/wiki/claim-check?estimate=${withEstimate ? '1' : '0'}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as WikiCheckOverview;
      // Progress polls skip counting and the estimate; keep the last ones.
      setOverview((prev) =>
        withEstimate || prev === null
          ? next
          : {
              ...next,
              pairs_left: prev.pairs_left,
              next_run_pairs: prev.next_run_pairs,
              estimate: prev.estimate,
              estimate_error: prev.estimate_error,
              budget: prev.budget,
              over_budget: prev.over_budget,
            },
      );
      setLoadError(null);
    } catch {
      setLoadError('Could not load the wiki check. Reload the page to try again.');
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const runStatus = overview?.run?.status ?? null;
  useEffect(() => {
    // A run that just ended changes the pairs left and the estimate.
    if (lastStatus.current === 'running' && runStatus !== 'running') void load(true);
    lastStatus.current = runStatus;
    if (runStatus !== 'running') return;
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [runStatus, load]);

  async function post(path: string, body?: unknown): Promise<{ run?: WikiCheckRun; message?: string; ok: boolean; status: number }> {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => ({}))) as { run?: WikiCheckRun; message?: string };
    return { ...parsed, ok: res.ok, status: res.status };
  }

  async function start() {
    if (!overview?.next_run_pairs) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await post('/api/wiki/claim-check/start', { expected_pairs: overview.next_run_pairs, model: overview.model.id });
      setConfirming(false);
      if (!res.ok || !res.run) {
        setActionError(res.message ?? `The check could not start (HTTP ${res.status}).`);
        void load(true);
        return;
      }
      const run = res.run;
      setOverview((prev) => (prev ? { ...prev, run } : prev));
    } catch {
      setActionError('Could not reach Kompl. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setActionError(null);
    try {
      const res = await post('/api/wiki/claim-check/stop');
      if (res.run) {
        const run = res.run;
        setOverview((prev) => (prev ? { ...prev, run } : prev));
      } else if (!res.ok) {
        setActionError(res.message ?? `Could not stop the check (HTTP ${res.status}).`);
      }
      void load(false);
    } catch {
      setActionError('Could not reach Kompl. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const run = overview?.run ?? null;
  const running = run?.status === 'running';
  const left = overview?.pairs_left ?? null;
  const next = overview?.next_run_pairs ?? 0;
  const estimate = overview?.estimate ?? null;
  const modelLabel = overview?.model.label ?? '';
  const costPhrase = estimate ? formatCostRange(estimate.cost_usd_low, estimate.cost_usd_high) : null;
  const durationPhrase = estimate ? formatDuration(estimate.minutes_low, estimate.minutes_high) : null;
  const budget = overview?.budget ?? null;

  const blockedReason = overview?.compile_running
    ? 'A compile is running. Check the wiki once it finishes.'
    : overview?.page_upgrade_running
      ? 'Pages are being updated. Check the wiki once the update finishes.'
      : estimate === null
        ? 'The cost estimate is not available yet.'
        : null;

  const summary: ReactNode =
    'Compares what different sources claim about the same subjects across the whole wiki and flags possible ' +
    'disagreements on the pages, for you to confirm or dismiss. Nothing runs until you confirm the cost.';

  const control = running ? (
    <button type="button" className="btn-outline" style={PILL} onClick={() => void stop()} disabled={busy || run.stop_requested}>
      {run.stop_requested ? 'Stopping…' : 'Stop'}
    </button>
  ) : next > 0 ? (
    <button
      type="button"
      style={PILL}
      onClick={() => {
        setConfirming(true);
        setActionError(null);
      }}
      disabled={busy || confirming || blockedReason !== null}
      title={blockedReason ?? undefined}
    >
      Check for disagreements
    </button>
  ) : undefined;

  const badge: { label: string; tone: BadgeTone } | null =
    overview === null || left === null
      ? running
        ? { label: 'Checking', tone: 'accent' }
        : null
      : running
        ? { label: 'Checking', tone: 'accent' }
        : left > 0
          ? { label: `${left.toLocaleString()} to check`, tone: 'warning' }
          : { label: 'Up to date', tone: 'success' };

  const footer =
    overview === null ? (
      <p style={TEXT}>{loadError ?? 'Counting claim pairs…'}</p>
    ) : (
      <>
        {running && run && (
          <div style={PANEL} role="status" aria-live="polite">
            <div style={{ color: 'var(--fg)', marginBottom: '0.4rem' }}>
              {run.judged.toLocaleString()} of {plural(run.total, 'claim pair')} checked ·{' '}
              {plural(run.findings, 'possible disagreement')}
            </div>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={run.total}
              aria-valuenow={run.judged}
              aria-label="Claim pairs checked"
              style={{ height: 6, borderRadius: 3, background: 'var(--bg-track)', overflow: 'hidden', marginBottom: '0.5rem' }}
            >
              <div
                style={{
                  width: `${run.total > 0 ? Math.round((run.judged / run.total) * 100) : 0}%`,
                  height: '100%',
                  background: 'var(--accent)',
                  transition: 'width var(--transition-slow)',
                }}
              />
            </div>
            {run.stop_requested && <div>Stopping after the checks in flight…</div>}
            <div style={{ marginTop: '0.35rem', color: 'var(--fg-dim)' }}>
              Each answer is saved as it lands. If Kompl restarts, the check stops; start it again to go on from there.
            </div>
          </div>
        )}

        {!running && run && (
          <div style={PANEL} role="status">
            <div style={{ color: run.status === 'finished' ? 'var(--fg)' : 'var(--warning)' }}>
              {run.status === 'finished' ? 'The last check finished.' : (STOP_TEXT[run.stop_reason ?? ''] ?? 'The last check stopped.')}
            </div>
            <div style={{ marginTop: '0.3rem' }}>
              {run.judged.toLocaleString()} of {plural(run.total, 'claim pair')} checked with {run.model_label};{' '}
              {plural(run.findings, 'possible disagreement')} flagged on the pages.
            </div>
          </div>
        )}

        {!running && left !== null && (
          <p style={{ ...TEXT, color: 'var(--fg-secondary)' }}>
            {left === 0
              ? overview.checked_pairs > 0
                ? `Every claim pair has been checked (${overview.checked_pairs.toLocaleString()} so far). New sources add pairs to check.`
                : 'No claim pairs to check yet: pairs come from claims of different sources about a subject that has a page.'
              : `${plural(left, 'claim pair')} not checked yet${overview.checked_pairs > 0 ? ` (${overview.checked_pairs.toLocaleString()} checked so far)` : ''}.`}
          </p>
        )}

        {!running && next > 0 && (
          <>
            {estimate && costPhrase && durationPhrase ? (
              <p style={TEXT}>
                Checking {next === left ? (next === 1 ? 'it' : 'them') : `the next ${next.toLocaleString()}`} with{' '}
                <strong>{modelLabel}</strong> costs {costPhrase} and takes about {durationPhrase}.
                {left !== null && left > next ? ' Each run checks at most this many; the next run goes on from there.' : ''}
              </p>
            ) : (
              overview.estimate_error && (
                <p style={WARNING}>{overview.estimate_error} The check is unavailable until the cost can be estimated.</p>
              )
            )}
            {overview.over_budget && budget && budget.remaining_usd !== null && (
              <p role="alert" style={WARNING}>
                This may exceed today&apos;s remaining spending limit ({formatUsd(budget.remaining_usd)}
                {budget.daily_cap_usd !== null ? ` of ${formatUsd(budget.daily_cap_usd)}` : ''}). The check stops when the
                limit is reached and keeps what it checked; run it again after midnight UTC to go on.
              </p>
            )}
          </>
        )}

        {confirming && !running && estimate && costPhrase && durationPhrase && (
          <div role="dialog" aria-label="Confirm the wiki check" style={{ ...PANEL, borderColor: 'var(--border-hover)' }}>
            {`Check ${plural(next, 'claim pair')} with ${modelLabel}? This costs ${costPhrase} and takes about ${durationPhrase}. `}
            {"The check stops at today's spending limit or after 3 failed calls in a row, and you can stop it at any time; "}
            {'what it checked is kept.'}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
              <button type="button" className="btn-outline" style={PILL} onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
              <button type="button" style={PILL} onClick={() => void start()} disabled={busy}>
                {busy ? 'Starting…' : `Check ${plural(next, 'pair')}`}
              </button>
            </div>
          </div>
        )}

        <Details label="How the check works">
          A claim pair is two claims from different sources about the same subject, where the subject has its own page.
          A subject that most claims mention is left out, and each claim is paired with its three most similar claims;
          pairs whose numbers or dates differ are checked first. An AI model judges each pair once: the two sources
          disagree, a later source shows the claim changed (told apart by the sources&apos; publication dates), they
          describe different scopes, they differ in opinion, or there is nothing to report. Disagreements and changes
          are flagged on the subject&apos;s page for you to confirm or dismiss, and your answer is never overwritten.
          Every answer is saved, so no pair is paid for twice.
        </Details>

        {actionError && (
          <p role="alert" style={{ ...TEXT, color: 'var(--danger)', margin: '0.6rem 0 0' }}>
            {actionError}
          </p>
        )}
      </>
    );

  return (
    <SettingCard
      id="wiki-check"
      title="Disagreements between sources"
      badge={badge?.label ?? 'Beta'}
      badgeTone={badge?.tone}
      summary={summary}
      control={control}
      footer={footer}
    />
  );
}
