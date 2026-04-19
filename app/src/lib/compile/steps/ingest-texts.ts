/**
 * Pipeline prelude step: ingest text + saved-link staging rows.
 *
 * Two connector types are handled here because they share the "no
 * external NLP call needed" property — conversion is a local hash
 * + insertSource (text) or a bare insertIngestFailure write (saved-link,
 * for media-only tweets whose only durable artefact is the URL itself).
 *
 * Text items (connector='text'):
 *   - Upnote notes and Twitter tweet text. Client already has the full
 *     markdown. We compute SHA-256, dedup against existing sources,
 *     storeRawMarkdown, insertSource with compile_status='pending'.
 *
 * Saved-link items (connector='saved-link'):
 *   - Media-only tweets whose caption text is empty so no `sources` row
 *     is created. The URL is captured in ingest_failures (source_type
 *     = 'tweet') so it still surfaces on the Saved Links wiki page.
 *     These are 'ingested' from the staging row's perspective even though
 *     no source is created — resolved_source_id stays null.
 */

import { createHash, randomUUID } from 'node:crypto';

import {
  findSourceByContentHash,
  insertActivity,
  insertIngestFailure,
  insertSource,
  markStagingFailed,
  markStagingIngested,
  storeRawMarkdown,
  type StagingRow,
} from '../../db';
import { regenerateSavedLinksPage } from '../../saved-links';
import { runPerItemStep } from '../step-runner';

// Sentinel returned to markStagingIngested when a saved-link row resolves
// without a sources entry — non-null so the staging row reads as ingested,
// but semantically "no source was created for this URL."
const SAVED_LINK_SENTINEL = 'saved-link';

interface TextPayload {
  markdown: string;
  title_hint?: string;
  source_type_hint?: string;
  metadata?: Record<string, unknown>;
}

interface SavedLinkPayload {
  url: string;
  title_hint?: string;
  metadata_hint?: Record<string, unknown>;
}

function readTextPayload(row: StagingRow): TextPayload | null {
  const p = row.payload as Partial<TextPayload>;
  if (typeof p.markdown !== 'string' || !p.markdown) return null;
  return {
    markdown: p.markdown,
    title_hint: typeof p.title_hint === 'string' ? p.title_hint : undefined,
    source_type_hint:
      typeof p.source_type_hint === 'string' ? p.source_type_hint : undefined,
    metadata:
      p.metadata && typeof p.metadata === 'object'
        ? (p.metadata as Record<string, unknown>)
        : undefined,
  };
}

function readSavedLinkPayload(row: StagingRow): SavedLinkPayload | null {
  const p = row.payload as Partial<SavedLinkPayload>;
  if (typeof p.url !== 'string' || !p.url) return null;
  return {
    url: p.url,
    title_hint: typeof p.title_hint === 'string' ? p.title_hint : undefined,
    metadata_hint:
      p.metadata_hint && typeof p.metadata_hint === 'object'
        ? (p.metadata_hint as Record<string, unknown>)
        : undefined,
  };
}

export async function runIngestTextsStep(
  sessionId: string,
  items: StagingRow[],
  assertNotCancelled: (sessionId: string) => void
): Promise<void> {
  let duplicatesThisBatch = 0;

  await runPerItemStep<StagingRow>({
    sessionId,
    stepKey: 'ingest_texts',
    items,
    // Local work only (hash + DB insert + gzip write) — sequential is fine.
    concurrency: 1,
    assertNotCancelled,
    progressMessage: (done, failed, total) => {
      let msg = `${done}/${total} saved`;
      if (failed > 0) msg += `, ${failed} failed`;
      if (duplicatesThisBatch > 0) {
        msg += `, ${duplicatesThisBatch} duplicates skipped`;
      }
      return msg;
    },
    run: async (row) => {
      if (row.connector === 'saved-link') {
        // Media-only tweets — no source row, just a saved-link entry.
        const payload = readSavedLinkPayload(row);
        if (!payload) {
          throw new Error('ingest_texts: invalid saved-link payload (missing url)');
        }
        const dateSaved =
          typeof payload.metadata_hint?.date_saved === 'string'
            ? payload.metadata_hint.date_saved
            : null;
        insertIngestFailure({
          failure_id: randomUUID(),
          source_url: payload.url,
          title_hint: payload.title_hint ?? null,
          date_saved: dateSaved,
          error: 'saved_link_no_content',
          source_type: 'tweet',
          session_id: sessionId,
        });
        void regenerateSavedLinksPage().catch(() => {});
        markStagingIngested(row.stage_id, SAVED_LINK_SENTINEL);
        return;
      }

      // Regular text row.
      const payload = readTextPayload(row);
      if (!payload) {
        throw new Error('ingest_texts: invalid text payload (missing markdown)');
      }

      const content_hash = `sha256-${createHash('sha256')
        .update(payload.markdown)
        .digest('hex')}`;

      const hashDupe = findSourceByContentHash(content_hash);
      if (hashDupe) {
        markStagingIngested(row.stage_id, hashDupe.source_id);
        duplicatesThisBatch++;
        return;
      }

      const sourceId = randomUUID();
      const filePath = storeRawMarkdown(sourceId, payload.markdown);
      const source_type = payload.source_type_hint ?? 'text';
      const title =
        payload.title_hint ??
        // Fall back to first non-empty line, capped at 80 chars.
        payload.markdown.split('\n').find((l) => l.trim())?.trim().slice(0, 80) ??
        'Untitled note';

      insertSource({
        source_id: sourceId,
        title,
        source_type,
        source_url: null,
        content_hash,
        file_path: filePath,
        metadata: payload.metadata ?? null,
        compile_status: 'pending',
        onboarding_session_id: sessionId,
      });

      markStagingIngested(row.stage_id, sourceId);
    },
    onFailure: async (row, error) => {
      const msg = error.message;
      markStagingFailed(row.stage_id, 'ingest_text_failed', msg);

      insertActivity({
        action_type: 'ingest_text_failed',
        source_id: null,
        details: {
          stage_id: row.stage_id,
          session_id: sessionId,
          connector: row.connector,
          error: msg,
        },
      });
    },
  });
}
