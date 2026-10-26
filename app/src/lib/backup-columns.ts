/**
 * Columns a .kompl backup carries that came after its format was first
 * written (POST /api/import). The zip is untrusted, so each value is kept
 * only when it has the right shape; anything else is NULL, which is also
 * what a backup made before the column existed restores.
 */

import path from 'node:path';

import { isLlmModel } from './llm-models';

/** A text column: the string, or null. */
export function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * sources.file_path: where the source's raw text was kept. Kompl finds the
 * raw file from the source id and never opens or deletes this path, but a
 * crafted zip could name any file here (e.g. /data/db/kompl.db). A path is
 * kept only when it names this source's raw file (<data root>/raw/<id>.md.gz);
 * anything else becomes `rawPath`, where this install keeps the file.
 */
export function sourceFilePathFromBackup(sourceId: string, value: unknown, rawPath: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) return rawPath;
  return path.basename(value) === `${sourceId}.md.gz` && path.basename(path.dirname(value)) === 'raw' ? value : rawPath;
}

/** compile_status values a restore keeps ('collected' was retired by migrate.py). */
const COMPILE_STATUSES = new Set(['pending', 'in_progress', 'extracted', 'active', 'compiled', 'failed']);

/**
 * A source's compile state as the backup carries it, each field kept when
 * it has the right shape. Backups without it restore the source as before:
 * compiled ('active'), no attempts, no session.
 */
export function sourceCompileStateFromBackup(s: Record<string, unknown>): {
  compile_status: string;
  compile_attempts: number;
  compile_next_eligible_at: string | null;
  onboarding_session_id: string | null;
} {
  const attempts = s.compile_attempts;
  return {
    compile_status:
      typeof s.compile_status === 'string' && COMPILE_STATUSES.has(s.compile_status) ? s.compile_status : 'active',
    compile_attempts: typeof attempts === 'number' && Number.isInteger(attempts) && attempts >= 0 ? attempts : 0,
    compile_next_eligible_at: textOrNull(s.compile_next_eligible_at),
    onboarding_session_id: textOrNull(s.onboarding_session_id),
  };
}

/**
 * compile_progress.compile_model (v20): a model this release knows, or null
 * (the session then follows Settings, as sessions from before v20 do).
 */
export function compileModelFromBackup(value: unknown): string | null {
  return isLlmModel(value) ? value : null;
}

/**
 * pages.restore_page_type (v30, lib/page-hold.ts): the type a page archived
 * after a failed rewrite returns as. A page type's spelling, never
 * 'archived'; anything else is null (the page then stays archived for good,
 * as in backups made before the column).
 */
export function restorePageTypeFromBackup(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z][a-z-]{0,39}$/.test(value) && value !== 'archived' ? value : null;
}

/** ingest_failures.attempts (v30): a positive whole number, else 1 (one failure, as before the column). */
export function failureAttemptsFromBackup(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
}

/**
 * page_plans.used_source_ids (v30): a JSON list of source ids, kept as
 * written, or null (approval then credits every plan source).
 */
export function usedSourceIdsFromBackup(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string') ? value : null;
  } catch {
    return null;
  }
}
