/**
 * POST /api/onboarding/upload
 *
 * Saves uploaded files to /data/raw/uploads/<uuid>-<safename> WITHOUT
 * triggering n8n or inserting any DB records. Returns file paths so the
 * caller can pass them to POST /api/onboarding/collect.
 *
 * Mirrors /api/ingest/upload but with n8n call and activity logging removed —
 * collect generates the source_id and inserts the DB record.
 *
 * Request:  FormData with one or more "files" keys
 * Response: { files: Array<{ file_path: string; filename: string }>;
 *             failed: Array<{ filename: string; error: string }> }
 */

import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH ?? '/data/db/kompl.db';
const DATA_ROOT = path.dirname(path.dirname(DB_PATH)); // /data
const UPLOADS_DIR = path.join(DATA_ROOT, 'raw', 'uploads');

const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.pptx',
  '.xlsx',
  '.txt',
  '.md',
  '.html',
  '.htm',
  '.csv',
  '.json',
  '.xml',
  '.jpg',
  '.jpeg',
  '.png',
  '.mp3',
  '.wav',
]);

const MAX_FILES_PER_REQUEST = 20;
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

function sanitizeFilename(name: string): string {
  const base = path.basename(name);
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

interface UploadedFile {
  file_path: string;
  filename: string;
}

interface FailedFile {
  filename: string;
  error: string;
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_multipart' }, { status: 400 });
  }

  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'no files in "files" field' }, { status: 422 });
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json(
      { error: `max ${MAX_FILES_PER_REQUEST} files per request` },
      { status: 422 }
    );
  }

  await fs.mkdir(UPLOADS_DIR, { recursive: true });

  const uploaded: UploadedFile[] = [];
  const failed: FailedFile[] = [];

  for (const file of files) {
    const rawName = file.name || 'unnamed';
    const ext = path.extname(rawName).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(ext)) {
      failed.push({ filename: rawName, error: `disallowed_extension: ${ext}` });
      continue;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      failed.push({ filename: rawName, error: 'file_too_large' });
      continue;
    }

    const uuid = randomUUID();
    const safeName = sanitizeFilename(rawName);
    const targetPath = path.join(UPLOADS_DIR, `${uuid}-${safeName}`);

    try {
      const buf = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(targetPath, buf);
      uploaded.push({ file_path: targetPath, filename: rawName });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'unknown';
      failed.push({ filename: rawName, error: `write_failed: ${error}` });
    }
  }

  if (uploaded.length === 0) {
    return NextResponse.json(
      { error: 'all uploads failed', files: [], failed },
      { status: 502 }
    );
  }

  return NextResponse.json({ files: uploaded, failed }, { status: 200 });
}
