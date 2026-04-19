/**
 * Pipeline prelude step: ingest file-upload staging rows into `sources`.
 *
 * For each staging row with connector='file-upload', calls nlp-service
 * /convert/file-path (MarkItDown — local CPU, no network), dedups on
 * content_hash, writes raw markdown to disk, inserts a sources row with
 * compile_status='pending'.
 *
 * Concurrency 2: MarkItDown is CPU-bound per request on the NLP service
 * side; running 2 in parallel lets I/O (disk read + NLP spaCy post) overlap
 * without oversubscribing the NLP pod. Higher values don't help given the
 * bottleneck is inside the NLP service.
 *
 * Per-item failure writes insertActivity + markStagingFailed. Unlike
 * ingest_urls there's no ingest_failures row — file-upload failures
 * don't belong on the Saved Links wiki page (they're local files, not
 * web links).
 */

import { randomUUID } from 'node:crypto';

import {
  findSourceByContentHash,
  insertActivity,
  insertSource,
  markStagingFailed,
  markStagingIngested,
  storeRawMarkdown,
  type StagingRow,
} from '../../db';
import { callConvertFilePath } from '../../nlp-convert';
import { runPerItemStep } from '../step-runner';

const INGEST_FILES_CONCURRENCY = 2;

interface FileUploadPayload {
  file_path: string;
  filename?: string;
  title_hint?: string;
  metadata_hint?: Record<string, unknown>;
}

function readFilePayload(row: StagingRow): FileUploadPayload | null {
  const p = row.payload as Partial<FileUploadPayload>;
  if (typeof p.file_path !== 'string' || !p.file_path) return null;
  return {
    file_path: p.file_path,
    filename: typeof p.filename === 'string' ? p.filename : undefined,
    title_hint: typeof p.title_hint === 'string' ? p.title_hint : undefined,
    metadata_hint:
      p.metadata_hint && typeof p.metadata_hint === 'object'
        ? (p.metadata_hint as Record<string, unknown>)
        : undefined,
  };
}

export async function runIngestFilesStep(
  sessionId: string,
  items: StagingRow[],
  assertNotCancelled: (sessionId: string) => void
): Promise<void> {
  let duplicatesThisBatch = 0;

  await runPerItemStep<StagingRow>({
    sessionId,
    stepKey: 'ingest_files',
    items,
    concurrency: INGEST_FILES_CONCURRENCY,
    assertNotCancelled,
    progressMessage: (done, failed, total) => {
      let msg = `${done}/${total} converted`;
      if (failed > 0) msg += `, ${failed} failed`;
      if (duplicatesThisBatch > 0) {
        msg += `, ${duplicatesThisBatch} duplicates skipped`;
      }
      return msg;
    },
    run: async (row) => {
      const payload = readFilePayload(row);
      if (!payload) {
        throw new Error('ingest_files: invalid payload (missing file_path)');
      }

      const sourceId = randomUUID();
      const result = await callConvertFilePath(
        sourceId,
        payload.file_path,
        payload.title_hint
      );
      if (!result.ok) {
        throw new Error(`${result.code}: ${result.detail}`);
      }
      const convertResult = result.data;

      // Content-hash dedup for files: same PDF uploaded twice would otherwise
      // produce two identical source rows.
      const hashDupe = findSourceByContentHash(convertResult.content_hash);
      if (hashDupe) {
        markStagingIngested(row.stage_id, hashDupe.source_id);
        duplicatesThisBatch++;
        return;
      }

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

      markStagingIngested(row.stage_id, sourceId);
    },
    onFailure: async (row, error) => {
      const payload = readFilePayload(row);
      const msg = error.message;
      const codeMatch = msg.match(/^(nlp_unreachable|nlp_convert_failed):/);
      const error_code = codeMatch ? codeMatch[1] : 'ingest_file_failed';

      markStagingFailed(row.stage_id, error_code, msg);

      insertActivity({
        action_type: 'ingest_file_failed',
        source_id: null,
        details: {
          stage_id: row.stage_id,
          session_id: sessionId,
          filename: payload?.filename ?? null,
          file_path: payload?.file_path ?? null,
          error_code,
          error: msg,
        },
      });
    },
  });
}
