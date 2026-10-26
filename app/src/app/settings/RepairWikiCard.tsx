'use client';

/**
 * Settings > Wiki health: Repair wiki (lib/wiki-repair, /api/wiki/repair/*).
 *
 * One wiki-level action. The card first says in plain words what the repair
 * does to this wiki, with the numbers, the AI calls, cost and time on the
 * compile model; nothing runs until the owner confirms once. While it runs:
 * the steps with their progress and a Stop button. Afterwards: what was done,
 * and the copy saved before the repair to put the wiki back as it was.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import type { RepairOverview, RepairRunView } from '@/lib/wiki-repair/run';
import { formatCostRange, formatDuration, formatSpent, formatUsd } from '@/lib/page-upgrade-estimate';
import { SettingCard, type BadgeTone } from './_ui';
import { CostLine, PANEL, PlanSteps, RunOutcome, RunSteps, TEXT } from './RepairWikiParts';

const POLL_MS = 2000;
const PILL: CSSProperties = { padding: '0.45rem 1rem', borderRadius: 20, fontSize: '0.85rem' };
const WARNING: CSSProperties = { ...TEXT, color: 'var(--warning)' };

const BUSY_TEXT: Record<NonNullable<RepairOverview['busy']>, string> = {
  compile: 'A compile is running. The wiki can be repaired once it finishes.',
  page_upgrade: 'Pages are being updated. The wiki can be repaired once that finishes.',
  wiki_check: 'The whole-wiki check is running. The wiki can be repaired once it finishes.',
};

export default function RepairWikiCard() {
  const [overview, setOverview] = useState<RepairOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const lastStatus = useRef<string | null>(null);

  const load = useCallback(async (withPlan: boolean) => {
    try {
      const res = await fetch(`/api/wiki/repair?estimate=${withPlan ? '1' : '0'}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setOverview((await res.json()) as RepairOverview);
      setLoadError(null);
    } catch {
      setLoadError('Could not work out what the repair would do. Reload the page to try again.');
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const runStatus = overview?.run?.status ?? null;
  useEffect(() => {
    if (lastStatus.current === 'running' && runStatus !== 'running') void load(true);
    lastStatus.current = runStatus;
    if (runStatus !== 'running') return;
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [runStatus, load]);

  async function post(path: string, body?: unknown): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { run?: RepairRunView; message?: string };
      setConfirming(false);
      if (json.run) {
        const run = json.run;
        setOverview((prev) => (prev ? { ...prev, run, plan: null } : prev));
      } else if (!res.ok) {
        setActionError(json.message ?? `Kompl could not do that (HTTP ${res.status}).`);
        void load(true);
      }
    } catch {
      setActionError('Could not reach Kompl. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const run = overview?.run ?? null;
  const running = run?.status === 'running';
  const plan = overview?.plan ?? null;
  const estimate = overview?.estimate ?? null;
  const canRun = !running && plan !== null && !overview?.nothing_to_do;
  const blockedReason = overview?.busy ? BUSY_TEXT[overview.busy] : estimate === null ? 'The cost estimate is not available yet.' : null;

  const summary: ReactNode =
    overview === null
      ? (loadError ?? 'Checking your wiki…')
      : 'Earlier versions of Kompl sometimes treated two different names as one thing (a company and its product, say), ' +
        'so some pages took in sources about something else. Repair gives every source back to the right pages and ' +
        'rewrites the pages that change. It is one action for the whole wiki.';

  const control = running ? (
    <button type="button" className="btn-outline" style={PILL} onClick={() => void post('/api/wiki/repair/stop')} disabled={busy || run.stop_requested}>
      {run.stop_requested ? 'Stopping…' : 'Stop'}
    </button>
  ) : canRun ? (
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
      Repair wiki
    </button>
  ) : undefined;

  const badge: { label: string; tone: BadgeTone } | null =
    overview === null
      ? null
      : running
        ? { label: 'Repairing', tone: 'accent' }
        : canRun
          ? { label: 'Needs repair', tone: 'warning' }
          : overview.nothing_to_do
            ? { label: 'Nothing to repair', tone: 'success' }
            : null;

  const e = estimate;
  const footer = overview === null ? null : (
    <>
      {running && run && (
        <div style={PANEL} role="status" aria-live="polite">
          <RunSteps run={run} />
          <div>
            Spent {formatSpent(run.spent_usd)} so far; the estimate was{' '}
            {formatCostRange(run.confirmed.cost_usd_low, run.confirmed.cost_usd_high)}.
          </div>
          {run.stop_requested && <div>Stopping once the current page or AI call is done…</div>}
          <div style={{ color: 'var(--fg-dim)', marginTop: '0.35rem' }}>
            New compiles wait until the repair finishes. A copy of your wiki from before the repair is saved.
          </div>
        </div>
      )}

      {!running && run && <RunOutcome run={run} />}

      {canRun && plan && (
        <>
          <p style={{ ...TEXT, color: 'var(--fg-secondary)', margin: '0 0 0.2rem' }}>What the repair does to your wiki:</p>
          <PlanSteps plan={plan} />
          <CostLine overview={overview} />
          {overview.over_budget && overview.budget?.remaining_usd != null && (
            <p role="alert" style={WARNING}>
              This may cost more than is left of today&apos;s AI spending limit ({formatUsd(overview.budget.remaining_usd)}). The
              repair stops when the limit is reached; select Repair wiki again after midnight UTC to finish, or raise the
              limit under AI model &amp; spend.
            </p>
          )}
        </>
      )}

      {!running && overview.nothing_to_do && !run && (
        <p style={TEXT}>Nothing to repair: no doubtful name pairs are waiting, every source is on the right pages and no link goes to the wrong page.</p>
      )}

      {confirming && canRun && plan && e && (
        <div role="dialog" aria-label="Confirm the repair" style={{ ...PANEL, borderColor: 'var(--border-hover)' }}>
          {`Repair your wiki with ${overview.model.label}? It costs ${formatCostRange(e.cost_usd_low, e.cost_usd_high)} and takes about ${formatDuration(e.minutes_low, e.minutes_high)}. `}
          {'Kompl saves a copy of your wiki first and does not start without it. New compiles wait until the repair finishes. '}
          {`It stops on its own if it would spend more than ${formatUsd(overview.max_overspend * e.cost_usd_high)}, at today's spending limit, or if anything goes wrong; you can also stop it. `}
          {'If it stops part-way, what it did so far stays done and it says what that was: select Repair wiki again to finish, or restore the saved copy to put your wiki back as it was.'}
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
            <button type="button" className="btn-outline" style={PILL} onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              style={PILL}
              onClick={() =>
                void post('/api/wiki/repair/start', {
                  expected_aliases: plan.aliases,
                  expected_pages: plan.pages_high,
                  model: overview.model.id,
                })
              }
              disabled={busy}
            >
              {busy ? 'Saving a copy…' : 'Repair wiki'}
            </button>
          </div>
        </div>
      )}

      {canRun && blockedReason && overview.busy && <p style={TEXT}>{blockedReason}</p>}
      {actionError && (
        <p role="alert" style={{ ...TEXT, color: 'var(--danger)', margin: '0.6rem 0 0' }}>
          {actionError}
        </p>
      )}
    </>
  );

  return (
    <SettingCard
      id="wiki-repair"
      title="Repair wiki"
      badge={badge?.label}
      badgeTone={badge?.tone}
      summary={summary}
      control={control}
      footer={footer}
    />
  );
}
