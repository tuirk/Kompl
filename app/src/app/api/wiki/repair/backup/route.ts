/**
 * GET /api/wiki/repair/backup — download the backup the last wiki repair
 * run saved before it changed anything (lib/wiki-repair/backup.ts), to
 * restore through Settings → Backup & restore → Import wiki.
 *
 * Response: 200 the .kompl.zip | 404 { error: 'no_backup', message }
 */

import fs from 'node:fs/promises';

import { NextResponse } from 'next/server';

import { repairBackupPath } from '@/lib/wiki-repair/backup';
import { currentRun } from '@/lib/wiki-repair/state';

export const dynamic = 'force-dynamic';

export async function GET() {
  const file = currentRun()?.backup?.file ?? null;
  const p = file ? await repairBackupPath(file) : null;
  if (!file || !p) {
    return NextResponse.json({ error: 'no_backup', message: 'There is no repair backup to download.' }, { status: 404 });
  }
  const buffer = await fs.readFile(p);
  return new NextResponse(new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${file}"`,
    },
  });
}
