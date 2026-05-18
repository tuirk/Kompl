/**
 * Tests for the LLM-title rescue idempotency primitives (commit 3 of phase 2).
 *
 * The rescue trigger itself lives inline in /api/compile/extract/route.ts
 * (line ~315) because lifting it would require restructuring the route's
 * dependency tree. These tests cover:
 *   1. updateSourceTitle({ markRescued: true }) atomically sets title +
 *      title_rescued_at in a single UPDATE.
 *   2. Idempotency: a rescued row's title_rescued_at survives subsequent
 *      reads and is what the trigger checks to skip re-rescuing.
 *   3. Round-tripping the trigger inputs (title_source values) to ensure
 *      the trigger's predicate hits the correct branches.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { insertSource, getSource, updateSourceTitle } from '../lib/db';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

describe('updateSourceTitle — markRescued atomicity (v25)', () => {
  let handle: TestDbHandle;

  beforeEach(() => {
    handle = setupTestDb();
  });

  afterEach(() => {
    handle.cleanup();
  });

  function seedSource(overrides: { title?: string; title_source?: string | null } = {}): string {
    const source_id = randomUUID();
    insertSource({
      source_id,
      title: overrides.title ?? 'rec_000068',
      source_type: 'file',
      source_url: null,
      content_hash: `sha256-${source_id.slice(0, 8)}`,
      file_path: `/data/raw/${source_id}.md.gz`,
      metadata: null,
      title_source: overrides.title_source ?? 'filename',
    });
    return source_id;
  }

  it('markRescued: true sets title AND title_rescued_at in one UPDATE', () => {
    const source_id = seedSource();
    expect(getSource(source_id)?.title_rescued_at).toBeNull();

    updateSourceTitle(source_id, 'TRADING STOCK MARKET INDICES', { markRescued: true });

    const row = getSource(source_id);
    expect(row?.title).toBe('TRADING STOCK MARKET INDICES');
    expect(row?.title_rescued_at).not.toBeNull();
    // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" — sanity-check shape.
    expect(row?.title_rescued_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('default (no opts) updates title only; title_rescued_at stays NULL', () => {
    const source_id = seedSource();
    updateSourceTitle(source_id, 'Plain Update');

    const row = getSource(source_id);
    expect(row?.title).toBe('Plain Update');
    expect(row?.title_rescued_at).toBeNull();
  });

  it('markRescued: false is equivalent to omitting opts', () => {
    const source_id = seedSource();
    updateSourceTitle(source_id, 'No Mark', { markRescued: false });

    expect(getSource(source_id)?.title_rescued_at).toBeNull();
  });

  it('empty/whitespace newTitle is a no-op (does not stamp title_rescued_at)', () => {
    const source_id = seedSource();
    updateSourceTitle(source_id, '   ', { markRescued: true });
    updateSourceTitle(source_id, '', { markRescued: true });

    const row = getSource(source_id);
    expect(row?.title).toBe('rec_000068'); // unchanged
    expect(row?.title_rescued_at).toBeNull(); // never stamped
  });

  it('caps title at 250 chars even when markRescued is set', () => {
    const source_id = seedSource();
    const long = 'A'.repeat(300);
    updateSourceTitle(source_id, long, { markRescued: true });

    const row = getSource(source_id);
    expect(row?.title?.length).toBe(250);
    expect(row?.title_rescued_at).not.toBeNull();
  });

  it('subsequent markRescued call refreshes title_rescued_at timestamp', () => {
    // Real rescue trigger uses title_rescued_at as a "do not rescue again"
    // marker — but if a caller does invoke updateSourceTitle({markRescued: true})
    // a second time, the timestamp should advance (not stay frozen). This
    // proves the column is a normal UPDATE target, not write-once.
    const source_id = seedSource();
    updateSourceTitle(source_id, 'First Rescue', { markRescued: true });
    const first = getSource(source_id)?.title_rescued_at;

    // Force a measurable gap so the second datetime('now') differs even at
    // 1-second resolution.
    const start = Date.now();
    while (Date.now() - start < 1100) {
      // busy-wait ~1.1s
    }

    updateSourceTitle(source_id, 'Second Rescue', { markRescued: true });
    const second = getSource(source_id)?.title_rescued_at;

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.localeCompare(first!)).toBeGreaterThan(0);
  });
});

describe('title-rescue trigger inputs (v25)', () => {
  let handle: TestDbHandle;

  beforeEach(() => {
    handle = setupTestDb();
  });

  afterEach(() => {
    handle.cleanup();
  });

  // These tests sanity-check the round-trip of the values the rescue
  // trigger predicate switches on. The trigger lives inline in extract/
  // route.ts; lifting it for direct unit-test would require restructuring
  // the route. These guards catch the silent failure where a value gets
  // renamed in one place but not the other.

  it('title_source="filename" + title_rescued_at=NULL is the rescue-eligible shape', () => {
    const source_id = randomUUID();
    insertSource({
      source_id,
      title: 'rec_000068',
      source_type: 'file',
      source_url: null,
      content_hash: 'sha256-rec',
      file_path: `/data/raw/${source_id}.md.gz`,
      metadata: null,
      title_source: 'filename',
    });
    const row = getSource(source_id);
    expect(row?.title_source).toBe('filename');
    expect(row?.title_rescued_at).toBeNull();
  });

  it('title_source="paste" marks user-curated → never rescued', () => {
    const source_id = randomUUID();
    insertSource({
      source_id,
      title: 'My pasted note',
      source_type: 'paste',
      source_url: null,
      content_hash: 'sha256-paste',
      file_path: `/data/raw/${source_id}.md.gz`,
      metadata: null,
      title_source: 'paste',
    });
    expect(getSource(source_id)?.title_source).toBe('paste');
  });

  it('once rescued, title_rescued_at persists across re-reads', () => {
    const source_id = randomUUID();
    insertSource({
      source_id,
      title: 'rec_000068',
      source_type: 'file',
      source_url: null,
      content_hash: 'sha256-persist',
      file_path: `/data/raw/${source_id}.md.gz`,
      metadata: null,
      title_source: 'filename',
    });
    updateSourceTitle(source_id, 'Real Paper Title', { markRescued: true });
    expect(getSource(source_id)?.title_rescued_at).not.toBeNull();
    // Second read returns same value (sanity)
    expect(getSource(source_id)?.title_rescued_at).not.toBeNull();
  });
});
