/**
 * Columns a .kompl backup carries that came after its format was first
 * written (POST /api/import). The zip is untrusted, so each value is kept
 * only when it has the right shape; anything else is NULL, which is also
 * what a backup made before the column existed restores.
 */

import { isLlmModel } from './llm-models';

/** A text column: the string, or null. */
export function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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
