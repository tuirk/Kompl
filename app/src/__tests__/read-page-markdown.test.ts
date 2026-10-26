/**
 * readPageMarkdown serves the newest committed text. pages.pending_content is
 * set inside a commit's transaction and cleared only after the file write
 * lands (outbox, CLAUDE.md rule 5), so while it is set it is newer than any
 * file on disk: after a failed write, the page view, read_page and the next
 * update must not fall back to the older file. Reading never writes.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { clearPendingContent, DATA_ROOT, readPageMarkdown, setPendingContent } from '../lib/db';
import { seedPage, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function writeFile(pageId: string, markdown: string): string {
  const file = path.join(DATA_ROOT, 'pages', `${pageId}.md.gz`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, gzipSync(markdown));
  return file;
}

describe('readPageMarkdown', () => {
  it('serves pending_content over an older file, and only reads', () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'btc', title: 'Bitcoin' });
    const file = writeFile('btc', 'Old text.');
    setPendingContent('btc', 'New committed text.');

    expect(readPageMarkdown('btc')).toBe('New committed text.');
    expect(gunzipSync(readFileSync(file)).toString('utf-8')).toBe('Old text.');
    const row = handle.db.prepare('SELECT pending_content FROM pages WHERE page_id = ?').get('btc');
    expect(row).toEqual({ pending_content: 'New committed text.' });
  });

  it('serves the file once the write has landed', () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'btc', title: 'Bitcoin' });
    setPendingContent('btc', 'New committed text.');
    writeFile('btc', 'New committed text.');
    clearPendingContent('btc', null);
    expect(readPageMarkdown('btc')).toBe('New committed text.');
    writeFile('btc', 'On disk.');
    expect(readPageMarkdown('btc')).toBe('On disk.');
  });

  it('falls back to pending_content with no file, and to null with neither', () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'fresh', title: 'Fresh' });
    expect(readPageMarkdown('fresh')).toBeNull();
    setPendingContent('fresh', 'First draft.');
    expect(readPageMarkdown('fresh')).toBe('First draft.');
    expect(readPageMarkdown('no-such-page')).toBeNull();
  });
});
