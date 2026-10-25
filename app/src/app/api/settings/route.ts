/**
 * GET  /api/settings — return current settings
 * POST /api/settings — update settings
 *
 * Exposes: auto_approve (boolean),
 *          lint_enabled (boolean), lint_last_result (details from last lint_complete | null)
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
  };
}

export async function GET() {
  return NextResponse.json(buildResponse());
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
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
  };

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
  ];
  if (!knownFields.some((f) => f in body)) {
    return NextResponse.json({ error: 'no recognized setting field in request body' }, { status: 422 });
  }

  if (body.agent_add_sources_enabled !== undefined) {
    // Turning this on lets agents start paid compiles: never from another site.
    if (isCrossSiteRequest(request)) {
      return NextResponse.json({ error: 'cross_site', message: CROSS_SITE_MESSAGE }, { status: 403 });
    }
    if (typeof body.agent_add_sources_enabled !== 'boolean') {
      return NextResponse.json({ error: 'agent_add_sources_enabled must be a boolean' }, { status: 422 });
    }
    setAgentAddSourcesEnabled(body.agent_add_sources_enabled);
  }
  if (body.auto_approve !== undefined) {
    if (typeof body.auto_approve !== 'boolean') {
      return NextResponse.json({ error: 'auto_approve must be a boolean' }, { status: 422 });
    }
    setAutoApprove(body.auto_approve);
  }

  if (body.related_pages_min_sources !== undefined) {
    if (!Number.isInteger(body.related_pages_min_sources) || body.related_pages_min_sources < 0) {
      return NextResponse.json(
        { error: 'related_pages_min_sources must be a non-negative integer' },
        { status: 422 },
      );
    }
    setRelatedPagesMinSources(body.related_pages_min_sources);
  }

  if (body.stale_threshold_days !== undefined) {
    if (!Number.isInteger(body.stale_threshold_days) || body.stale_threshold_days < 0) {
      return NextResponse.json(
        { error: 'stale_threshold_days must be a non-negative integer' },
        { status: 422 },
      );
    }
    setStaleThresholdDays(body.stale_threshold_days);
  }

  if (body.lint_enabled !== undefined) {
    if (typeof body.lint_enabled !== 'boolean') {
      return NextResponse.json({ error: 'lint_enabled must be a boolean' }, { status: 422 });
    }
    setLintEnabled(body.lint_enabled);
  }

  if (body.min_source_chars !== undefined) {
    if (!Number.isInteger(body.min_source_chars) || body.min_source_chars < 0) {
      return NextResponse.json(
        { error: 'min_source_chars must be a non-negative integer' },
        { status: 422 },
      );
    }
    setMinSourceChars(body.min_source_chars);
  }

  if (body.min_draft_chars !== undefined) {
    if (!Number.isInteger(body.min_draft_chars) || body.min_draft_chars < 0) {
      return NextResponse.json(
        { error: 'min_draft_chars must be a non-negative integer' },
        { status: 422 },
      );
    }
    setMinDraftChars(body.min_draft_chars);
  }

  if (body.entity_promotion_threshold !== undefined) {
    if (!Number.isInteger(body.entity_promotion_threshold) || body.entity_promotion_threshold < 1) {
      return NextResponse.json(
        { error: 'entity_promotion_threshold must be an integer ≥ 1' },
        { status: 422 },
      );
    }
    setEntityPromotionThreshold(body.entity_promotion_threshold);
  }

  if (body.dossier_max_sources !== undefined) {
    if (!Number.isInteger(body.dossier_max_sources) || body.dossier_max_sources < 1) {
      return NextResponse.json(
        { error: 'dossier_max_sources must be an integer ≥ 1' },
        { status: 422 },
      );
    }
    setDossierMaxSources(body.dossier_max_sources);
  }

  if (body.dossier_min_score !== undefined) {
    if (typeof body.dossier_min_score !== 'number' || !Number.isFinite(body.dossier_min_score) || body.dossier_min_score < 0) {
      return NextResponse.json(
        { error: 'dossier_min_score must be a non-negative number (0 = include anything with any overlap)' },
        { status: 422 },
      );
    }
    setDossierMinScore(body.dossier_min_score);
  }

  if (body.daily_cap_usd !== undefined) {
    if (typeof body.daily_cap_usd !== 'number' || !Number.isFinite(body.daily_cap_usd) || body.daily_cap_usd < 0) {
      return NextResponse.json(
        { error: 'daily_cap_usd must be a non-negative number (0 = unlimited)' },
        { status: 422 },
      );
    }
    setDailyCapUsd(body.daily_cap_usd);
  }

  if (body.compile_model !== undefined) {
    if (!isLlmModel(body.compile_model)) {
      return NextResponse.json(
        { error: `compile_model must be one of: ${LLM_MODELS.join(', ')}` },
        { status: 422 },
      );
    }
    setCompileModel(body.compile_model);
  }

  return NextResponse.json(buildResponse());
}
