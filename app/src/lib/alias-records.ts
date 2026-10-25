/**
 * Alias rows as a .kompl backup carries them (schema v29). Import reads
 * untrusted JSON, so each v29 field is kept only when it has the right
 * shape. A backup from before v29 has none of them: its aliases come back
 * active, with no method, and the alias screen (alias-screen.ts) looks at
 * them after the import.
 */

const STATUSES = new Set(['active', 'suspended', 'retired']);

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export interface ImportedAliasRecord {
  alias: string;
  canonical_name: string;
  canonical_page_id: string | null;
  method: string | null;
  score: number | null;
  session_id: string | null;
  status: string;
  status_reason: string | null;
  status_at: string | null;
  /** When the alias was made; null in backups that left it out (stamped at import). */
  created_at: string | null;
}

export function aliasRecordFromBackup(a: Record<string, unknown>): ImportedAliasRecord {
  return {
    alias: a.alias as string,
    canonical_name: a.canonical_name as string,
    canonical_page_id: text(a.canonical_page_id),
    method: text(a.method),
    score: typeof a.score === 'number' && Number.isFinite(a.score) ? a.score : null,
    session_id: text(a.session_id),
    status: typeof a.status === 'string' && STATUSES.has(a.status) ? a.status : 'active',
    status_reason: text(a.status_reason),
    status_at: text(a.status_at),
    created_at: text(a.created_at),
  };
}
