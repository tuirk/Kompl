/**
 * POST /api/ingest/upload
 *
 * Browser multipart upload → Next.js writes each file to the shared
 * kompl-data volume at /data/raw/uploads/<uuid>-<safe_filename> → POSTs
 * {source_id, source_type:"file", source_ref:<abs_path>} to n8n's
 * ingest webhook. Same Sidecar pattern as /api/ingest/url.
 *
 * Request:  FormData with one or more "files" keys
 * Response: {accepted: number, source_ids: string[]}
 *
 * File path safety: nlp-service also validates that file_path is under
 * /data/. The extensions allowlist here is a defence-in-depth match of
 * the server-side allowlist (keeps us from writing .exe to the volume).
 */

import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { insertActivity } from '../../../../lib/db';

const N8N_URL = process.env.N8N_URL ?? 'http://n8n:5678';
const N8N_INGEST_WEBHOOK_PATH = '/webhook/ingest';
const N8N_TIMEOUT_MS = 5000;

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
  // Strip directory separators and any character that isn't a letter,
  // digit, dot, dash, or underscore.
  const base = path.basename(name);
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

async function triggerN8n(payload: {
  source_id: string;
  source_type: 'file';
  source_ref: string;
  title_hint: string | null;
}): Promise<void> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), N8N_TIMEOUT_MS);
  try {
    const res = await fetch(`${N8N_URL}${N8N_INGEST_WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`n8n webhook returned ${res.status}`);
  } finally {
    clearTimeout(t);
  }
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

  const accepted_source_ids: string[] = [];
  const failed_files: { filename: string; error: string }[] = [];

  for (const file of files) {
    const rawName = file.name || 'unnamed';
    const ext = path.extname(rawName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      failed_files.push({ filename: rawName, error: `disallowed_extension: ${ext}` });
      continue;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      failed_files.push({ filename: rawName, error: 'file_too_large' });
      continue;
    }

    const source_id = randomUUID();
    const safeName = sanitizeFilename(rawName);
    const targetPath = path.join(UPLOADS_DIR, `${source_id}-${safeName}`);

    try {
      const buf = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(targetPath, buf);
    } catch (e) {
      const error = e instanceof Error ? e.message : 'unknown';
      failed_files.push({ filename: rawName, error: `write_failed: ${error}` });
      continue;
    }

    insertActivity({
      action_type: 'ingest_accepted',
      source_id,
      details: { source_type: 'file', source_ref: targetPath, filename: rawName },
    });

    // Derive title hint from original filename (before UUID prefix) so the
    // UUID never leaks into pages.title via nlp-service's p.stem fallback.
    const title_hint = path.basename(rawName, path.extname(rawName)) || null;

    try {
      await triggerN8n({ source_id, source_type: 'file', source_ref: targetPath, title_hint });
      accepted_source_ids.push(source_id);
    } catch (e) {
      const error = e instanceof Error ? e.message : 'unknown';
      insertActivity({
        action_type: 'ingest_failed',
        source_id,
        details: { node: 'next_ingest_upload', error },
      });
      failed_files.push({ filename: rawName, error });
    }
  }

  if (accepted_source_ids.length === 0) {
    return NextResponse.json(
      {
        error: 'all uploads failed',
        failed: failed_files,
      },
      { status: 502 }
    );
  }

  return NextResponse.json(
    {
      accepted: accepted_source_ids.length,
      source_ids: accepted_source_ids,
      failed: failed_files.length > 0 ? failed_files : undefined,
    },
    { status: 202 }
  );
}
