/**
 * Each wiki repair saves a full backup on the data volume first
 * (lib/wiki-repair/backup.ts). They were never deleted, so a wiki repaired
 * often filled the volume with whole copies of itself. The newest few are
 * kept; older ones, and a copy a crash left half written, are deleted when
 * the next is saved.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DATA_ROOT } from '../lib/db';
import { saveRepairBackup } from '../lib/wiki-repair/backup';
import { REPAIR_BACKUPS_KEPT, REPAIR_BACKUP_DIR } from '../lib/wiki-repair/limits';
import { seedPage, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;
const DIR = path.join(DATA_ROOT, REPAIR_BACKUP_DIR);

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

describe('repair backups', () => {
  it(`keeps the newest ${REPAIR_BACKUPS_KEPT} and leaves other files alone`, async () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'page-a', title: 'A' });
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, 'my-notes.txt'), 'mine');
    fs.writeFileSync(path.join(DIR, 'before-repair-20200101-000000.kompl.zip.partial'), 'half');

    const saved: string[] = [];
    for (let day = 1; day <= 5; day++) {
      saved.push((await saveRepairBackup(new Date(Date.UTC(2026, 9, day, 12)))).file);
    }

    expect(fs.readdirSync(DIR).sort()).toEqual([...saved.slice(-REPAIR_BACKUPS_KEPT), 'my-notes.txt'].sort());
  });
});
