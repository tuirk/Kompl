import type { ReactNode } from 'react';
import Link from 'next/link';
import { RetryButton } from '@/components/RetryButton';
import { friendlyIngestError } from './ingest-error-copy';
import { normalizeLintResult, lintCounts } from './lint-result';
import { MAX_TRIAGE_ATTEMPTS } from './triage-recheck-limits';

// ── Shared shapes ──────────────────────────────────────────────────────────
// FeedActivityRow is the CLIENT-facing row shape — includes server-joined
// source_title. db.ts has its own ActivityRow (pre-existing duplicate
// declarations at lib/db.ts:175 and lib/db.ts:2552, merged by TS); we keep
// a self-contained type here to avoid a type-only circular import.
export interface FeedActivityRow {
  id: number;
  timestamp: string;
  action_type: string;
  source_id: string | null;
  source_title: string | null;
  details: string | null;
}

export type Tone = 'mint' | 'neut' | 'dim' | 'red';

export interface Badge {
  label: string;
  tone: Tone;
}

export interface RowContent {
  primary:   ReactNode;
  secondary: ReactNode;
  action:    ReactNode;
  isError:   boolean;
}

export interface ActivityEventDef {
  key:        string;
  badge:      Badge | ((row: FeedActivityRow) => Badge);
  render:     (row: FeedActivityRow) => RowContent;
  retriable?: boolean;
}

// ── Internal helpers (shared by render fns) ────────────────────────────────
function parseDetails(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function makeGetters(row: FeedActivityRow) {
  const d = parseDetails(row.details);
  const str = (k: string): string | null =>
    d && typeof d[k] === 'string' ? (d[k] as string) : null;
  const num = (k: string): number | null =>
    d && typeof d[k] === 'number' ? (d[k] as number) : null;
  return { d, str, num };
}

const LINK_STYLE = { color: 'inherit', textDecoration: 'none' };
const MONO_DIM: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--fg-dim)',
};
const MONO_ERR: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 10 };

// ── Render functions (one per event type) ──────────────────────────────────

function renderSourceOnly(row: FeedActivityRow): RowContent {
  // Shared by ingest_accepted, ingest_complete, source_stored, source_compiled.
  const { str } = makeGetters(row);
  const detailTitle = str('title');
  const source_id = row.source_id;
  const resolvedSourceTitle = row.source_title ?? str('source_title');
  const name = resolvedSourceTitle ?? detailTitle ?? source_id?.slice(0, 8) ?? '…';
  const primary = source_id
    ? <Link href={`/source/${source_id}`} style={LINK_STYLE}><strong>{name}</strong></Link>
    : <strong>{name}</strong>;
  const action = source_id
    ? <Link href={`/source/${source_id}`} style={{ ...LINK_STYLE, color: 'var(--fg-dim)' }}>View</Link>
    : null;
  return { primary, secondary: null, action, isError: false };
}

function renderPageCompiled(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const detailTitle = str('title');
  const page_id = str('page_id');
  const source_id = row.source_id;
  const resolvedSourceTitle = row.source_title ?? str('source_title');
  const action_str = str('action') === 'update' ? 'updated' : 'created';
  const pageName = detailTitle ?? page_id ?? '…';
  const primary = page_id
    ? <Link href={`/wiki/${page_id}`} style={LINK_STYLE}><strong>{pageName}</strong></Link>
    : <strong>{pageName}</strong>;
  const secondary = resolvedSourceTitle
    ? <span style={MONO_DIM}>
        {action_str} from{' '}
        {source_id
          ? <Link href={`/source/${source_id}`} style={LINK_STYLE}>{resolvedSourceTitle}</Link>
          : resolvedSourceTitle}
      </span>
    : null;
  const action = page_id
    ? <Link href={`/wiki/${page_id}`} style={{ ...LINK_STYLE, color: 'var(--fg-dim)' }}>View</Link>
    : null;
  return { primary, secondary, action, isError: false };
}

function renderExtractionComplete(row: FeedActivityRow): RowContent {
  const { str, num } = makeGetters(row);
  const detailTitle = str('title');
  const source_id = row.source_id;
  const resolvedSourceTitle = row.source_title ?? str('source_title');
  const entities = num('entity_count') ?? 0;
  const concepts = num('concept_count') ?? 0;
  const claims = num('claim_count') ?? 0;
  const name = resolvedSourceTitle ?? detailTitle ?? source_id?.slice(0, 8) ?? '…';
  const primary = <strong>{entities} entities · {concepts} concepts · {claims} claims</strong>;
  const secondary = <span style={MONO_DIM}>
    from {source_id
      ? <Link href={`/source/${source_id}`} style={LINK_STYLE}>{name}</Link>
      : name}
  </span>;
  return { primary, secondary, action: null, isError: false };
}

function renderResolutionComplete(row: FeedActivityRow): RowContent {
  const { num } = makeGetters(row);
  const merged = num('merged_count') ?? 0;
  const resolved = num('resolved_count') ?? 0;
  return {
    primary: <strong>{merged} entities merged → {resolved} canonical</strong>,
    secondary: null,
    action: null,
    isError: false,
  };
}

// Name pairs entity resolution never put to the LLM: over the per-compile
// cap, or in a batch whose call failed. Each may be a duplicate kept as two
// pages.
function renderResolutionPairsUnchecked(row: FeedActivityRow): RowContent {
  const { num } = makeGetters(row);
  const overCap = num('over_cap') ?? 0;
  const failed = num('llm_failed') ?? 0;
  const parts: string[] = [];
  if (overCap > 0) parts.push(`${overCap} over the ${num('cap') ?? 120}-pair limit`);
  if (failed > 0) parts.push(`${failed} in AI calls that failed`);
  return {
    primary: <strong>{overCap + failed} possible duplicate pairs not checked</strong>,
    secondary: parts.length > 0 ? <span style={MONO_DIM}>{parts.join(' · ')}</span> : null,
    action: null,
    isError: false,
  };
}

// Written by compile/match: checks of this session's sources against
// existing pages that gave no verdict. Nothing was recorded on those pages.
function renderMatchTriageFailed(row: FeedActivityRow): RowContent {
  const { d, num } = makeGetters(row);
  const failed = num('failed') ?? 0;
  const parts: string[] = [];
  const costCeiling = num('cost_ceiling') ?? 0;
  const rateLimited = num('rate_limited') ?? 0;
  const errors = num('errors') ?? 0;
  if (costCeiling > 0) parts.push(`${costCeiling} hit the daily cost limit`);
  if (rateLimited > 0) parts.push(`${rateLimited} rate limited`);
  if (errors > 0) parts.push(`${errors} failed`);
  const examples = Array.isArray(d?.examples)
    ? (d.examples as Array<{ source_title?: unknown; page_title?: unknown }>)
        .filter((e) => typeof e.page_title === 'string')
        .map((e) => (typeof e.source_title === 'string' ? `${e.source_title} → ${e.page_title as string}` : (e.page_title as string)))
    : [];
  if (examples.length > 0) parts.push(examples.join(', '));
  return {
    primary: <strong>{failed} {failed === 1 ? 'check' : 'checks'} against existing pages not done</strong>,
    secondary: parts.length > 0 ? <span style={MONO_DIM}>{parts.join(' · ')}</span> : null,
    action: null,
    isError: false,
  };
}

// Written by compile/match: stored checks that failed in an earlier compile
// and were run again (lib/compile/triage-recheck.ts), or dropped.
function renderMatchTriageRechecked(row: FeedActivityRow): RowContent {
  const { d, num } = makeGetters(row);
  const rechecked = num('rechecked') ?? 0;
  const dropped = num('dropped') ?? 0;
  const gaveUp = num('gave_up') ?? 0;
  const failed = num('failed') ?? 0;
  const costCeiling = num('cost_ceiling') ?? 0;
  const parts: string[] = [];
  const answered = num('answered') ?? 0;
  if (answered > 0) parts.push(`${answered} answered`);
  if (failed > 0) parts.push(`${failed} failed again${costCeiling > 0 ? ` (${costCeiling} hit the daily cost limit)` : ''}`);
  if (gaveUp > 0) parts.push(`${gaveUp} given up after ${MAX_TRIAGE_ATTEMPTS} tries`);
  if (dropped - gaveUp > 0) parts.push(`${dropped - gaveUp} no longer needed`);
  const waiting = num('waiting') ?? 0;
  if (waiting > 0) parts.push(`${waiting} still waiting`);
  const givenUp = Array.isArray(d?.examples)
    ? (d.examples as Array<{ source_title?: unknown; page_title?: unknown; outcome?: unknown }>)
        .filter((e) => e.outcome === 'gave_up' && typeof e.page_title === 'string')
        .map((e) => (typeof e.source_title === 'string' ? `${e.source_title} → ${e.page_title as string}` : (e.page_title as string)))
    : [];
  if (givenUp.length > 0) parts.push(`given up: ${givenUp.join(', ')}`);
  const n = rechecked > 0 ? rechecked : dropped;
  return {
    primary: (
      <strong>
        {n} earlier failed {n === 1 ? 'check' : 'checks'} against existing pages {rechecked > 0 ? 'run again' : 'dropped'}
      </strong>
    ),
    secondary: parts.length > 0 ? <span style={MONO_DIM}>{parts.join(' · ')}</span> : null,
    action: null,
    isError: false,
  };
}

// Stored name matches the alias screen set aside (lib/alias-screen.ts): new
// sources stop following them until a later compile matches the names again.
function renderAliasesSuspended(row: FeedActivityRow): RowContent {
  const { d, num } = makeGetters(row);
  const n = num('suspended') ?? 0;
  const examples = Array.isArray(d?.examples)
    ? (d.examples as Array<{ alias?: unknown; canonical?: unknown }>)
        .filter((e) => typeof e.alias === 'string' && typeof e.canonical === 'string')
        .map((e) => `${e.alias as string} → ${e.canonical as string}`)
    : [];
  const more = n > examples.length && examples.length > 0 ? ` and ${n - examples.length} more` : '';
  return {
    primary: <strong>{n} name {n === 1 ? 'match' : 'matches'} set aside</strong>,
    secondary: (
      <span style={MONO_DIM}>
        {examples.length > 0 ? `${examples.join(', ')}${more} · ` : ''}
        new sources no longer go to these pages under these names
      </span>
    ),
    action: null,
    isError: false,
  };
}

// Shared by failure events. `retriable=true` renders a RetryButton; `false`
// renders a danger-coloured View link (legacy behaviour for
// entity_expansion_failed, which was in the old case-list but NOT in
// RETRIABLE_TYPES).
const FAILURE_VIEW_STYLE: React.CSSProperties = {
  color: 'var(--danger)',
  textDecoration: 'none',
  fontFamily: 'var(--font-body)',
  fontWeight: 700,
  fontSize: 10,
  letterSpacing: '1px',
  textTransform: 'uppercase',
};

function makeFailureRenderer(retriable: boolean) {
  return (row: FeedActivityRow): RowContent => {
    const { str } = makeGetters(row);
    const detailTitle = str('title');
    const source_id = row.source_id;
    const resolvedSourceTitle = row.source_title ?? str('source_title');
    const name = resolvedSourceTitle ?? detailTitle ?? source_id?.slice(0, 8) ?? '…';
    const primary = source_id
      ? <Link href={`/source/${source_id}`} style={LINK_STYLE}><strong>{name}</strong></Link>
      : <strong>{name}</strong>;
    const errText = str('error');
    const secondary = errText ? <span style={MONO_ERR}>{errText}</span> : null;
    const action = source_id
      ? retriable
        ? <RetryButton sourceId={source_id} />
        : <Link href={`/source/${source_id}`} style={FAILURE_VIEW_STYLE}>View</Link>
      : null;
    return { primary, secondary, action, isError: true };
  };
}

const renderFailureWithRetry = makeFailureRenderer(true);
const renderFailureNoRetry = makeFailureRenderer(false);

function renderSourceRecompileTriggered(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const detailTitle = str('title');
  const source_id = row.source_id;
  const resolvedSourceTitle = row.source_title ?? str('source_title');
  const name = resolvedSourceTitle ?? detailTitle ?? source_id?.slice(0, 8) ?? '…';
  const primary = source_id
    ? <Link href={`/source/${source_id}`} style={LINK_STYLE}><strong>{name}</strong></Link>
    : <strong>{name}</strong>;
  const secondary = <span style={MONO_DIM}>recompile triggered</span>;
  const action = source_id
    ? <Link href={`/source/${source_id}`} style={{ ...LINK_STYLE, color: 'var(--fg-dim)' }}>View</Link>
    : null;
  return { primary, secondary, action, isError: false };
}

function renderDraftApproved(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const title = str('title');
  return { primary: <strong>{title ?? '…'}</strong>, secondary: null, action: null, isError: false };
}

function renderDraftRejected(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const title = str('title');
  return { primary: <strong>{title ?? '…'}</strong>, secondary: null, action: null, isError: true };
}

function renderSourceStateChange(isError: boolean) {
  return (row: FeedActivityRow): RowContent => {
    const { str } = makeGetters(row);
    const detailTitle = str('title');
    const source_id = row.source_id;
    const resolvedSourceTitle = row.source_title ?? str('source_title');
    const name = resolvedSourceTitle ?? detailTitle ?? source_id?.slice(0, 8) ?? '…';
    return { primary: <strong>{name}</strong>, secondary: null, action: null, isError };
  };
}

function renderPageArchived(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const detailTitle = str('title');
  const page_id = str('page_id');
  const pageName = detailTitle ?? page_id ?? '…';
  const primary = page_id
    ? <Link href={`/wiki/${page_id}`} style={LINK_STYLE}><strong>{pageName}</strong></Link>
    : <strong>{pageName}</strong>;
  return { primary, secondary: null, action: null, isError: false };
}

function renderPageDeleted(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const detailTitle = str('title');
  const page_id = str('page_id');
  const pageName = detailTitle ?? page_id ?? '…';
  const reason = str('reason');
  const reasonText = reason === 'no_remaining_sources'
    ? 'no sources remained'
    : reason === 'sole_remaining_source'
      ? 'sole source deleted'
      : reason === 'all_remaining_in_batch'
        ? 'all remaining sources deleted in batch'
        : null;
  const secondary = reasonText ? <span style={MONO_DIM}>{reasonText}</span> : null;
  return { primary: <strong>{pageName}</strong>, secondary, action: null, isError: true };
}

function renderPageRecompiled(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const detailTitle = str('title');
  const page_id = str('page_id');
  const pageName = detailTitle ?? page_id ?? '…';
  const primary = page_id
    ? <Link href={`/wiki/${page_id}`} style={LINK_STYLE}><strong>{pageName}</strong></Link>
    : <strong>{pageName}</strong>;
  const secondary = <span style={MONO_DIM}>rewritten after source removed</span>;
  const action = page_id
    ? <Link href={`/wiki/${page_id}`} style={{ ...LINK_STYLE, color: 'var(--fg-dim)' }}>View</Link>
    : null;
  return { primary, secondary, action, isError: false };
}

function renderPageProvenanceUpdated(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const detailTitle = str('title');
  const page_id = str('page_id');
  const pageName = detailTitle ?? page_id ?? '…';
  const primary = page_id
    ? <Link href={`/wiki/${page_id}`} style={LINK_STYLE}><strong>{pageName}</strong></Link>
    : <strong>{pageName}</strong>;
  const secondary = <span style={MONO_DIM}>provenance note added</span>;
  const action = page_id
    ? <Link href={`/wiki/${page_id}`} style={{ ...LINK_STYLE, color: 'var(--fg-dim)' }}>View</Link>
    : null;
  return { primary, secondary, action, isError: false };
}

function renderPageContradictionDetected(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const pageTitle = str('page_title');
  const page_id = str('page_id');
  const sourceTitle = str('source_title');
  const reason = str('reason');
  const pageName = pageTitle ?? page_id ?? '…';
  const primary = page_id
    ? <Link href={`/wiki/${page_id}`} style={LINK_STYLE}><strong>{pageName}</strong></Link>
    : <strong>{pageName}</strong>;
  const sourceFragment = sourceTitle ? `"${sourceTitle}" ` : '';
  const reasonFragment = reason ? ` — ${reason}` : '';
  const secondary = <span style={MONO_DIM}>{sourceFragment}contradicts this page{reasonFragment}</span>;
  const action = page_id
    ? <Link href={`/wiki/${page_id}`} style={{ ...LINK_STYLE, color: 'var(--fg-dim)' }}>View</Link>
    : null;
  return { primary, secondary, action, isError: false };
}

function renderPageRecompileFailed(row: FeedActivityRow): RowContent {
  const { d, str } = makeGetters(row);
  const detailTitle = str('title');
  const page_id = str('page_id');
  const pageName = detailTitle ?? page_id ?? '…';
  const primary = page_id
    ? <Link href={`/wiki/${page_id}`} style={LINK_STYLE}><strong>{pageName}</strong></Link>
    : <strong>{pageName}</strong>;
  const errMsg = str('error');
  // A page archived until it is rewritten (lib/page-hold.ts) says so.
  const hidden = d?.hidden === true;
  const text = hidden ? `archived until it is rewritten${errMsg ? ` · ${errMsg}` : ''}` : errMsg;
  const secondary = text ? <span style={MONO_ERR}>{text}</span> : null;
  const action = page_id
    ? <Link href={`/wiki/${page_id}`} style={{ ...LINK_STYLE, color: 'var(--danger)' }}>View</Link>
    : null;
  return { primary, secondary, action, isError: true };
}

/**
 * Page-level actions (page update, Restore): page link + what happened.
 * `what` may read the row's details (e.g. the rules version it recorded).
 */
function renderPageAction(what: string | ((str: (k: string) => string | null) => string)) {
  return function renderPageActionRow(row: FeedActivityRow): RowContent {
    const { str } = makeGetters(row);
    const page_id = str('page_id');
    const pageName = str('title') ?? page_id ?? '…';
    const primary = page_id
      ? <Link href={`/wiki/${page_id}`} style={LINK_STYLE}><strong>{pageName}</strong></Link>
      : <strong>{pageName}</strong>;
    const action = page_id
      ? <Link href={`/wiki/${page_id}`} style={{ ...LINK_STYLE, color: 'var(--fg-dim)' }}>View</Link>
      : null;
    const text = typeof what === 'string' ? what : what(str);
    return { primary, secondary: <span style={MONO_DIM}>{text}</span>, action, isError: false };
  };
}

/** A Disputed/Changed section a page records in its own text (lib/disagreements.ts). */
function renderPageDisputeRecorded(row: FeedActivityRow): RowContent {
  const { d, str } = makeGetters(row);
  const page_id = str('page_id');
  const anchor = str('anchor');
  const href = page_id ? `/wiki/${page_id}${anchor ? `#${anchor}` : ''}` : null;
  const pageName = str('title') ?? page_id ?? '…';
  const sides = d && Array.isArray(d.source_ids) ? d.source_ids.length : 0;
  const primary = href
    ? <Link href={href} style={LINK_STYLE}><strong>{pageName}</strong></Link>
    : <strong>{pageName}</strong>;
  const action = href
    ? <Link href={href} style={{ ...LINK_STYLE, color: 'var(--fg-dim)' }}>View</Link>
    : null;
  const topic = str('topic') ?? 'a claim';
  // kind (from the disagreements record): 'changed' is a claim a later
  // source superseded; rows logged before it carry none and were disputes.
  const text =
    str('kind') === 'changed'
      ? `changed: ${topic}${sides > 0 ? ` · ${sides} sources` : ''}`
      : sides > 0
        ? `disputed: ${topic} · ${sides} sources disagree`
        : `disputed: ${topic}`;
  return { primary, secondary: <span style={MONO_DIM}>{text}</span>, action, isError: false };
}

const PAGE_UPGRADE_STOP_TEXT: Record<string, string> = {
  user: 'stopped by you',
  flag_off: 'stopped by you',
  compile_started: 'a compile started',
  daily_cost_ceiling: "today's spending limit reached",
  consecutive_failures: '3 failures in a row',
  overspend: 'spending passed 1.5 × the estimate',
  error: 'unexpected error',
};

/** One row per run of the bulk page update (lib/page-upgrade.ts): started, finished or stopped. */
function renderPageUpgradeRun(row: FeedActivityRow): RowContent {
  const { str, num } = makeGetters(row);
  const phase = str('phase');
  const pages = num('pages') ?? 0;
  const verb = phase === 'started' ? 'started' : phase === 'finished' ? 'finished' : 'stopped';
  const parts =
    phase === 'started'
      ? [`${pages} page${pages !== 1 ? 's' : ''}`]
      : [
          `${num('updated') ?? 0} updated`,
          `${num('skipped') ?? 0} skipped`,
          `${num('failed') ?? 0} failed`,
          phase === 'stopped' ? PAGE_UPGRADE_STOP_TEXT[str('reason') ?? ''] ?? null : null,
        ].filter((p): p is string => Boolean(p));
  return {
    primary: <>Page update to the {str('rules') ?? 'current'} writing rules {verb}</>,
    secondary: <span style={MONO_DIM}>{parts.join(' · ')}</span>,
    action: <Link href="/settings#page-upgrade" style={{ ...LINK_STYLE, color: 'var(--fg-dim)' }}>View</Link>,
    isError: phase === 'stopped' && (str('reason') === 'error' || str('reason') === 'consecutive_failures'),
  };
}

const WIKI_REPAIR_STOP_TEXT: Record<string, string> = {
  user: 'stopped by you',
  flag_off: 'stopped by you',
  daily_cost_ceiling: "today's spending limit reached",
  rate_limited: 'the AI model was busy',
  nlp_unreachable: "Kompl's NLP service did not answer",
  consecutive_failures: '3 pages in a row failed',
  overspend: 'spending passed 1.5 × the estimate',
  pages_over_confirmed: 'more pages to rewrite than confirmed',
  restart: 'Kompl restarted',
  error: 'unexpected error',
};

const WIKI_REPAIR_STEP_TEXT: Record<string, string> = {
  backup: 'backup saved',
  aliases: 'name matches checked',
  mentions: 'sources given to the right pages',
  links: 'links to the wrong page fixed',
  pages: 'pages rewritten',
  labels: 'categories tidied',
};

/** The wiki repair (lib/wiki-repair): one row per finished step, one for the end. */
function renderWikiRepair(row: FeedActivityRow): RowContent {
  const { str, num } = makeGetters(row);
  const phase = str('phase');
  const step = str('step') ?? '';
  const n = (k: string) => num(k) ?? 0;
  let primary: string;
  let parts: string[];
  if (phase === 'step') {
    primary = `Wiki repair: ${WIKI_REPAIR_STEP_TEXT[step] ?? step}`;
    parts =
      step === 'backup'
        ? [str('file') ?? '']
        : step === 'aliases'
          ? [`${n('confirmed')} kept`, `${n('retired')} retired`, `${n('undecided')} undecided`]
          : step === 'mentions'
            ? [`${n('sources')} sources`, `${n('pages')} pages to rewrite`]
            : step === 'links'
              ? [`${n('links')} links`, `${n('pages')} pages`, n('missed') > 0 ? `${n('missed')} left for the next repair` : '']
              : step === 'pages'
                ? [`${n('rebuilt')} rewritten`, `${n('skipped')} skipped`, `${n('failed')} failed`]
                : [`${n('merged')} merged`, `${n('pages')} pages`];
  } else {
    primary = phase === 'finished' ? 'Wiki repair finished' : 'Wiki repair stopped';
    parts = [
      `${n('pages_rebuilt')} pages rewritten`,
      `${n('aliases_retired')} name matches retired`,
      n('links_corrected') > 0 ? `${n('links_corrected')} links fixed` : '',
      phase === 'stopped' ? WIKI_REPAIR_STOP_TEXT[str('reason') ?? ''] ?? '' : '',
    ];
  }
  return {
    primary: <>{primary}</>,
    secondary: <span style={MONO_DIM}>{parts.filter(Boolean).join(' · ')}</span>,
    action: <Link href="/settings#wiki-repair" style={{ ...LINK_STYLE, color: 'var(--fg-dim)' }}>View</Link>,
    isError: phase === 'stopped' && ['error', 'consecutive_failures', 'nlp_unreachable'].includes(str('reason') ?? ''),
  };
}

function renderLintComplete(row: FeedActivityRow): RowContent {
  const { d } = makeGetters(row);
  const raw = d as Record<string, unknown> | null;
  const normalized = raw ? normalizeLintResult(raw) : null;
  const c = normalized ? lintCounts(normalized, raw) : null;
  const secondary = c
    ? (
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-dim)' }}>
        {[
          `${c.orphans} orphan${c.orphans !== 1 ? 's' : ''}`,
          `${c.stale} stale`,
          `${c.crossRefs} cross-ref${c.crossRefs !== 1 ? 's' : ''}`,
          c.deadProv > 0 && `${c.deadProv} dead prov`,
          // Passes since plan 3.6 look for none (the whole-wiki check does).
          c.contradictions > 0 && `${c.contradictions} contradiction${c.contradictions !== 1 ? 's' : ''}`,
        ].filter(Boolean).join(' · ')}
      </span>
    )
    : null;
  return { primary: <>Wiki lint pass</>, secondary, action: null, isError: false };
}

function renderOnboardingConfirmed(_row: FeedActivityRow): RowContent {
  return { primary: <>Onboarding completed</>, secondary: null, action: null, isError: false };
}

function renderWikiImported(row: FeedActivityRow): RowContent {
  const { num } = makeGetters(row);
  const sources = num('source_count');
  const pages = num('page_count');
  // Rows an old backup held for sources or pages it lacked (api/import).
  const skipped = num('skipped_rows');
  const parts = [
    sources !== null && `${sources} source${sources !== 1 ? 's' : ''}`,
    pages !== null && `${pages} page${pages !== 1 ? 's' : ''}`,
    skipped !== null && skipped > 0 && `${skipped} row${skipped !== 1 ? 's' : ''} left out: the backup lacked their sources or pages`,
  ].filter(Boolean);
  const secondary = parts.length > 0
    ? <span style={MONO_DIM}>{parts.join(' · ')}</span>
    : null;
  return { primary: <>Wiki imported</>, secondary, action: null, isError: false };
}

function renderCompileCancelled(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const step = str('current_step');
  const secondary = <span style={MONO_DIM}>
    {step ? `at step: ${step}` : 'before first step'}
  </span>;
  return { primary: <>Compile cancelled</>, secondary, action: null, isError: false };
}

function renderCompileRetried(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const secondary = <span style={MONO_DIM}>{str('message') ?? 'retry pressed'}</span>;
  return { primary: <>Compile retried by you</>, secondary, action: null, isError: false };
}

function renderPendingDraftsCleaned(row: FeedActivityRow): RowContent {
  const { str, num } = makeGetters(row);
  const detailTitle = str('title');
  const source_id = row.source_id;
  const resolvedSourceTitle = row.source_title ?? str('source_title');
  const name = resolvedSourceTitle ?? detailTitle ?? source_id?.slice(0, 8) ?? '…';
  const rewritten = num('rewritten') ?? 0;
  const deleted = num('deleted') ?? 0;
  const secondary = <span style={MONO_DIM}>
    pending drafts: {rewritten} rewritten · {deleted} dropped
  </span>;
  return { primary: <strong>{name}</strong>, secondary, action: null, isError: false };
}

function renderChatDraftsCleaned(row: FeedActivityRow): RowContent {
  const { str, num } = makeGetters(row);
  const page_id = str('page_id');
  const page_title = str('page_title') ?? page_id ?? '…';
  const rewritten = num('rewritten') ?? 0;
  const deleted = num('deleted') ?? 0;
  const secondary = <span style={MONO_DIM}>
    chat drafts: {rewritten} rewritten · {deleted} dropped
  </span>;
  return { primary: <strong>{page_title}</strong>, secondary, action: null, isError: false };
}

function renderTitleRescued(row: FeedActivityRow): RowContent {
  // Phase-2 LLM-title rescue: the extract LLM derived a real document title
  // and replaced the filename stub. Show old → new so the user understands
  // why the source's display name changed.
  const { str } = makeGetters(row);
  const oldTitle = str('old_title') ?? '…';
  const newTitle = str('new_title') ?? str('title') ?? '…';
  const source_id = row.source_id;
  const primary = source_id
    ? <Link href={`/source/${source_id}`} style={LINK_STYLE}><strong>{newTitle}</strong></Link>
    : <strong>{newTitle}</strong>;
  const secondary = (
    <span style={MONO_DIM}>was: {oldTitle}</span>
  );
  const action = source_id
    ? <Link href={`/source/${source_id}`} style={{ ...LINK_STYLE, color: 'var(--fg-dim)' }}>View</Link>
    : null;
  return { primary, secondary, action, isError: false };
}

function renderSavedLinkDismissed(row: FeedActivityRow): RowContent {
  const { str, num } = makeGetters(row);
  const count = num('count');
  const title = str('title');
  const source_url = str('source_url');
  const primary = count !== null && count > 1
    ? <>Dismissed {count} saved links</>
    : <strong>{title ?? source_url ?? 'Saved link dismissed'}</strong>;
  const secondary = count !== null && count > 1
    ? null
    : (source_url && title ? <span style={MONO_DIM}>{source_url}</span> : null);
  return { primary, secondary, action: null, isError: false };
}

function renderDigestOrLintFailed(label: string) {
  return (row: FeedActivityRow): RowContent => {
    const { str } = makeGetters(row);
    const err = str('error');
    const secondary = err ? <span style={MONO_ERR}>{err}</span> : null;
    return { primary: <>{label}</>, secondary, action: null, isError: true };
  };
}

function renderDraftTooThin(row: FeedActivityRow): RowContent {
  const { str, num } = makeGetters(row);
  const name = str('title') ?? '…';
  const chars = num('chars');
  const threshold = num('threshold');
  const secondary = (chars !== null && threshold !== null)
    ? <span style={MONO_DIM}>{chars} chars · threshold {threshold}</span>
    : null;
  return { primary: <strong>{name}</strong>, secondary, action: null, isError: false };
}

function renderDraftQueuedForApproval(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const name = str('title') ?? '…';
  const pageType = str('page_type');
  const secondary = <span style={MONO_DIM}>
    queued for approval{pageType ? ` · ${pageType}` : ''}
  </span>;
  return { primary: <strong>{name}</strong>, secondary, action: null, isError: false };
}

function renderLabelsMerged(row: FeedActivityRow): RowContent {
  // Written by the compile's 'labels' step (lib/compile/label-merge.ts).
  const { d, num } = makeGetters(row);
  const merged = num('merged') ?? 0;
  const pages = num('drafts') ?? 0;
  const shown = Array.isArray(d?.merges)
    ? (d.merges as Array<{ label?: unknown; into?: unknown }>)
        .filter((m) => typeof m.label === 'string' && typeof m.into === 'string')
        .slice(0, 5)
        .map((m) => `${m.label as string} → ${m.into as string}`)
    : [];
  const more = merged > shown.length && shown.length > 0 ? ` and ${merged - shown.length} more` : '';
  return {
    primary: <strong>{merged} duplicate {merged === 1 ? 'category' : 'categories'} merged</strong>,
    secondary: (
      <span style={MONO_DIM}>
        {shown.length > 0 ? `${shown.join(', ')}${more} · ` : ''}
        {pages} {pages === 1 ? 'page' : 'pages'} from this compile
      </span>
    ),
    action: null,
    isError: false,
  };
}

const CLAIM_CHECK_STOP_TEXT: Record<string, string> = {
  daily_cost_ceiling: "stopped: today's spending limit reached",
  rate_limited: 'stopped: rate limited',
  failures: 'stopped: 3 failed checks in a row',
  stopped: 'stopped',
};

const CLAIM_KIND_TEXT: Record<string, string> = {
  disputed: 'disputed',
  changed: 'changed',
  scope: 'different scope',
  opinion: 'different opinions',
};

/**
 * One row per claim check (lib/claim-check/run.ts): a compile's check of its
 * new sources' claims, or a whole-wiki check run from Settings.
 */
function renderClaimCheckRun(row: FeedActivityRow): RowContent {
  const { d, str, num } = makeGetters(row);
  const wiki = str('found_by') === 'wiki_check';
  const findings = num('findings') ?? 0;
  const judged = num('judged') ?? 0;
  const examples = Array.isArray(d?.examples)
    ? (d.examples as Array<{ page_id?: unknown; page_title?: unknown; topic?: unknown; kind?: unknown }>).filter(
        (e) => typeof e.page_id === 'string' && typeof e.page_title === 'string',
      )
    : [];
  const shown = examples.map(
    (e) => `${e.page_title as string}: ${typeof e.topic === 'string' ? e.topic : ''}${typeof e.kind === 'string' && CLAIM_KIND_TEXT[e.kind] ? ` (${CLAIM_KIND_TEXT[e.kind]})` : ''}`,
  );
  const stop = CLAIM_CHECK_STOP_TEXT[str('stopped') ?? ''] ?? null;
  const parts = [`${judged} claim ${judged === 1 ? 'pair' : 'pairs'} checked`, ...shown, ...(stop ? [stop] : [])];
  const first = examples[0]?.page_id as string | undefined;
  return {
    primary: (
      <strong>
        {wiki ? 'Wiki check' : 'Claim check'}: {findings} possible {findings === 1 ? 'disagreement' : 'disagreements'}
      </strong>
    ),
    secondary: <span style={MONO_DIM}>{parts.join(' · ')}</span>,
    action: first ? (
      <Link href={`/wiki/${first}`} style={{ ...LINK_STYLE, color: 'var(--fg-dim)' }}>View</Link>
    ) : wiki ? (
      <Link href="/settings#wiki-check" style={{ ...LINK_STYLE, color: 'var(--fg-dim)' }}>View</Link>
    ) : null,
    isError: false,
  };
}

// ── NEW render fns for Onboarding v2 Phase 1 events ────────────────────────

function renderOnboardingStaged(row: FeedActivityRow): RowContent {
  const { str, num } = makeGetters(row);
  const connector = str('connector');
  const count = num('count') ?? 0;
  const label = count === 1 ? 'item' : 'items';
  const secondary = connector
    ? <span style={MONO_DIM}>via {connector}</span>
    : null;
  return {
    primary: <>{count} {label} staged</>,
    secondary,
    action: null,
    isError: false,
  };
}

function renderAgentSourcesAdded(row: FeedActivityRow): RowContent {
  const { str, num } = makeGetters(row);
  const count = num('count') ?? 0;
  const client = str('client');
  const session = str('session_id');
  return {
    primary: <>{client ?? 'An AI agent'} added {count} {count === 1 ? 'source' : 'sources'}</>,
    secondary: <span style={MONO_DIM}>via MCP add_source</span>,
    action: session ? (
      <Link href={`/onboarding/progress?session_id=${encodeURIComponent(session)}`} style={{ ...LINK_STYLE, color: 'var(--fg-dim)' }}>
        Progress
      </Link>
    ) : null,
    isError: false,
  };
}

function renderOnboardingBlockedUrlsSkipped(row: FeedActivityRow): RowContent {
  const { d, str, num } = makeGetters(row);
  const count = num('count') ?? 0;
  const connector = str('connector');
  const samples = d && Array.isArray(d.sample_urls)
    ? (d.sample_urls as unknown[]).filter((u): u is string => typeof u === 'string')
    : [];
  const label = count === 1 ? 'X/Twitter URL skipped' : 'X/Twitter URLs skipped';
  const parts: string[] = [];
  if (connector) parts.push(`via ${connector}`);
  if (samples.length > 0) parts.push(samples.join(', '));
  const secondary = parts.length > 0
    ? <span style={MONO_DIM}>{parts.join(' · ')}</span>
    : null;
  return {
    primary: <>{count} {label}</>,
    secondary,
    action: null,
    isError: false,
  };
}

function renderIngestUrlFailed(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const url = str('url');
  const error_code = str('error_code');
  const error = str('error');
  const name = url ?? '(unknown URL)';
  // Prefer the friendly copy for known FastAPI `detail` codes embedded in the
  // wrapped error string (e.g. `nlp_convert_failed: 422 {"detail":"youtube_transcript_blocked"}`).
  // Falls back to the bare outer error_code for everything else.
  const friendly = error ? friendlyIngestError(error) : null;
  const secondary = friendly
    ? <span style={MONO_ERR}>{friendly}</span>
    : error_code ? <span style={MONO_ERR}>{error_code}</span> : null;
  return {
    primary: <strong>{name}</strong>,
    secondary,
    action: null,
    isError: true,
  };
}

function renderIngestFileFailed(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const filename = str('filename');
  const file_path = str('file_path');
  const error_code = str('error_code');
  const name = filename ?? file_path ?? '(unknown file)';
  const secondary = error_code ? <span style={MONO_ERR}>{error_code}</span> : null;
  return {
    primary: <strong>{name}</strong>,
    secondary,
    action: null,
    isError: true,
  };
}

function renderIngestTextFailed(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const connector = str('connector') ?? 'text';
  const err = str('error');
  const secondary = err ? <span style={MONO_ERR}>{err}</span> : null;
  return {
    primary: <>{connector} ingest failed</>,
    secondary,
    action: null,
    isError: true,
  };
}

// ── Registry ───────────────────────────────────────────────────────────────
// Each entry's `key` feeds the ActivityEventType union. The `render` field
// returns the row's view-model; `badge` may be static or a function of the
// row (page_compiled branches on details.action).
//
// Legacy entries (ingest_accepted, source_stored, ingest_complete,
// source_compiled, entity_expansion_failed) exist for historical rows in
// the DB — no TS writer targets them.

export const ACTIVITY_EVENTS = {
  // ── Compile pipeline ────────────────────────────────────────────────────
  page_compiled: {
    key: 'page_compiled',
    badge: (row: FeedActivityRow) => {
      const { str } = makeGetters(row);
      return str('action') === 'update'
        ? { label: 'UPDATED', tone: 'neut' as Tone }
        : { label: 'CREATED', tone: 'mint' as Tone };
    },
    render: renderPageCompiled,
  },
  extraction_complete:    { key: 'extraction_complete',    badge: { label: 'EXTRACTED',  tone: 'mint' as Tone }, render: renderExtractionComplete },
  extraction_failed:      { key: 'extraction_failed',      badge: { label: 'FAILED',     tone: 'red'  as Tone }, render: renderFailureWithRetry, retriable: true },
  resolution_complete:    { key: 'resolution_complete',    badge: { label: 'RESOLVED',   tone: 'mint' as Tone }, render: renderResolutionComplete },
  resolution_pairs_unchecked: { key: 'resolution_pairs_unchecked', badge: { label: 'UNCHECKED', tone: 'dim' as Tone }, render: renderResolutionPairsUnchecked },
  match_triage_failed:    { key: 'match_triage_failed',    badge: { label: 'UNCHECKED',  tone: 'dim'  as Tone }, render: renderMatchTriageFailed },
  match_triage_rechecked: { key: 'match_triage_rechecked', badge: { label: 'RECHECKED',  tone: 'neut' as Tone }, render: renderMatchTriageRechecked },
  aliases_suspended:      { key: 'aliases_suspended',      badge: { label: 'SET ASIDE',  tone: 'dim'  as Tone }, render: renderAliasesSuspended },
  draft_too_thin:         { key: 'draft_too_thin',         badge: { label: 'TOO THIN',   tone: 'dim'  as Tone }, render: renderDraftTooThin },
  draft_queued_for_approval: { key: 'draft_queued_for_approval', badge: { label: 'QUEUED', tone: 'dim' as Tone }, render: renderDraftQueuedForApproval },
  labels_merged:          { key: 'labels_merged',          badge: { label: 'MERGED',     tone: 'neut' as Tone }, render: renderLabelsMerged },
  compile_cancelled:      { key: 'compile_cancelled',      badge: { label: 'CANCELLED',  tone: 'dim'  as Tone }, render: renderCompileCancelled },
  compile_retried:        { key: 'compile_retried',        badge: { label: 'RETRYING',   tone: 'dim'  as Tone }, render: renderCompileRetried },
  // A save that left a page alone because it changed after its draft was written.
  compile_page_skipped:   { key: 'compile_page_skipped',   badge: { label: 'SKIPPED',    tone: 'dim'  as Tone }, render: renderPageAction('not saved: the page changed after this draft was written') },
  compile_trigger_failed: { key: 'compile_trigger_failed', badge: { label: 'FAILED',     tone: 'red'  as Tone }, render: renderFailureWithRetry, retriable: true },
  compile_failed:         { key: 'compile_failed',         badge: { label: 'FAILED',     tone: 'red'  as Tone }, render: renderFailureWithRetry, retriable: true },
  // ── Sources ─────────────────────────────────────────────────────────────
  source_archived:        { key: 'source_archived',        badge: { label: 'ARCHIVED',   tone: 'dim'  as Tone }, render: renderSourceStateChange(false) },
  source_unarchived:      { key: 'source_unarchived',      badge: { label: 'RESTORED',   tone: 'dim'  as Tone }, render: renderSourceStateChange(false) },
  source_deleted:         { key: 'source_deleted',         badge: { label: 'DELETED',    tone: 'red'  as Tone }, render: renderSourceStateChange(true) },
  source_recompile_triggered: { key: 'source_recompile_triggered', badge: { label: 'RETRYING', tone: 'dim' as Tone }, render: renderSourceRecompileTriggered },
  title_rescued:          { key: 'title_rescued',          badge: { label: 'RETITLED',   tone: 'mint' as Tone }, render: renderTitleRescued },
  // ── Pages ───────────────────────────────────────────────────────────────
  page_deleted:           { key: 'page_deleted',           badge: { label: 'PAGE DEL',   tone: 'red'  as Tone }, render: renderPageDeleted },
  page_archived:          { key: 'page_archived',          badge: { label: 'ARCHIVED',   tone: 'dim'  as Tone }, render: renderPageArchived },
  page_recompiled:        { key: 'page_recompiled',        badge: { label: 'RECOMPILED', tone: 'neut' as Tone }, render: renderPageRecompiled },
  page_recompile_failed:  { key: 'page_recompile_failed',  badge: { label: 'FAILED',     tone: 'red'  as Tone }, render: renderPageRecompileFailed },
  // page_redrafted: a page rebuilt from its sources (internal name kept for existing rows).
  page_redrafted:         { key: 'page_redrafted',         badge: { label: 'UPGRADED',   tone: 'neut' as Tone }, render: renderPageAction((str) => `updated to the ${str('draft_rules') ?? 'current'} writing rules`) },
  page_redraft_failed:    { key: 'page_redraft_failed',    badge: { label: 'FAILED',     tone: 'red'  as Tone }, render: renderPageRecompileFailed },
  page_version_restored:  { key: 'page_version_restored',  badge: { label: 'RESTORED',   tone: 'dim'  as Tone }, render: renderPageAction('previous version restored') },
  page_upgrade_run: {
    key: 'page_upgrade_run',
    badge: (row: FeedActivityRow) => {
      const { str } = makeGetters(row);
      const phase = str('phase');
      if (phase === 'finished') return { label: 'UPGRADED', tone: 'mint' as Tone };
      if (phase === 'stopped') return { label: 'STOPPED', tone: 'dim' as Tone };
      return { label: 'UPGRADING', tone: 'neut' as Tone };
    },
    render: renderPageUpgradeRun,
  },
  wiki_repair: {
    key: 'wiki_repair',
    badge: (row: FeedActivityRow) => {
      const { str } = makeGetters(row);
      const phase = str('phase');
      if (phase === 'finished') return { label: 'REPAIRED', tone: 'mint' as Tone };
      if (phase === 'stopped') return { label: 'STOPPED', tone: 'dim' as Tone };
      return { label: 'REPAIR', tone: 'neut' as Tone };
    },
    render: renderWikiRepair,
  },
  page_provenance_updated: { key: 'page_provenance_updated', badge: { label: 'NOTED',    tone: 'dim'  as Tone }, render: renderPageProvenanceUpdated },
  page_contradiction_detected: { key: 'page_contradiction_detected', badge: { label: 'CONFLICT', tone: 'red' as Tone }, render: renderPageContradictionDetected },
  page_dispute_recorded:  { key: 'page_dispute_recorded',  badge: { label: 'DISPUTE',    tone: 'red'  as Tone }, render: renderPageDisputeRecorded },
  claim_check_run: {
    key: 'claim_check_run',
    badge: (row: FeedActivityRow) => {
      const { num } = makeGetters(row);
      return (num('findings') ?? 0) > 0
        ? { label: 'DISAGREE', tone: 'red' as Tone }
        : { label: 'CHECKED', tone: 'dim' as Tone };
    },
    render: renderClaimCheckRun,
  },
  // ── Drafts ──────────────────────────────────────────────────────────────
  draft_approved:         { key: 'draft_approved',         badge: { label: 'APPROVED',   tone: 'mint' as Tone }, render: renderDraftApproved },
  draft_rejected:         { key: 'draft_rejected',         badge: { label: 'REJECTED',   tone: 'red'  as Tone }, render: renderDraftRejected },
  // ── Cleanup ─────────────────────────────────────────────────────────────
  pending_drafts_cleaned: { key: 'pending_drafts_cleaned', badge: { label: 'CLEANED',    tone: 'dim'  as Tone }, render: renderPendingDraftsCleaned },
  chat_drafts_cleaned:    { key: 'chat_drafts_cleaned',    badge: { label: 'CLEANED',    tone: 'dim'  as Tone }, render: renderChatDraftsCleaned },
  saved_link_dismissed:   { key: 'saved_link_dismissed',   badge: { label: 'DISMISSED',  tone: 'dim'  as Tone }, render: renderSavedLinkDismissed },
  // ── Wiki / system ───────────────────────────────────────────────────────
  wiki_imported:          { key: 'wiki_imported',          badge: { label: 'IMPORTED',   tone: 'mint' as Tone }, render: renderWikiImported },
  lint_complete:          { key: 'lint_complete',          badge: { label: 'LINT',       tone: 'neut' as Tone }, render: renderLintComplete },
  onboarding_confirmed:   { key: 'onboarding_confirmed',   badge: { label: 'ONBOARDING', tone: 'dim'  as Tone }, render: renderOnboardingConfirmed },
  // ── Onboarding v2 Phase 1 (no prior renderer cases) ─────────────────────
  onboarding_staged:      { key: 'onboarding_staged',      badge: { label: 'STAGED',     tone: 'dim'  as Tone }, render: renderOnboardingStaged },
  agent_sources_added:    { key: 'agent_sources_added',    badge: { label: 'AGENT',      tone: 'neut' as Tone }, render: renderAgentSourcesAdded },
  onboarding_blocked_urls_skipped: { key: 'onboarding_blocked_urls_skipped', badge: { label: 'SKIPPED', tone: 'dim' as Tone }, render: renderOnboardingBlockedUrlsSkipped },
  ingest_url_failed:      { key: 'ingest_url_failed',      badge: { label: 'URL FAIL',   tone: 'red'  as Tone }, render: renderIngestUrlFailed },
  ingest_file_failed:     { key: 'ingest_file_failed',     badge: { label: 'FILE FAIL',  tone: 'red'  as Tone }, render: renderIngestFileFailed },
  ingest_text_failed:     { key: 'ingest_text_failed',     badge: { label: 'TEXT FAIL',  tone: 'red'  as Tone }, render: renderIngestTextFailed },
  // ── n8n-written (POST /api/activity is the writer, no TS call site) ─────
  lint_failed:            { key: 'lint_failed',            badge: { label: 'FAILED',     tone: 'red'  as Tone }, render: renderDigestOrLintFailed('Wiki lint failed') },
  // ── Legacy / never-written by TS — kept for historical DB rows ──────────
  ingest_accepted:        { key: 'ingest_accepted',        badge: { label: 'QUEUED',     tone: 'dim'  as Tone }, render: renderSourceOnly },
  ingest_complete:        { key: 'ingest_complete',        badge: { label: 'INDEXED',    tone: 'dim'  as Tone }, render: renderSourceOnly },
  ingest_failed:          { key: 'ingest_failed',          badge: { label: 'FAILED',     tone: 'red'  as Tone }, render: renderFailureWithRetry, retriable: true },
  source_stored:          { key: 'source_stored',          badge: { label: 'INDEXED',    tone: 'dim'  as Tone }, render: renderSourceOnly },
  source_compiled:        { key: 'source_compiled',        badge: { label: 'COMPILED',   tone: 'neut' as Tone }, render: renderSourceOnly },
  // entity_expansion_failed was in the old case-list but NOT in RETRIABLE_TYPES
  // — it renders a View link in danger colour, not a retry button, and is
  // excluded from the "RETRIED" overlay in ActivityTable.
  entity_expansion_failed: { key: 'entity_expansion_failed', badge: { label: 'FAILED',   tone: 'red'  as Tone }, render: renderFailureNoRetry },
} as const satisfies Record<string, ActivityEventDef>;

export type ActivityEventType = keyof typeof ACTIVITY_EVENTS;

// ── Helpers ────────────────────────────────────────────────────────────────
export function isKnownEvent(t: string): t is ActivityEventType {
  return t in ACTIVITY_EVENTS;
}

export function getEventDef(t: string): ActivityEventDef | null {
  return isKnownEvent(t) ? ACTIVITY_EVENTS[t] : null;
}

export function resolveBadge(def: ActivityEventDef, row: FeedActivityRow): Badge {
  return typeof def.badge === 'function' ? def.badge(row) : def.badge;
}

// Shared discriminator for page_compiled — used by the feed renderer and
// activity counters. Takes a structural subset so server-side code (db.ts's
// internal row type) and client-side code (FeedActivityRow) both work
// without cast-lies.
//
// Verified against the writer at api/compile/commit/route.ts:273-281:
// only 'create' and 'update' values are written. 'provenance-only' plans
// take a different branch (no page_compiled log) so we never see them here.
export function readPageAction(
  row: { action_type: string; details: string | null }
): 'create' | 'update' | null {
  if (row.action_type !== 'page_compiled' || !row.details) return null;
  try {
    const d = JSON.parse(row.details) as { action?: string };
    if (d.action === 'update') return 'update';
    if (d.action === 'create') return 'create';
    // Legacy rows may omit action — default to 'create' to match historic behaviour.
    return 'create';
  } catch { return null; }
}
