/**
 * GET  /api/settings — return current settings
 * POST /api/settings — update settings
 *
 * Exposes: auto_approve (boolean), digest_enabled (boolean),
 *          digest_telegram_token (masked on GET),
 *          digest_telegram_chat_id (string | null),
 *          lint_enabled (boolean), lint_last_result (details from last lint_complete | null)
 */

import { NextResponse } from 'next/server';
import {
  getAutoApprove, setAutoApprove,
  getRelatedPagesMinSources, setRelatedPagesMinSources,
  getDigestSettings, setDigestSettings,
  getLintEnabled, setLintEnabled, getLastLintResult,
  getStaleThresholdDays, setStaleThresholdDays,
  getDeploymentMode, setDeploymentMode,
  getLastLintAt, getLastBackupAt,
  getMinSourceChars, setMinSourceChars,
  getMinDraftChars, setMinDraftChars,
  getEntityPromotionThreshold, setEntityPromotionThreshold,
  getDailyCapUsd, setDailyCapUsd,
  getChatModel, setChatModel, isChatModel,
  getCompileModel, setCompileModel,
} from '../../../lib/db';

function buildResponse() {
  const digest = getDigestSettings();
  return {
    auto_approve: getAutoApprove(),
    related_pages_min_sources: getRelatedPagesMinSources(),
    stale_threshold_days: getStaleThresholdDays(),
    digest_enabled: digest.enabled,
    digest_telegram_token: digest.telegram_token ? '••••••••' : null,
    digest_telegram_chat_id: digest.telegram_chat_id,
    lint_enabled: getLintEnabled(),
    lint_last_result: getLastLintResult(),
    deployment_mode: getDeploymentMode(),
    last_lint_at: getLastLintAt(),
    last_backup_at: getLastBackupAt(),
    min_source_chars: getMinSourceChars(),
    min_draft_chars: getMinDraftChars(),
    entity_promotion_threshold: getEntityPromotionThreshold(),
    daily_cap_usd: getDailyCapUsd(),
    chat_model: getChatModel(),
    compile_model: getCompileModel(),
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
    digest_enabled?: boolean;
    digest_telegram_token?: string;
    digest_telegram_chat_id?: string;
    lint_enabled?: boolean;
    deployment_mode?: 'personal-device' | 'always-on';
    min_source_chars?: number;
    min_draft_chars?: number;
    entity_promotion_threshold?: number;
    daily_cap_usd?: number;
    chat_model?: string;
    compile_model?: string;
  };

  const knownFields = [
    'auto_approve', 'related_pages_min_sources',
    'stale_threshold_days',
    'digest_enabled', 'digest_telegram_token', 'digest_telegram_chat_id',
    'lint_enabled', 'deployment_mode',
    'min_source_chars', 'min_draft_chars',
    'entity_promotion_threshold',
    'daily_cap_usd',
    'chat_model',
    'compile_model',
  ];
  if (!knownFields.some((f) => f in body)) {
    return NextResponse.json({ error: 'no recognized setting field in request body' }, { status: 422 });
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

  if (body.digest_enabled !== undefined) {
    if (typeof body.digest_enabled !== 'boolean') {
      return NextResponse.json({ error: 'digest_enabled must be a boolean' }, { status: 422 });
    }
    setDigestSettings({ enabled: body.digest_enabled });
  }

  if (body.digest_telegram_token !== undefined) {
    if (typeof body.digest_telegram_token !== 'string') {
      return NextResponse.json({ error: 'digest_telegram_token must be a string' }, { status: 422 });
    }
    setDigestSettings({ telegram_token: body.digest_telegram_token });
  }

  if (body.digest_telegram_chat_id !== undefined) {
    if (typeof body.digest_telegram_chat_id !== 'string') {
      return NextResponse.json({ error: 'digest_telegram_chat_id must be a string' }, { status: 422 });
    }
    setDigestSettings({ telegram_chat_id: body.digest_telegram_chat_id });
  }

  if (body.lint_enabled !== undefined) {
    if (typeof body.lint_enabled !== 'boolean') {
      return NextResponse.json({ error: 'lint_enabled must be a boolean' }, { status: 422 });
    }
    setLintEnabled(body.lint_enabled);
  }

  if (body.deployment_mode !== undefined) {
    if (body.deployment_mode !== 'personal-device' && body.deployment_mode !== 'always-on') {
      return NextResponse.json(
        { error: "deployment_mode must be 'personal-device' or 'always-on'" },
        { status: 422 },
      );
    }
    setDeploymentMode(body.deployment_mode);
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

  if (body.daily_cap_usd !== undefined) {
    if (typeof body.daily_cap_usd !== 'number' || !Number.isFinite(body.daily_cap_usd) || body.daily_cap_usd < 0) {
      return NextResponse.json(
        { error: 'daily_cap_usd must be a non-negative number (0 = unlimited)' },
        { status: 422 },
      );
    }
    setDailyCapUsd(body.daily_cap_usd);
  }

  if (body.chat_model !== undefined) {
    if (!isChatModel(body.chat_model)) {
      return NextResponse.json(
        { error: 'chat_model must be one of: gemini-2.5-flash-lite, gemini-2.5-flash, gemini-2.5-pro' },
        { status: 422 },
      );
    }
    setChatModel(body.chat_model);
  }

  if (body.compile_model !== undefined) {
    if (!isChatModel(body.compile_model)) {
      return NextResponse.json(
        { error: 'compile_model must be one of: gemini-2.5-flash-lite, gemini-2.5-flash, gemini-2.5-pro' },
        { status: 422 },
      );
    }
    setCompileModel(body.compile_model);
  }

  return NextResponse.json(buildResponse());
}
