import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH ?? '/data/db/kompl.db';

/** Where POST /api/onboarding/upload saves files: /data/raw/uploads. */
export const UPLOADS_DIR = path.join(path.dirname(path.dirname(DB_PATH)), 'raw', 'uploads');

/**
 * Whether `p` names a file directly in UPLOADS_DIR, where the upload route
 * saves every file. A staged upload's path is later read by the import step
 * and unlinked when the session is discarded, so a path from the request
 * body must not reach anything else: no relative path, no "..", and no
 * symlink in the folder that leads out of it.
 */
export function isUploadPath(p: string): boolean {
  if (!path.isAbsolute(p) || p.includes('\0')) return false;
  const resolved = path.resolve(p);
  if (path.dirname(resolved) !== path.resolve(UPLOADS_DIR)) return false;
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    // Not there (any more): there is no link to follow.
    return true;
  }
  return path.dirname(real) === fs.realpathSync(UPLOADS_DIR);
}
