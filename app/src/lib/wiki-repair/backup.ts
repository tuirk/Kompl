/**
 * Step 1 of the wiki repair: a full .kompl.zip backup (lib/kompl-backup.ts,
 * the one Import restores) saved on the data volume before anything
 * changes, as backups/before-repair-<UTC timestamp>.kompl.zip. A run whose
 * backup cannot be made, written or read back does not start. Backups are
 * never deleted by Kompl.
 *
 * Vectors are left out: an import embeds every page again.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import JSZip from 'jszip';

import { DATA_ROOT } from '../db';
import { buildKomplBackup } from '../kompl-backup';
import { REPAIR_BACKUP_DIR } from './limits';

const NAME = /^before-repair-\d{8}-\d{6}\.kompl\.zip$/;

export interface SavedBackup {
  file: string;
  bytes: number;
  taken_at: string;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Builds, saves and checks the backup. Throws when any of that fails. */
export async function saveRepairBackup(now = new Date()): Promise<SavedBackup> {
  const buffer = await buildKomplBackup({ includeVectors: false });
  // A backup that does not read back as one is no backup.
  const manifest = await (await JSZip.loadAsync(buffer)).file('manifest.json')?.async('string');
  if (!manifest || (JSON.parse(manifest) as { format?: string }).format !== 'kompl') {
    throw new Error('backup_unreadable');
  }
  const dir = path.join(DATA_ROOT, REPAIR_BACKUP_DIR);
  await fs.mkdir(dir, { recursive: true });
  let name = `before-repair-${stamp(now)}.kompl.zip`;
  for (let s = 1; await exists(path.join(dir, name)); s++) {
    name = `before-repair-${stamp(new Date(now.getTime() + s * 1000))}.kompl.zip`;
  }
  const target = path.join(dir, name);
  const partial = `${target}.partial`;
  await fs.writeFile(partial, buffer);
  await fs.rename(partial, target);
  const { size } = await fs.stat(target);
  if (size !== buffer.length) throw new Error('backup_write_incomplete');
  return { file: name, bytes: size, taken_at: now.toISOString() };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** The saved backup's path, when `file` is one this module named and it is still there. */
export async function repairBackupPath(file: string): Promise<string | null> {
  if (!NAME.test(file)) return null;
  const p = path.join(DATA_ROOT, REPAIR_BACKUP_DIR, file);
  return (await exists(p)) ? p : null;
}
