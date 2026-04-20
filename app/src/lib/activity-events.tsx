import type { ReactNode } from 'react';
import Link from 'next/link';
import { RetryButton } from '@/components/RetryButton';

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

function renderPageRecompileFailed(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const detailTitle = str('title');
  const page_id = str('page_id');
  const pageName = detailTitle ?? page_id ?? '…';
  const primary = page_id
    ? <Link href={`/wiki/${page_id}`} style={LINK_STYLE}><strong>{pageName}</strong></Link>
    : <strong>{pageName}</strong>;
  const errMsg = str('error');
  const secondary = errMsg ? <span style={MONO_ERR}>{errMsg}</span> : null;
  const action = page_id
    ? <Link href={`/wiki/${page_id}`} style={{ ...LINK_STYLE, color: 'var(--danger)' }}>View</Link>
    : null;
  return { primary, secondary, action, isError: true };
}

function renderLintComplete(row: FeedActivityRow): RowContent {
  const { d } = makeGetters(row);
  const orphans = d && typeof d['orphan_pages'] === 'number' ? (d['orphan_pages'] as number) : null;
  const stale = d && typeof d['stale_pages'] === 'number' ? (d['stale_pages'] as number) : null;
  const crossRefs = d && Array.isArray(d['missing_cross_refs']) ? (d['missing_cross_refs'] as unknown[]).length : null;
  const contradictions = d && typeof d['contradiction_count'] === 'number' ? (d['contradiction_count'] as number) : null;
  const hasCounts = orphans !== null || stale !== null || crossRefs !== null;
  const secondary = hasCounts
    ? (
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-dim)' }}>
        {[
          orphans !== null && `${orphans} orphan${orphans !== 1 ? 's' : ''}`,
          stale !== null && `${stale} stale`,
          crossRefs !== null && `${crossRefs} cross-ref${crossRefs !== 1 ? 's' : ''}`,
          contradictions !== null && `${contradictions} contradiction${contradictions !== 1 ? 's' : ''}`,
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
  const parts = [
    sources !== null && `${sources} source${sources !== 1 ? 's' : ''}`,
    pages !== null && `${pages} page${pages !== 1 ? 's' : ''}`,
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

function renderDigestSent(row: FeedActivityRow): RowContent {
  const { str, num } = makeGetters(row);
  const channel = str('channel');
  const sources = num('sources_ingested');
  const pages = num('pages_created');
  const parts = [
    channel,
    sources !== null && `${sources} source${sources !== 1 ? 's' : ''}`,
    pages !== null && `${pages} page${pages !== 1 ? 's' : ''}`,
  ].filter(Boolean);
  const secondary = parts.length > 0
    ? <span style={MONO_DIM}>{parts.join(' · ')}</span>
    : null;
  return { primary: <>Weekly digest sent</>, secondary, action: null, isError: false };
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

function renderIngestUrlWarning(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const warning = str('warning');
  const url = str('url');
  const primary = warning === 'youtube_no_transcript'
    ? <>YouTube transcript unavailable</>
    : <>{warning ?? 'Ingest warning'}</>;
  const secondary = url ? <span style={MONO_DIM}>{url}</span> : null;
  return { primary, secondary, action: null, isError: false };
}

function renderIngestUrlFailed(row: FeedActivityRow): RowContent {
  const { str } = makeGetters(row);
  const url = str('url');
  const error_code = str('error_code');
  const name = url ?? '(unknown URL)';
  const secondary = error_code ? <span style={MONO_ERR}>{error_code}</span> : null;
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
  draft_too_thin:         { key: 'draft_too_thin',         badge: { label: 'TOO THIN',   tone: 'dim'  as Tone }, render: renderDraftTooThin },
  draft_queued_for_approval: { key: 'draft_queued_for_approval', badge: { label: 'QUEUED', tone: 'dim' as Tone }, render: renderDraftQueuedForApproval },
  compile_cancelled:      { key: 'compile_cancelled',      badge: { label: 'CANCELLED',  tone: 'dim'  as Tone }, render: renderCompileCancelled },
  compile_trigger_failed: { key: 'compile_trigger_failed', badge: { label: 'FAILED',     tone: 'red'  as Tone }, render: renderFailureWithRetry, retriable: true },
  compile_failed:         { key: 'compile_failed',         badge: { label: 'FAILED',     tone: 'red'  as Tone }, render: renderFailureWithRetry, retriable: true },
  // ── Sources ─────────────────────────────────────────────────────────────
  source_archived:        { key: 'source_archived',        badge: { label: 'ARCHIVED',   tone: 'dim'  as Tone }, render: renderSourceStateChange(false) },
  source_unarchived:      { key: 'source_unarchived',      badge: { label: 'RESTORED',   tone: 'dim'  as Tone }, render: renderSourceStateChange(false) },
  source_deleted:         { key: 'source_deleted',         badge: { label: 'DELETED',    tone: 'red'  as Tone }, render: renderSourceStateChange(true) },
  source_recompile_triggered: { key: 'source_recompile_triggered', badge: { label: 'RETRYING', tone: 'dim' as Tone }, render: renderSourceRecompileTriggered },
  // ── Pages ───────────────────────────────────────────────────────────────
  page_deleted:           { key: 'page_deleted',           badge: { label: 'PAGE DEL',   tone: 'red'  as Tone }, render: renderPageDeleted },
  page_archived:          { key: 'page_archived',          badge: { label: 'ARCHIVED',   tone: 'dim'  as Tone }, render: renderPageArchived },
  page_recompiled:        { key: 'page_recompiled',        badge: { label: 'RECOMPILED', tone: 'neut' as Tone }, render: renderPageRecompiled },
  page_recompile_failed:  { key: 'page_recompile_failed',  badge: { label: 'FAILED',     tone: 'red'  as Tone }, render: renderPageRecompileFailed },
  page_provenance_updated: { key: 'page_provenance_updated', badge: { label: 'NOTED',    tone: 'dim'  as Tone }, render: renderPageProvenanceUpdated },
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
  digest_sent:            { key: 'digest_sent',            badge: { label: 'DIGEST',     tone: 'neut' as Tone }, render: renderDigestSent },
  // ── Onboarding v2 Phase 1 (no prior renderer cases) ─────────────────────
  onboarding_staged:      { key: 'onboarding_staged',      badge: { label: 'STAGED',     tone: 'dim'  as Tone }, render: renderOnboardingStaged },
  ingest_url_warning:     { key: 'ingest_url_warning',     badge: { label: 'WARN',       tone: 'dim'  as Tone }, render: renderIngestUrlWarning },
  ingest_url_failed:      { key: 'ingest_url_failed',      badge: { label: 'URL FAIL',   tone: 'red'  as Tone }, render: renderIngestUrlFailed },
  ingest_file_failed:     { key: 'ingest_file_failed',     badge: { label: 'FILE FAIL',  tone: 'red'  as Tone }, render: renderIngestFileFailed },
  ingest_text_failed:     { key: 'ingest_text_failed',     badge: { label: 'TEXT FAIL',  tone: 'red'  as Tone }, render: renderIngestTextFailed },
  // ── n8n-written (POST /api/activity is the writer, no TS call site) ─────
  lint_failed:            { key: 'lint_failed',            badge: { label: 'FAILED',     tone: 'red'  as Tone }, render: renderDigestOrLintFailed('Wiki lint failed') },
  digest_failed:          { key: 'digest_failed',          badge: { label: 'FAILED',     tone: 'red'  as Tone }, render: renderDigestOrLintFailed('Weekly digest failed') },
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

// Shared discriminator for page_compiled — used by the feed renderer AND the
// digest counters. Takes a structural subset so server-side code (db.ts's
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
