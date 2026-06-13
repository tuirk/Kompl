/**
 * getCurrentPageHash must hash decompressed markdown (same basis as commit),
 * not raw gzip bytes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { getCurrentPageHash, DATA_ROOT } from '../lib/db';
import { setupTestDb, seedPage, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function writePageGzip(pageId: string, markdown: string): void {
  const pagesDir = join(DATA_ROOT, 'pages');
  if (!existsSync(pagesDir)) mkdirSync(pagesDir, { recursive: true });
  writeFileSync(join(pagesDir, `${pageId}.md.gz`), gzipSync(Buffer.from(markdown, 'utf-8')));
}

describe('getCurrentPageHash', () => {
  it('hashes decompressed markdown, not gzip bytes', () => {
    handle = setupTestDb();
    const page_id = 'test-page';
    const markdown = '---\ntitle: Test\n---\n\nBody content.';
    seedPage(handle.db, { page_id });
    writePageGzip(page_id, markdown);

    const expected = createHash('sha256').update(markdown).digest('hex');
    expect(getCurrentPageHash(page_id)).toBe(expected);

    const gzipBytes = gzipSync(Buffer.from(markdown, 'utf-8'));
    const gzipHash = createHash('sha256').update(gzipBytes).digest('hex');
    expect(getCurrentPageHash(page_id)).not.toBe(gzipHash);
  });

  it('returns empty string when no file and no pending_content', () => {
    handle = setupTestDb();
    const page_id = seedPage(handle.db);
    expect(getCurrentPageHash(page_id)).toBe('');
  });

  it('hashes pending_content when file not yet flushed', () => {
    handle = setupTestDb();
    const page_id = 'pending-only';
    const markdown = '# Pending draft body';
    handle.db
      .prepare(
        `INSERT INTO pages
           (page_id, title, page_type, content_path, source_count, pending_content)
         VALUES (?, 'T', 'entity', ?, 1, ?)`
      )
      .run(page_id, `/data/pages/${page_id}.md.gz`, markdown);

    const expected = createHash('sha256').update(markdown).digest('hex');
    expect(getCurrentPageHash(page_id)).toBe(expected);
  });
});
