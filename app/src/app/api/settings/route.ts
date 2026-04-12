/**
 * GET  /api/settings — return current settings
 * POST /api/settings — update settings
 *
 * Exposes: auto_approve (boolean), chat_provider ('gemini' | 'ollama'),
 *          digest_enabled (boolean), digest_telegram_token (masked on GET),
 *          digest_telegram_chat_id (string | null),
 *          lint_enabled (boolean), lint_last_result (details from last lint_complete | null)
 */

import { NextResponse } from 'next/server';
import {
  getAutoApprove, setAutoApprove,
  getChatProvider, setChatProvider,
  getRelatedPagesMinSources, setRelatedPagesMinSources,
  getDigestSettings, setDigestSettings,
  getLintEnabled, setLintEnabled, getLastLintResult,
  getStaleThresholdDays, setStaleThresholdDays,
} from '../../../lib/db';

function buildResponse() {
  const digest = getDigestSettings();
  return {
    auto_approve: getAutoApprove(),
    chat_provider: getChatProvider(),
    related_pages_min_sources: getRelatedPagesMinSources(),
    stale_threshold_days: getStaleThresholdDays(),
    digest_enabled: digest.enabled,
    digest_telegram_token: digest.telegram_token ? '••••••••' : null,
    digest_telegram_chat_id: digest.telegram_chat_id,
    lint_enabled: getLintEnabled(),
    lint_last_result: getLastLintResult(),
  };
}

export async function GET() {
  return NextResponse.json(buildResponse());
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    auto_approve?: boolean;
    chat_provider?: string;
    related_pages_min_sources?: number;
    stale_threshold_days?: number;
    digest_enabled?: boolean;
    digest_telegram_token?: string;
    digest_telegram_chat_id?: string;
    lint_enabled?: boolean;
  };

  const knownFields = [
    'auto_approve', 'chat_provider', 'related_pages_min_sources',
    'stale_threshold_days',
    'digest_enabled', 'digest_telegram_token', 'digest_telegram_chat_id',
    'lint_enabled',
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

  if (body.chat_provider !== undefined) {
    if (body.chat_provider !== 'gemini' && body.chat_provider !== 'ollama') {
      return NextResponse.json(
        { error: "chat_provider must be 'gemini' or 'ollama'" },
        { status: 422 },
      );
    }
    setChatProvider(body.chat_provider);
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

  return NextResponse.json(buildResponse());
}
