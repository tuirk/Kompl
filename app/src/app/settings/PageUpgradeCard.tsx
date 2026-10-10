'use client';

/**
 * Settings > Wiki health: update pages written by an earlier version to the
 * current writing rules (lib/writing-rules.ts, lib/page-upgrade.ts,
 * /api/wiki/page-upgrade/*).
 *
 * Says what changed, how many pages, and what updating them costs and takes
 * with the current model, before anything runs. One confirmed action; while
 * it runs, progress with a Stop button. Leaving the pages as they are is
 * simply not pressing it. Pages an update could not rebuild are listed with
 * the reason and not offered again until they change.
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import type { PageUpgradeOverview, PageUpgradeRunView } from '@/lib/page-upgrade';
import {
  formatCostRange,
  formatDuration,
  formatSpent,
  formatUsd,
  pagesWere,
} from '@/lib/page-upgrade-estimate';
import { CURRENT_DRAFT_RULES, CURRENT_RULES_CHANGES } from '@/lib/writing-rules';
import { Details, SettingCard, type BadgeTone } from './_ui';

/** Why an update left a page as it is (lib/draft-rules.ts SET_ASIDE_REASONS). */
const SET_ASIDE_TEXT: Record<string, string> = {
  draft_too_thin: 'its sources are too short to support a full page',
  no_readable_sources: 'its sources could not be read',
};

const POLL_MS = 2000;

const PILL: CSSProperties = { padding: '0.45rem 1rem', borderRadius: 20, fontSize: '0.85rem' };
const TEXT: CSSProperties = { margin: '0 0 0.6rem', fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.55 };
const NOTE: CSSProperties = { ...TEXT, color: 'var(--fg-dim)' };
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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The summary when nothing needs updating: what state the wiki is in. */
function upToDateSummary(current: number, setAside: number): string {
  const rules = `the ${CURRENT_DRAFT_RULES} writing rules`;
  if (current === 0) {
    return setAside > 0 ? 'There is nothing left to update.' : `Kompl has not written any pages yet. New pages follow ${rules}.`;
  }
  const pages = current === 1 ? '1 page written from your sources follows' : `${current} pages written from your sources follow`;
  if (setAside > 0) return `${pages} ${rules}.`;
  return `${current === 1 ? 'The' : 'All'} ${pages} ${rules}. Nothing needs updating.`;
}

function counts(run: PageUpgradeRunView): string {
  return `${run.updated} updated · ${run.skipped} skipped · ${run.failed} failed`;
}

function IssueList({ label, issues }: { label: string; issues: PageUpgradeRunView['failures'] }) {
  if (issues.length === 0) return null;
  return (
    <Details label={`${label} (${issues.length})`}>
      <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
        {issues.map((issue) => (
          <li key={`${issue.page_id}-${issue.error}`}>
            <Link href={`/wiki/${issue.page_id}`} style={{ color: 'var(--fg-secondary)' }}>
              {issue.title}
            </Link>
            : {issue.message}
          </li>
        ))}
      </ul>
    </Details>
  );
}

/** What changed in the current rules: a bold label and one sentence each. */
function RulesChangeList({ spaced = false }: { spaced?: boolean }) {
  return (
    <ul style={{ margin: spaced ? '0.45rem 0 0' : 0, paddingLeft: '1.1rem' }}>
      {CURRENT_RULES_CHANGES.map((change) => (
        <li key={change.title} style={{ marginBottom: '0.2rem' }}>
          <strong style={{ fontWeight: 600, color: 'var(--fg-secondary)' }}>{change.title}.</strong> {change.detail}
        </li>
      ))}
    </ul>
  );
}

export default function PageUpgradeCard() {
  const [overview, setOverview] = useState<PageUpgradeOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const lastStatus = useRef<string | null>(null);

  const load = useCallback(async (withEstimate: boolean) => {
    try {
      const res = await fetch(`/api/wiki/page-upgrade?estimate=${withEstimate ? '1' : '0'}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as PageUpgradeOverview;
      // Progress polls skip the estimate; keep the last one.
      setOverview((prev) =>
        withEstimate || prev === null
          ? next
          : { ...next, estimate: prev.estimate, estimate_error: prev.estimate_error, budget: prev.budget, over_budget: prev.over_budget },
      );
      setLoadError(null);
    } catch {
      setLoadError('Could not load which pages need updating. Reload the page to try again.');
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const runStatus = overview?.run?.status ?? null;
  useEffect(() => {
    // A run that just ended changes the count and the estimate.
    if (lastStatus.current === 'running' && runStatus !== 'running') void load(true);
    lastStatus.current = runStatus;
    if (runStatus !== 'running') return;
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [runStatus, load]);

  async function start() {
    if (!overview) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch('/api/wiki/page-upgrade/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_pages: overview.candidates, model: overview.model.id }),
      });
      const body = (await res.json().catch(() => ({}))) as { run?: PageUpgradeRunView; message?: string };
      setConfirming(false);
      if (!res.ok || !body.run) {
        setActionError(body.message ?? `The update could not start (HTTP ${res.status}).`);
        void load(true);
        return;
      }
      const run = body.run;
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
      const res = await fetch('/api/wiki/page-upgrade/stop', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { run?: PageUpgradeRunView; message?: string };
      if (body.run) {
        const run = body.run;
        setOverview((prev) => (prev ? { ...prev, run } : prev));
      } else if (!res.ok) {
        setActionError(body.message ?? `Could not stop the update (HTTP ${res.status}).`);
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
  const n = overview?.candidates ?? 0;
  const estimate = overview?.estimate ?? null;
  const modelLabel = overview?.model.label ?? '';
  const setAside = overview?.set_aside ?? [];
  const current = overview?.current_pages ?? 0;

  const blockedReason = overview?.compile_running
    ? 'A compile is running. Pages can be updated once it finishes.'
    : estimate === null
      ? 'The cost estimate is not available yet.'
      : null;

  let summary: ReactNode;
  if (overview === null) {
    summary = loadError ?? 'Counting pages…';
  } else if (n === 0 && !running) {
    summary = upToDateSummary(current, setAside.length);
  } else {
    summary = (
      <>
        Kompl {CURRENT_DRAFT_RULES} improves how it writes pages:
        <RulesChangeList spaced />
      </>
    );
  }

  const control = running ? (
    <button type="button" className="btn-outline" style={PILL} onClick={() => void stop()} disabled={busy || run.stop_requested}>
      {run.stop_requested ? 'Stopping…' : 'Stop'}
    </button>
  ) : n > 0 ? (
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
      {n === 1 ? 'Update 1 page' : `Update all ${n} pages`}
    </button>
  ) : undefined;

  const badge: { label: string; tone: BadgeTone } | null =
    overview === null
      ? null
      : running
        ? { label: 'Updating', tone: 'accent' }
        : n > 0
          ? { label: `${n} to update`, tone: 'warning' }
          : { label: setAside.length > 0 ? 'Done' : 'Up to date', tone: 'success' };

  const costPhrase = estimate ? formatCostRange(estimate.cost_usd_low, estimate.cost_usd_high) : null;
  const durationPhrase = estimate ? formatDuration(estimate.minutes_low, estimate.minutes_high) : null;
  const budget = overview?.budget ?? null;

  const footer = overview === null ? null : (
    <>
      {running && run && (
        <div style={PANEL} role="status" aria-live="polite">
          <div style={{ color: 'var(--fg)', marginBottom: '0.4rem' }}>
            {run.done} of {plural(run.total, 'page')} done
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={run.total}
            aria-valuenow={run.done}
            aria-label="Pages updated"
            style={{ height: 6, borderRadius: 3, background: 'var(--bg-track)', overflow: 'hidden', marginBottom: '0.5rem' }}
          >
            <div
              style={{
                width: `${run.total > 0 ? Math.round((run.done / run.total) * 100) : 0}%`,
                height: '100%',
                background: 'var(--accent)',
                transition: 'width var(--transition-slow)',
              }}
            />
          </div>
          {run.current_title && <div>Now updating: {run.current_title}</div>}
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-muted)', marginTop: '0.2rem' }}>
            {counts(run)}
          </div>
          <div style={{ marginTop: '0.35rem' }}>
            Spent {formatSpent(run.spent_usd)} so far; the estimate was{' '}
            {formatCostRange(run.estimate.cost_usd_low, run.estimate.cost_usd_high)}.
          </div>
          {run.stop_requested && <div style={{ marginTop: '0.35rem' }}>Stopping after this page…</div>}
          <div style={{ marginTop: '0.35rem', color: 'var(--fg-dim)' }}>
            New compiles wait until the update finishes. If Kompl restarts, the update stops; select Update all
            again to continue with the remaining pages.
          </div>
          <IssueList label="Failed" issues={run.failures} />
        </div>
      )}

      {!running && run && (
        <div style={PANEL} role="status">
          <div style={{ color: run.status === 'finished' ? 'var(--fg)' : 'var(--warning)' }}>
            {run.status === 'finished' ? 'The last update finished.' : run.stop_message}
          </div>
          <div style={{ marginTop: '0.3rem' }}>
            {run.done} of {plural(run.total, 'page')} done ({counts(run)}). Spent {formatSpent(run.spent_usd)}.
            {run.status === 'stopped' && n > 0
              ? ` Select Update all to continue with the remaining ${n === 1 ? 'page' : `${n} pages`}.`
              : ''}
          </div>
          {run.last_error && run.status === 'stopped' && (
            <div style={{ marginTop: '0.3rem', color: 'var(--fg-dim)' }}>Last error: {run.last_error}</div>
          )}
          <IssueList label="Failed" issues={run.failures} />
          <IssueList label="Skipped" issues={run.skips} />
        </div>
      )}

      {n > 0 && !running && (
        <>
          <p style={{ ...TEXT, color: 'var(--fg-secondary)' }}>
            <strong>{pagesWere(n)}</strong> written by an earlier version.
          </p>
          {estimate && costPhrase && durationPhrase ? (
            <p style={TEXT}>
              Updating them with <strong>{modelLabel}</strong> costs {costPhrase} and takes about {durationPhrase}.
            </p>
          ) : (
            overview.estimate_error && (
              <p style={WARNING}>{overview.estimate_error} Updating is unavailable until the cost can be estimated.</p>
            )
          )}
          {overview.over_budget && budget && budget.remaining_usd !== null && (
            <p role="alert" style={WARNING}>
              This may exceed today&apos;s remaining spending limit ({formatUsd(budget.remaining_usd)}
              {budget.daily_cap_usd !== null ? ` of ${formatUsd(budget.daily_cap_usd)}` : ''}). The update stops when
              the limit is reached; select Update all after midnight UTC to continue, or raise the limit under AI model
              &amp; spend.
            </p>
          )}
          <p style={TEXT}>
            Pages left as they are still improve as new sources arrive: new text follows the {CURRENT_DRAFT_RULES} rules
            and links are tidied, but existing text is only rewritten by an update.
          </p>
          <p style={TEXT}>The previous version of each page is kept and can be restored from the page.</p>
        </>
      )}

      {confirming && !running && estimate && costPhrase && durationPhrase && (
        <div role="dialog" aria-label="Confirm the page update" style={{ ...PANEL, borderColor: 'var(--border-hover)' }}>
          {`Update ${plural(n, 'page')} with ${modelLabel}? This costs ${costPhrase} and takes about ${durationPhrase}. `}
          {'Pages are updated one at a time, oldest first, and new compiles wait until the update finishes. '}
          {`The update stops automatically if it spends more than ${formatUsd(overview.max_overspend * estimate.cost_usd_high)} `}
          {`(${overview.max_overspend} × the high estimate), reaches today's spending limit, or fails on 3 pages in a row; `}
          {'you can also stop it at any time. The previous version of each page is kept.'}
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
            <button type="button" className="btn-outline" style={PILL} onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" style={PILL} onClick={() => void start()} disabled={busy}>
              {busy ? 'Starting…' : `Update ${plural(n, 'page')}`}
            </button>
          </div>
        </div>
      )}

      {!running && setAside.length > 0 && (
        <div style={{ marginBottom: '0.9rem' }}>
          <p style={TEXT}>
            {setAside.length === 1
              ? '1 page could not be updated and keeps its current text. It will not be offered or charged again until a compile changes it.'
              : `${setAside.length} pages could not be updated and keep their current text. They will not be offered or charged again until a compile changes them.`}
          </p>
          <Details label={`Not updated (${setAside.length})`}>
            <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
              {setAside.map((p) => (
                <li key={p.page_id}>
                  <Link href={`/wiki/${p.page_id}`} style={{ color: 'var(--fg-secondary)' }}>
                    {p.title}
                  </Link>
                  : {SET_ASIDE_TEXT[p.reason] ?? 'it could not be rebuilt from its sources'}.
                </li>
              ))}
            </ul>
          </Details>
        </div>
      )}

      {(n > 0 || running) && (
        <Details label="How the update runs">
          Each page is rebuilt from all of its current sources with one LLM call, in the same way a new page is
          written. A page that cannot be rebuilt (its sources cannot be read, or the new version is too short to keep)
          is skipped and keeps its text; it is not offered again until a compile changes it. Pages that are already
          updated are never charged twice, so after a stop or a restart, Update all continues with the remaining
          pages. Source notes and Saved Links are never changed.
        </Details>
      )}

      {n === 0 && !running && (
        <>
          <p style={NOTE}>
            When a Kompl release changes how pages are written, pages written under the earlier rules appear here
            with the cost and time to update them, and a single action updates them all. New pages always follow the
            current rules, and source notes and Saved Links are never rewritten.
          </p>
          <Details label={`What ${CURRENT_DRAFT_RULES} changed`}>
            <RulesChangeList />
          </Details>
        </>
      )}

      {actionError && (
        <p role="alert" style={{ ...TEXT, color: 'var(--danger)', margin: '0.6rem 0 0' }}>
          {actionError}
        </p>
      )}
      {loadError && overview !== null && <p style={NOTE}>{loadError}</p>}
    </>
  );

  return (
    <SettingCard
      id="page-upgrade"
      title={`Update pages to the ${CURRENT_DRAFT_RULES} writing rules`}
      badge={badge?.label}
      badgeTone={badge?.tone}
      summary={summary}
      control={control}
      footer={footer}
    />
  );
}
