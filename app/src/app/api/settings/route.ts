/**
 * GET  /api/settings — return current settings
 * POST /api/settings — update settings
 *
 * Exposes: auto_approve (boolean),
 *          lint_enabled (boolean), lint_last_result (details from last lint_complete | null),
 *          triage_recheck_enabled (boolean; lib/triage-rechecks.ts),
 *          claim_check_enabled (boolean; lib/claim-check/flag.ts)
 */

import { NextResponse } from 'next/server';
import { CROSS_SITE_MESSAGE, isCrossSiteRequest } from '@/lib/same-origin';
import {
  getAutoApprove, setAutoApprove,
  getRelatedPagesMinSources, setRelatedPagesMinSources,
  getLintEnabled, setLintEnabled, getLastLintResult,
  getStaleThresholdDays, setStaleThresholdDays,
  getLastLintAt, getLastBackupAt,
  getMinSourceChars, setMinSourceChars,
  getMinDraftChars, setMinDraftChars,
  getEntityPromotionThreshold, setEntityPromotionThreshold,
  getDossierMaxSources, setDossierMaxSources,
  getDossierMinScore, setDossierMinScore,
  getDailyCapUsd, setDailyCapUsd,
  getCompileModel, setCompileModel, isLlmModel, LLM_MODELS,
  getAgentAddSourcesEnabled, setAgentAddSourcesEnabled,
} from '../../../lib/db';
import { getClaimCheckEnabled, setClaimCheckEnabled } from '../../../lib/claim-check/flag';
import { getTriageRecheckEnabled, setTriageRecheckEnabled } from '../../../lib/triage-rechecks';

function buildResponse() {
  return {
    auto_approve: getAutoApprove(),
    related_pages_min_sources: getRelatedPagesMinSources(),
    stale_threshold_days: getStaleThresholdDays(),
    lint_enabled: getLintEnabled(),
    lint_last_result: getLastLintResult(),
    last_lint_at: getLastLintAt(),
    last_backup_at: getLastBackupAt(),
    min_source_chars: getMinSourceChars(),
    min_draft_chars: getMinDraftChars(),
    entity_promotion_threshold: getEntityPromotionThreshold(),
    dossier_max_sources: getDossierMaxSources(),
    dossier_min_score: getDossierMinScore(),
    daily_cap_usd: getDailyCapUsd(),
    compile_model: getCompileModel(),
    agent_add_sources_enabled: getAgentAddSourcesEnabled(),
    triage_recheck_enabled: getTriageRecheckEnabled(),
    claim_check_enabled: getClaimCheckEnabled(),
  };
}

export async function GET() {
  return NextResponse.json(buildResponse());
}

type SettingsBody = {
  auto_approve?: boolean;
  related_pages_min_sources?: number;
  stale_threshold_days?: number;
  lint_enabled?: boolean;
  min_source_chars?: number;
  min_draft_chars?: number;
  entity_promotion_threshold?: number;
  dossier_max_sources?: number;
  dossier_min_score?: number;
  daily_cap_usd?: number;
  compile_model?: string;
  agent_add_sources_enabled?: boolean;
  triage_recheck_enabled?: boolean;
  claim_check_enabled?: boolean;
};

const isBoolean = (v: unknown) => typeof v === 'boolean';
const isNonNegativeInteger = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
const isPositiveInteger = (v: unknown) => Number.isInteger(v) && (v as number) >= 1;
const isNonNegativeNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** The 422 message for the first field with a bad value, or null when all are fine. */
function invalidField(body: SettingsBody): string | null {
  const checks: Array<[unknown, (v: unknown) => boolean, string]> = [
    [body.agent_add_sources_enabled, isBoolean, 'agent_add_sources_enabled must be a boolean'],
    [body.triage_recheck_enabled, isBoolean, 'triage_recheck_enabled must be a boolean'],
    [body.claim_check_enabled, isBoolean, 'claim_check_enabled must be a boolean'],
    [body.auto_approve, isBoolean, 'auto_approve must be a boolean'],
    [body.related_pages_min_sources, isNonNegativeInteger, 'related_pages_min_sources must be a non-negative integer'],
    [body.stale_threshold_days, isNonNegativeInteger, 'stale_threshold_days must be a non-negative integer'],
    [body.lint_enabled, isBoolean, 'lint_enabled must be a boolean'],
    [body.min_source_chars, isNonNegativeInteger, 'min_source_chars must be a non-negative integer'],
    [body.min_draft_chars, isNonNegativeInteger, 'min_draft_chars must be a non-negative integer'],
    [body.entity_promotion_threshold, isPositiveInteger, 'entity_promotion_threshold must be an integer ≥ 1'],
    [body.dossier_max_sources, isPositiveInteger, 'dossier_max_sources must be an integer ≥ 1'],
    [
      body.dossier_min_score,
      isNonNegativeNumber,
      'dossier_min_score must be a non-negative number (0 = include anything with any overlap)',
    ],
    [body.daily_cap_usd, isNonNegativeNumber, 'daily_cap_usd must be a non-negative number (0 = unlimited)'],
    [body.compile_model, isLlmModel, `compile_model must be one of: ${LLM_MODELS.join(', ')}`],
  ];
  for (const [value, ok, message] of checks) {
    if (value !== undefined && !ok(value)) return message;
  }
  return null;
}

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return NextResponse.json({ error: 'body must be a JSON object' }, { status: 400 });
  }
  const body = raw as SettingsBody;

  const knownFields = [
    'auto_approve', 'related_pages_min_sources',
    'stale_threshold_days',
    'lint_enabled',
    'min_source_chars', 'min_draft_chars',
    'entity_promotion_threshold',
    'dossier_max_sources', 'dossier_min_score',
    'daily_cap_usd',
    'compile_model',
    'agent_add_sources_enabled',
    'triage_recheck_enabled',
    'claim_check_enabled',
  ];
  if (!knownFields.some((f) => f in body)) {
    return NextResponse.json({ error: 'no recognized setting field in request body' }, { status: 422 });
  }

  // Letting agents start paid compiles, triage re-checks and the claim check
  // all spend AI calls: never switched from another site.
  if (
    (body.agent_add_sources_enabled !== undefined ||
      body.triage_recheck_enabled !== undefined ||
      body.claim_check_enabled !== undefined) &&
    isCrossSiteRequest(request)
  ) {
    return NextResponse.json({ error: 'cross_site', message: CROSS_SITE_MESSAGE }, { status: 403 });
  }

  // Check every field before saving any, so a request with one bad field
  // changes nothing.
  const invalid = invalidField(body);
  if (invalid) {
    return NextResponse.json({ error: invalid }, { status: 422 });
  }

  if (body.agent_add_sources_enabled !== undefined) setAgentAddSourcesEnabled(body.agent_add_sources_enabled);
  if (body.triage_recheck_enabled !== undefined) setTriageRecheckEnabled(body.triage_recheck_enabled);
  if (body.claim_check_enabled !== undefined) setClaimCheckEnabled(body.claim_check_enabled);
  if (body.auto_approve !== undefined) setAutoApprove(body.auto_approve);
  if (body.related_pages_min_sources !== undefined) setRelatedPagesMinSources(body.related_pages_min_sources);
  if (body.stale_threshold_days !== undefined) setStaleThresholdDays(body.stale_threshold_days);
  if (body.lint_enabled !== undefined) setLintEnabled(body.lint_enabled);
  if (body.min_source_chars !== undefined) setMinSourceChars(body.min_source_chars);
  if (body.min_draft_chars !== undefined) setMinDraftChars(body.min_draft_chars);
  if (body.entity_promotion_threshold !== undefined) setEntityPromotionThreshold(body.entity_promotion_threshold);
  if (body.dossier_max_sources !== undefined) setDossierMaxSources(body.dossier_max_sources);
  if (body.dossier_min_score !== undefined) setDossierMinScore(body.dossier_min_score);
  if (body.daily_cap_usd !== undefined) setDailyCapUsd(body.daily_cap_usd);
  if (body.compile_model !== undefined) setCompileModel(body.compile_model);

  return NextResponse.json(buildResponse());
}
