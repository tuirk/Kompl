/**
 * Round-trip test for sources.title_source + title_rescued_at (v25 columns).
 *
 * Guards the contract between insertSource (writes) and getSource (reads):
 *   - title_source persists exactly as written
 *   - title_source omitted → stored as NULL (legacy/back-compat behavior)
 *   - title_rescued_at is NULL on insert (only set by commit-3 rescue path)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { insertSource, getSource } from '../lib/db';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

describe('sources.title_source round-trip (v25)', () => {
  let handle: TestDbHandle;

  beforeEach(() => {
    handle = setupTestDb();
  });

  afterEach(() => {
    handle.cleanup();
  });

  it('persists title_source when provided', () => {
    const source_id = randomUUID();
    insertSource({
      source_id,
      title: 'Q3 Roadmap',
      source_type: 'file',
      source_url: null,
      content_hash: 'sha256-abc',
      file_path: `/data/raw/${source_id}.md.gz`,
      metadata: null,
      title_source: 'body_h1',
    });
    const row = getSource(source_id);
    expect(row).not.toBeNull();
    expect(row!.title_source).toBe('body_h1');
    expect(row!.title_rescued_at).toBeNull();
  });

  it('stores NULL when title_source is omitted (back-compat for legacy callers)', () => {
    const source_id = randomUUID();
    insertSource({
      source_id,
      title: 'Old-style insert',
      source_type: 'file',
      source_url: null,
      content_hash: 'sha256-xyz',
      file_path: `/data/raw/${source_id}.md.gz`,
      metadata: null,
    });
    const row = getSource(source_id);
    expect(row).not.toBeNull();
    expect(row!.title_source).toBeNull();
    expect(row!.title_rescued_at).toBeNull();
  });

  it('round-trips all cascade-winner values used by ingest-* steps', () => {
    // Catches typo/drift between the Python ConvertResponse Literal and JS
    // call sites. Lower-cased string compare since the column is plain TEXT.
    const values = [
      'markitdown',
      'body_h1',
      'body_h2',
      'filename',
      'stem',
      'firecrawl',
      'firecrawl_url_fallback',
      'github_api',
      'youtube_oembed',
      'paste',
      'text_first_line',
    ];
    for (const v of values) {
      const source_id = randomUUID();
      insertSource({
        source_id,
        title: `t-${v}`,
        source_type: 'file',
        source_url: null,
        content_hash: `sha256-${v}`,
        file_path: `/data/raw/${source_id}.md.gz`,
        metadata: null,
        title_source: v,
      });
      const row = getSource(source_id);
      expect(row?.title_source, `value=${v}`).toBe(v);
    }
  });

  it('explicit null title_source stores as NULL (not the string "null")', () => {
    const source_id = randomUUID();
    insertSource({
      source_id,
      title: 'Explicit null',
      source_type: 'file',
      source_url: null,
      content_hash: 'sha256-null',
      file_path: `/data/raw/${source_id}.md.gz`,
      metadata: null,
      title_source: null,
    });
    const row = getSource(source_id);
    expect(row?.title_source).toBeNull();
  });
});
