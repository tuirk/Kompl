'use client';

/**
 * The pieces of the Repair wiki card (RepairWikiCard.tsx): the plan in plain
 * words, the progress of a run, and what a finished or stopped run did with
 * the offer to put the wiki back from its backup.
 */

import Link from 'next/link';
import type { CSSProperties } from 'react';

import type { RepairOverview, RepairRunView } from '@/lib/wiki-repair/run';
import { formatCostRange, formatDuration, formatSpent } from '@/lib/page-upgrade-estimate';
import { Details } from './_ui';
import { REPAIR_COPY_RESTORE } from '@/lib/restore-copy';

export const TEXT: CSSProperties = { margin: '0 0 0.6rem', fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.55 };
export const PANEL: CSSProperties = {
  margin: '0.75rem 0',
  padding: '0.75rem 1rem',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-card)',
  fontSize: '0.85rem',
  color: 'var(--fg-secondary)',
  lineHeight: 1.55,
};
const LIST: CSSProperties = { margin: '0.3rem 0 0.6rem', paddingLeft: '1.2rem' };

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const between = (low: number, high: number, word: string, many?: string) =>
  low === high ? plural(high, word, many) : `between ${low} and ${plural(high, word, many)}`;

/** Why a run stopped, in plain words. */
export const STOP_TEXT: Record<string, string> = {
  user: 'you stopped it',
  flag_off: 'you stopped it',
  daily_cost_ceiling: "today's AI spending limit was reached",
  rate_limited: 'the AI model was too busy to answer',
  nlp_unreachable: "Kompl's language service did not answer",
  consecutive_failures: '3 pages in a row could not be rewritten',
  overspend: 'it was spending more than expected',
  pages_over_confirmed: 'more pages needed rewriting than you confirmed',
  restart: 'Kompl was restarted',
  error: 'something unexpected went wrong',
};

/** What a run will do: the eight steps, with this wiki's numbers. */
export function PlanSteps({ plan }: { plan: NonNullable<RepairOverview['plan']> }) {
  return (
    <ol style={LIST}>
      <li>Save a full copy of your wiki first, so it can be put back exactly as it is now.</li>
      <li>
        {plan.aliases > 0
          ? `Ask the AI about ${plural(plan.aliases, 'pair')} of names Kompl set aside because it was unsure they mean the same thing. Pairs the AI confirms count as one thing again; pairs it says are different are kept apart for good; any it cannot decide stay set aside.`
          : 'No doubtful name pairs are waiting for the AI.'}
        {plan.aliases_over_cap > 0 && ` ${plural(plan.aliases_over_cap, 'more pair')} wait for the next repair.`}
      </li>
      <li>Check all {plural(plan.sources, 'source')} again and give each one to the pages its names belong to.</li>
      <li>
        {plan.link_pages_high > 0
          ? `Fix links that go to the wrong page because of a name pair that is no longer used, on ${between(plan.link_pages_low, plan.link_pages_high, 'page')}. The words stay; the link goes, or points to the page with exactly that name. This needs no AI. The previous version of each page is kept.`
          : 'No link goes to the wrong page.'}
      </li>
      <li>
        {plan.sense_pages > 0
          ? `Turn ${plural(plan.sense_links, 'link')} on ${plural(plan.sense_pages, 'page')} back into plain words where a common word was linked as a name (a medical "vertigo" linked to the film Vertigo). Only where the page's own sources never write the word with a capital. This needs no AI. The previous version of each page is kept.`
          : 'No common word is linked as a name.'}
      </li>
      <li>
        {plan.title_sources > 0
          ? `Put ${plural(plan.title_sources, 'source title')} on one line (stray line breaks and spaces removed). Only the source's title changes, not the page written from it.`
          : 'Source titles are already clean.'}
      </li>
      <li>
        {plan.pages_high > 0
          ? `Rewrite ${between(plan.pages_low, plan.pages_high, 'page')} whose sources change, from their sources. The previous version of each page is kept and can be restored from the page.`
          : 'No page needs rewriting.'}
        {plan.pages_waiting > 0 && ` This includes ${plural(plan.pages_waiting, 'page')} the last repair did not get to.`}
        {plan.pages_over_cap > 0 && ` ${plural(plan.pages_over_cap, 'more page')} wait for the next repair.`}
      </li>
      <li>
        {plan.labels >= 2
          ? `Merge categories that mean the same thing (your wiki has ${plan.labels}). Only the category changes on those pages.`
          : 'Categories need no merging.'}
      </li>
    </ol>
  );
}

/** The cost line of the plan. */
export function CostLine({ overview }: { overview: RepairOverview }) {
  const e = overview.estimate;
  if (!e) return overview.estimate_error ? <p style={{ ...TEXT, color: 'var(--warning)' }}>{overview.estimate_error}</p> : null;
  const calls = e.calls_low === e.calls_high ? `${e.calls_high}` : `${e.calls_low}–${e.calls_high}`;
  return (
    <p style={TEXT}>
      With <strong>{overview.model.label}</strong> this takes {calls} AI calls, costs {formatCostRange(e.cost_usd_low, e.cost_usd_high)}{' '}
      and takes about {formatDuration(e.minutes_low, e.minutes_high)}.
    </p>
  );
}

const STEP_LABEL: Record<string, string> = {
  backup: 'Save a copy of the wiki',
  aliases: 'Ask the AI about doubtful name pairs',
  mentions: 'Give each source to the right pages',
  links: 'Fix links that go to the wrong page',
  senses: 'Unlink common words linked as names',
  titles: 'Clean up source titles',
  pages: 'Rewrite the pages whose sources changed',
  labels: 'Merge categories that mean the same thing',
};

function stepNote(run: RepairRunView, step: string): string {
  if (step === 'backup') return run.backup ? `saved as ${run.backup.file}` : '';
  if (step === 'aliases') {
    const a = run.aliases;
    return a.judged > 0 ? `${a.judged} of ${a.total} asked · ${a.confirmed} kept together · ${a.retired} kept apart` : '';
  }
  if (step === 'mentions') return run.mentions ? `${plural(run.mentions.sources, 'source')} checked` : '';
  if (step === 'links') {
    const l = run.links;
    if (!l) return '';
    const fixed = l.links > 0 ? `${plural(l.links, 'link')} fixed on ${plural(l.pages, 'page')}` : 'none needed fixing';
    return l.missed > 0 ? `${fixed} · ${plural(l.missed, 'page')} left for the next repair` : fixed;
  }
  if (step === 'senses') {
    const l = run.senses;
    if (!l) return '';
    const fixed = l.links > 0 ? `${plural(l.links, 'link')} turned back into words on ${plural(l.pages, 'page')}` : 'none found';
    return l.missed > 0 ? `${fixed} · ${plural(l.missed, 'page')} left for the next repair` : fixed;
  }
  if (step === 'titles') return run.titles ? `${plural(run.titles.sources, 'title')} cleaned` : '';
  if (step === 'pages') {
    const p = run.pages;
    return p.total > 0 ? `${p.done} of ${p.total} · ${p.rebuilt} rewritten${p.skipped ? ` · ${p.skipped} left as they were` : ''}${p.failed ? ` · ${p.failed} failed` : ''}` : '';
  }
  return run.labels ? `${plural(run.labels.merged, 'category', 'categories')} merged on ${plural(run.labels.pages, 'page')}` : '';
}

/** The eight steps with what each has done so far. */
export function RunSteps({ run }: { run: RepairRunView }) {
  return (
    <ol style={LIST}>
      {Object.keys(STEP_LABEL).map((step) => {
        const done = run.steps_done.includes(step as RepairRunView['steps_done'][number]);
        const now = run.status === 'running' && run.step === step;
        const note = stepNote(run, step);
        return (
          <li key={step} style={{ color: done ? 'var(--fg)' : now ? 'var(--fg-secondary)' : 'var(--fg-dim)' }}>
            {done ? '✓ ' : now ? '… ' : ''}
            {STEP_LABEL[step]}
            {note && <span style={{ color: 'var(--fg-muted)' }}> ({note})</span>}
            {now && step === 'pages' && run.pages.current_title && <div>Now rewriting: {run.pages.current_title}</div>}
          </li>
        );
      })}
    </ol>
  );
}

/** The end of the last run: what it did, and the way back to the wiki as it was before. */
export function RunOutcome({ run }: { run: RepairRunView }) {
  const stopped = run.status === 'stopped';
  return (
    <div style={PANEL} role="status">
      <div style={{ color: stopped ? 'var(--warning)' : 'var(--fg)' }}>
        {stopped
          ? `The repair stopped because ${STOP_TEXT[run.stop_reason ?? ''] ?? 'of a problem'}. The steps marked ✓ were done; the step it stopped in may be part done (see its count), and the rest were not started. Your wiki keeps what was done. To finish, select Repair wiki again: it carries on from your wiki as it is now.`
          : 'The last repair finished.'}
      </div>
      <RunSteps run={run} />
      <div>Spent {formatSpent(run.spent_usd)}.</div>
      {run.last_error && stopped && <div style={{ color: 'var(--fg-dim)', marginTop: '0.3rem' }}>Details: {run.last_error}</div>}
      {run.issues.length > 0 && (
        <Details label={`Pages left as they were (${run.issues.length})`}>
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {run.issues.map((i) => (
              <li key={`${i.page_id}-${i.reason}`}>
                <Link href={`/wiki/${i.page_id}`} style={{ color: 'var(--fg-secondary)' }}>{i.title}</Link>
                {i.reason === 'no_sources_left' ? ': none of its sources name it any more' : `: ${i.message}`}
              </li>
            ))}
          </ul>
        </Details>
      )}
      {run.backup && (
        <div style={{ marginTop: '0.6rem' }}>
          Your wiki as it was before this repair is saved.{' '}
          <a href="/api/wiki/repair/backup" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>Download that copy</a>.{' '}
          {REPAIR_COPY_RESTORE}
        </div>
      )}
      {run.pages_waiting > 0 && (
        <div style={{ marginTop: '0.4rem' }}>
          {plural(run.pages_waiting, 'page')} still {run.pages_waiting === 1 ? 'waits' : 'wait'} to be rewritten; the next repair starts with them.
        </div>
      )}
    </div>
  );
}
