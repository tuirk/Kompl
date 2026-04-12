/**
 * POST /api/digest/generate
 *
 * Generate and send the weekly wiki digest to Telegram.
 * Called by n8n cron every Sunday 00:00 UTC, or manually for testing.
 *
 * Resilience contract:
 *   - digest_enabled = false  → { sent: false, reason: 'disabled' }, no LLM call
 *   - missing credentials     → { sent: false, reason: 'no_credentials' }, no LLM call
 *   - NLP service down        → 502, no Telegram send attempted
 *   - Telegram API error      → { sent: false, reason: 'telegram_send_failed' }, no crash
 */

import { NextResponse } from 'next/server';
import { getDigestSettings, getActivitySince, insertActivity, getLastLintResult } from '../../../../lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

export async function POST() {
  // Step 1: Check enabled
  const settings = getDigestSettings();
  if (!settings.enabled) {
    return NextResponse.json({ sent: false, reason: 'disabled' });
  }

  // Step 2: Check credentials BEFORE any LLM work
  if (!settings.telegram_token || !settings.telegram_chat_id) {
    return NextResponse.json({ sent: false, reason: 'no_credentials' });
  }

  // Step 3: Gather data from past 7 days
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const activity = getActivitySince(since);

  const sourcesIngested = activity.filter((a) => a.action_type === 'source_compiled').length;
  const pagesCreated = activity.filter((a) => a.action_type === 'page_created').length;
  const pagesUpdated = activity.filter((a) => a.action_type === 'page_updated').length;
  const draftsCreated = activity.filter((a) => a.action_type === 'draft_created').length;
  const draftsApproved = activity.filter((a) => a.action_type === 'draft_approved').length;

  const newPageTitles = activity
    .filter((a) => a.action_type === 'page_created' && a.details)
    .map((a) => {
      try {
        return (JSON.parse(a.details!) as { title?: string }).title ?? null;
      } catch {
        return null;
      }
    })
    .filter((t): t is string => t !== null);

  const updatedPageTitles = activity
    .filter((a) => a.action_type === 'page_updated' && a.details)
    .map((a) => {
      try {
        return (JSON.parse(a.details!) as { title?: string }).title ?? null;
      } catch {
        return null;
      }
    })
    .filter((t): t is string => t !== null);

  // Step 3b: Read most recent lint result for health section (written by lint-pass Sat 22:00 UTC)
  const lintResult = getLastLintResult();
  let healthSection = '';
  if (lintResult) {
    const orphans = (lintResult.orphan_pages as number) ?? 0;
    const stale = (lintResult.stale_pages as number) ?? 0;
    const crossRefs = Array.isArray(lintResult.missing_cross_refs)
      ? (lintResult.missing_cross_refs as unknown[]).length
      : 0;
    const contradictions = (lintResult.contradiction_count as number) ?? 0;
    healthSection = [
      ``,
      `🔍 <b>Wiki Health:</b>`,
      `• ${orphans} orphaned page${orphans !== 1 ? 's' : ''}`,
      `• ${stale} stale page${stale !== 1 ? 's' : ''}`,
      `• ${crossRefs} missing cross-ref${crossRefs !== 1 ? 's' : ''}`,
      `• ${contradictions} contradiction${contradictions !== 1 ? 's' : ''} detected`,
    ].join('\n');
  }

  // Step 4: Generate summary via NLP service (Gemini)
  const summaryRes = await fetch(`${NLP_SERVICE_URL}/pipeline/digest-summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sources_ingested: sourcesIngested,
      pages_created: pagesCreated,
      pages_updated: pagesUpdated,
      new_page_titles: newPageTitles.slice(0, 20),
      updated_page_titles: updatedPageTitles.slice(0, 20),
      drafts_created: draftsCreated,
      drafts_approved: draftsApproved,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!summaryRes.ok) {
    return NextResponse.json(
      { sent: false, reason: 'summary_generation_failed' },
      { status: 502 },
    );
  }

  const { summary } = (await summaryRes.json()) as { summary: string };

  // Step 5: Build message and send to Telegram
  const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const weekEnd = new Date();
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const dateRange = `${fmt(weekStart)}–${weekEnd.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`;

  const message = [
    `📚 <b>Kompl Weekly Digest</b>`,
    dateRange,
    ``,
    `📊 <b>This week:</b>`,
    `• ${sourcesIngested} source${sourcesIngested !== 1 ? 's' : ''} ingested`,
    `• ${pagesCreated} page${pagesCreated !== 1 ? 's' : ''} created`,
    `• ${pagesUpdated} page${pagesUpdated !== 1 ? 's' : ''} updated`,
    `• ${draftsApproved} draft${draftsApproved !== 1 ? 's' : ''} approved`,
    ``,
    summary,
    healthSection,
  ].join('\n');

  const telegramRes = await fetch(
    `https://api.telegram.org/bot${settings.telegram_token}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: settings.telegram_chat_id,
        text: message,
        parse_mode: 'HTML',
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!telegramRes.ok) {
    const err = await telegramRes.text().catch(() => 'unknown');
    return NextResponse.json(
      { sent: false, reason: 'telegram_send_failed', error: err },
      { status: 502 },
    );
  }

  insertActivity({
    action_type: 'digest_sent',
    source_id: null,
    details: {
      channel: 'telegram',
      sources_ingested: sourcesIngested,
      pages_created: pagesCreated,
    },
  });

  return NextResponse.json({ sent: true, channel: 'telegram' });
}
