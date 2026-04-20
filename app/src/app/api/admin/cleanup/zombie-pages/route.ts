/**
 * GET  /api/admin/cleanup/zombie-pages — dry-run, returns count + list
 * POST /api/admin/cleanup/zombie-pages — hard-delete every zombie page
 *
 * Recovers from prior delete-cascade gaps where pages were left in the wiki
 * after their backing sources were removed (e.g. compile drafts that were
 * approved long after the source deletion). The 'saved-links' system page
 * is exempt. Archived pages ARE included — if all backing sources are gone,
 * the page has no provenance to recover from anyway.
 *
 * Each removal does the full source-DELETE-style teardown:
 *   - deletePage() (pages + page_links + pages_fts + aliases + provenance + orphan plans)
 *   - delete on-disk markdown files
 *   - fire-and-forget vector-store delete
 *   - activity log entry per page
 */

import path from 'node:path';
import { promises as fsPromises } from 'fs';
import { NextResponse } from 'next/server';

import { DATA_ROOT, deletePage, findZombiePages, logActivity } from '../../../../../lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';
const PAGES_DIR = path.join(DATA_ROOT, 'pages');

async function deletePageFile(pageId: string): Promise<void> {
  const files = await fsPromises.readdir(PAGES_DIR).catch(() => [] as string[]);
  await Promise.all(
    files
      .filter((f) => f.startsWith(pageId))
      .map((f) => fsPromises.unlink(path.join(PAGES_DIR, f)).catch(() => {})),
  );
}

async function deleteFromVectorStore(pageId: string): Promise<void> {
  await fetch(`${NLP_SERVICE_URL}/vectors/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_id: pageId }),
    signal: AbortSignal.timeout(10_000),
  });
}

export async function GET() {
  const zombies = findZombiePages();
  return NextResponse.json({
    count: zombies.length,
    pages: zombies,
  });
}

export async function POST() {
  const zombies = findZombiePages();
  const purged: Array<{ page_id: string; title: string }> = [];

  for (const page of zombies) {
    const chatCleanup = deletePage(page.page_id);
    void deleteFromVectorStore(page.page_id).catch(() => {});
    void deletePageFile(page.page_id).catch(() => {});
    logActivity('page_deleted', {
      source_id: null,
      details: {
        page_id: page.page_id,
        title: page.title,
        reason: 'zombie_cleanup',
        prior_source_count: page.source_count,
      },
    });
    if (chatCleanup.chatDraftsRewritten > 0 || chatCleanup.chatDraftsDeleted > 0) {
      logActivity('chat_drafts_cleaned', {
        source_id: null,
        details: {
          page_id: page.page_id,
          page_title: page.title,
          rewritten: chatCleanup.chatDraftsRewritten,
          deleted: chatCleanup.chatDraftsDeleted,
          reason: 'zombie_cleanup',
        },
      });
    }
    purged.push({ page_id: page.page_id, title: page.title });
  }

  return NextResponse.json({
    deleted: purged.length,
    pages: purged,
  });
}
