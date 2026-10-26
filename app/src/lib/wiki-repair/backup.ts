/**
 * Step 1 of the wiki repair: a full .kompl.zip backup (lib/kompl-backup.ts,
 * the one Import restores) saved on the data volume before anything
 * changes, as backups/before-repair-<UTC timestamp>.kompl.zip. A run whose
 * backup cannot be made, written or read back does not start. Each one is a
 * whole copy of the wiki, so once a new one is saved only the newest
 * REPAIR_BACKUPS_KEPT stay; older ones, and a copy a crash left half
 * written, are deleted. Other files in the folder are never touched.
 *
 * Vectors are left out: an import embeds every page again.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import JSZip from 'jszip';

import { DATA_ROOT } from '../db';
import { buildKomplBackup } from '../kompl-backup';
import { REPAIR_BACKUPS_KEPT, REPAIR_BACKUP_DIR } from './limits';

const NAME = /^before-repair-\d{8}-\d{6}\.kompl\.zip$/;
const PARTIAL = /^before-repair-\d{8}-\d{6}\.kompl\.zip\.partial$/;

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
  await pruneRepairBackups(dir, name);
  return { file: name, bytes: size, taken_at: now.toISOString() };
}

/**
 * Deletes all but the newest REPAIR_BACKUPS_KEPT backups (their names sort
 * by time) and leftover partial writes, never `keep`, the one just saved. A
 * failed delete never fails the backup.
 */
async function pruneRepairBackups(dir: string, keep: string): Promise<void> {
  try {
    const names = await fs.readdir(dir);
    const old = names.filter((n) => NAME.test(n)).sort().slice(0, -REPAIR_BACKUPS_KEPT);
    for (const name of [...old, ...names.filter((n) => PARTIAL.test(n))]) {
      if (name !== keep) await fs.rm(path.join(dir, name), { force: true });
    }
  } catch (err) {
    console.warn('[wiki-repair] could not delete older backups', err);
  }
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
