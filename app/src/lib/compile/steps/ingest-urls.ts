/**
 * Pipeline prelude step: ingest URL-staging rows into `sources`.
 *
 * For each staging row with connector='url', this step calls
 * nlp-service /convert/url (Firecrawl under the hood), dedups against the
 * existing sources table (cross-session), writes raw markdown to disk,
 * inserts a sources row with compile_status='pending' so the downstream
 * extract step picks it up, and links the staging row's resolved_source_id.
 *
 * Per-item failure model: a failed URL writes to ingest_failures (scoped
 * by session_id so retry-failed can target it), flips the staging row to
 * status='failed', and continues. One bad URL doesn't kill the other 199.
 *
 * Shape mirrors the existing try/catch flow in the legacy collect route —
 * behaviour-equivalent apart from the compile_status value.
 */

import { randomUUID } from 'node:crypto';

import {
  findSourceByContentHash,
  findSourceByUrl,
  insertActivity,
  insertIngestFailure,
  insertSource,
  markStagingFailed,
  markStagingIngested,
  storeRawMarkdown,
  type StagingRow,
} from '../../db';
import {
  callConvertUrl,
  isYouTubeUrl,
  peekMetadata,
} from '../../nlp-convert';
import { regenerateSavedLinksPage } from '../../saved-links';
import { runPerItemStep } from '../step-runner';

const INGEST_URLS_CONCURRENCY = 5;

/**
 * Payload shape the /stage endpoint writes for connector='url' rows.
 * title_hint + metadata_hint are optional — the URL is the only required
 * field. display is purely for the pre-ingestion review UI.
 */
interface UrlPayload {
  url: string;
  title_hint?: string;
  metadata_hint?: { date_saved?: unknown } & Record<string, unknown>;
  display?: Record<string, unknown>;
}

function readUrlPayload(row: StagingRow): UrlPayload | null {
  const p = row.payload as Partial<UrlPayload>;
  if (typeof p.url !== 'string' || !p.url) return null;
  return {
    url: p.url,
    title_hint: typeof p.title_hint === 'string' ? p.title_hint : undefined,
    metadata_hint:
      p.metadata_hint && typeof p.metadata_hint === 'object'
        ? (p.metadata_hint as UrlPayload['metadata_hint'])
        : undefined,
  };
}

export async function runIngestUrlsStep(
  sessionId: string,
  items: StagingRow[],
  assertNotCancelled: (sessionId: string) => void
): Promise<void> {
  let duplicatesThisBatch = 0;

  await runPerItemStep<StagingRow>({
    sessionId,
    stepKey: 'ingest_urls',
    items,
    concurrency: INGEST_URLS_CONCURRENCY,
    assertNotCancelled,
    progressMessage: (done, failed, total) => {
      let msg = `${done}/${total} fetched`;
      if (failed > 0) msg += `, ${failed} failed`;
      if (duplicatesThisBatch > 0) {
        msg += `, ${duplicatesThisBatch} duplicates skipped`;
      }
      return msg;
    },
    run: async (row) => {
      const payload = readUrlPayload(row);
      if (!payload) {
        throw new Error('ingest_urls: invalid payload (missing url)');
      }

      // Cross-session dedup: skip scrape entirely if we already have this URL.
      const urlDupe = findSourceByUrl(payload.url);
      if (urlDupe) {
        markStagingIngested(row.stage_id, urlDupe.source_id);
        duplicatesThisBatch++;
        return;
      }

      const sourceId = randomUUID();
      const result = await callConvertUrl(sourceId, payload.url);
      if (!result.ok) {
        // Preserve the error_code prefix so the UI can route through
        // toUserMessage() the same way the legacy collect route does.
        throw new Error(`${result.code}: ${result.detail}`);
      }
      const convertResult = result.data;

      // Content-hash dedup catches post-scrape collisions (same content via
      // a different URL). Cheaper than a second fetch so we tolerate the
      // wasted scrape for the one URL that slipped through.
      const hashDupe = findSourceByContentHash(convertResult.content_hash);
      if (hashDupe) {
        markStagingIngested(row.stage_id, hashDupe.source_id);
        duplicatesThisBatch++;
        return;
      }

      // Merge the user-supplied bookmark metadata (e.g. date_saved from
      // Chrome bookmark exports) into the NLP-derived metadata.
      const finalMetadata: Record<string, unknown> = payload.metadata_hint
        ? { ...(convertResult.metadata ?? {}), ...payload.metadata_hint }
        : convertResult.metadata;

      const filePath = storeRawMarkdown(sourceId, convertResult.markdown);
      insertSource({
        source_id: sourceId,
        title: convertResult.title,
        source_type: convertResult.source_type,
        source_url: convertResult.source_url,
        content_hash: convertResult.content_hash,
        file_path: filePath,
        metadata: finalMetadata,
        compile_status: 'pending',
        onboarding_session_id: sessionId,
      });

      // YouTube warning (soft — not a failure). MarkItDown tries
      // youtube-transcript-api first; Firecrawl is the fallback and when
      // that fires the page body is usually the watch-page HTML not a
      // transcript. Surface as an activity row — UI can badge it.
      if (isYouTubeUrl(payload.url)) {
        insertActivity({
          action_type: 'ingest_url_warning',
          source_id: sourceId,
          details: { warning: 'youtube_no_transcript', url: payload.url },
        });
      }

      markStagingIngested(row.stage_id, sourceId);
    },
    onFailure: async (row, error) => {
      const payload = readUrlPayload(row);
      const msg = error.message;

      // Extract structured error code for the UI (same convention as
      // collect route). onFailure is called from step-runner AFTER run
      // throws; msg shape is '<code>: <detail>' when thrown from
      // callConvertUrl, otherwise a bare message.
      const codeMatch = msg.match(/^(nlp_unreachable|nlp_convert_failed):/);
      const error_code = codeMatch ? codeMatch[1] : 'ingest_url_failed';

      markStagingFailed(row.stage_id, error_code, msg);

      if (payload) {
        // Best-effort og-peek to preserve a usable title for the Saved
        // Links wiki page (same rationale as collect route).
        const peeked = await peekMetadata(payload.url);
        const dateSaved =
          typeof payload.metadata_hint?.date_saved === 'string'
            ? payload.metadata_hint.date_saved
            : null;
        const resolvedTitle = payload.title_hint ?? peeked.title ?? null;
        const peekJson =
          peeked.title || peeked.description || peeked.og_image
            ? JSON.stringify(peeked)
            : null;

        insertIngestFailure({
          failure_id: randomUUID(),
          source_url: payload.url,
          title_hint: resolvedTitle,
          date_saved: dateSaved,
          error: msg,
          source_type: 'url',
          metadata: peekJson,
          session_id: sessionId,
        });
        void regenerateSavedLinksPage().catch(() => {});
      }

      insertActivity({
        action_type: 'ingest_url_failed',
        source_id: null,
        details: {
          stage_id: row.stage_id,
          session_id: sessionId,
          url: payload?.url ?? null,
          error_code,
          error: msg,
        },
      });
    },
  });
}
