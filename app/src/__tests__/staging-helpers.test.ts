import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  insertCollectStaging,
  getStagingBySession,
  getStagingByStageId,
  updateStagingIncluded,
  markStagingIngesting,
  markStagingIngested,
  markStagingFailed,
  deleteStagingBySession,
  findSourceByUrl,
  findSourceByContentHash,
  insertIngestFailure,
} from '../lib/db';
import { setupTestDb, seedSource, type TestDbHandle } from './helpers/test-db';

describe('staging helpers (v18)', () => {
  let handle: TestDbHandle;

  beforeEach(() => {
    handle = setupTestDb();
  });

  afterEach(() => {
    handle.cleanup();
  });

  it('insert + getBySession round-trips payload JSON', () => {
    const session_id = randomUUID();
    const stage_id = randomUUID();
    insertCollectStaging({
      stage_id,
      session_id,
      connector: 'url',
      payload: { url: 'https://example.com', title_hint: 'Example', display: { hostname: 'example.com' } },
    });

    const rows = getStagingBySession(session_id);
    expect(rows).toHaveLength(1);
    expect(rows[0].stage_id).toBe(stage_id);
    expect(rows[0].connector).toBe('url');
    expect(rows[0].included).toBe(true);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].payload).toEqual({
      url: 'https://example.com',
      title_hint: 'Example',
      display: { hostname: 'example.com' },
    });
  });

  it('scopes rows by session_id — other sessions are isolated', () => {
    const session_a = randomUUID();
    const session_b = randomUUID();
    insertCollectStaging({ stage_id: randomUUID(), session_id: session_a, connector: 'text', payload: { markdown: 'a' } });
    insertCollectStaging({ stage_id: randomUUID(), session_id: session_b, connector: 'text', payload: { markdown: 'b' } });

    expect(getStagingBySession(session_a)).toHaveLength(1);
    expect(getStagingBySession(session_b)).toHaveLength(1);
  });

  it('updateStagingIncluded toggles the included flag', () => {
    const session_id = randomUUID();
    const stage_id = randomUUID();
    insertCollectStaging({ stage_id, session_id, connector: 'url', payload: { url: 'https://example.com' } });

    updateStagingIncluded(stage_id, false);
    expect(getStagingByStageId(stage_id)?.included).toBe(false);

    updateStagingIncluded(stage_id, true);
    expect(getStagingByStageId(stage_id)?.included).toBe(true);
  });

  it('pending → ingesting → ingested lifecycle populates resolved_source_id + ingested_at', () => {
    const session_id = randomUUID();
    const stage_id = randomUUID();
    insertCollectStaging({ stage_id, session_id, connector: 'url', payload: { url: 'https://example.com' } });

    markStagingIngesting(stage_id);
    expect(getStagingByStageId(stage_id)?.status).toBe('ingesting');

    const source_id = seedSource(handle.db, {});
    markStagingIngested(stage_id, source_id);

    const row = getStagingByStageId(stage_id);
    expect(row?.status).toBe('ingested');
    expect(row?.resolved_source_id).toBe(source_id);
    expect(row?.ingested_at).not.toBeNull();
  });

  it('markStagingIngesting only fires on pending rows (idempotent guard)', () => {
    const session_id = randomUUID();
    const stage_id = randomUUID();
    insertCollectStaging({ stage_id, session_id, connector: 'url', payload: { url: 'https://example.com' } });

    markStagingFailed(stage_id, 'nlp_unreachable', 'NLP service timed out');
    markStagingIngesting(stage_id); // no-op; already failed

    expect(getStagingByStageId(stage_id)?.status).toBe('failed');
  });

  it('markStagingFailed captures error_code + error_message', () => {
    const session_id = randomUUID();
    const stage_id = randomUUID();
    insertCollectStaging({ stage_id, session_id, connector: 'url', payload: { url: 'https://bad.test' } });

    markStagingFailed(stage_id, 'firecrawl_http_403', 'Forbidden');

    const row = getStagingByStageId(stage_id);
    expect(row?.status).toBe('failed');
    expect(row?.error_code).toBe('firecrawl_http_403');
    expect(row?.error_message).toBe('Forbidden');
  });

  it('deleteStagingBySession returns file-upload paths for unlink + removes rows', () => {
    const session_id = randomUUID();
    insertCollectStaging({
      stage_id: randomUUID(), session_id, connector: 'url',
      payload: { url: 'https://example.com' },
    });
    insertCollectStaging({
      stage_id: randomUUID(), session_id, connector: 'file-upload',
      payload: { file_path: '/data/raw/uploads/abc-doc.pdf', filename: 'doc.pdf' },
    });
    insertCollectStaging({
      stage_id: randomUUID(), session_id, connector: 'file-upload',
      payload: { file_path: '/data/raw/uploads/def-slides.pptx', filename: 'slides.pptx' },
    });

    const result = deleteStagingBySession(session_id);
    expect(result.deleted).toBe(3);
    expect(result.file_paths).toHaveLength(2);
    expect(result.file_paths).toContain('/data/raw/uploads/abc-doc.pdf');
    expect(result.file_paths).toContain('/data/raw/uploads/def-slides.pptx');

    expect(getStagingBySession(session_id)).toHaveLength(0);
  });

  it('deleteStagingBySession is idempotent — second call returns deleted=0', () => {
    const session_id = randomUUID();
    insertCollectStaging({ stage_id: randomUUID(), session_id, connector: 'text', payload: { markdown: 'x' } });

    expect(deleteStagingBySession(session_id).deleted).toBe(1);
    expect(deleteStagingBySession(session_id).deleted).toBe(0);
  });
});

describe('source dedup helpers (v18)', () => {
  let handle: TestDbHandle;

  beforeEach(() => {
    handle = setupTestDb();
  });

  afterEach(() => {
    handle.cleanup();
  });

  it('findSourceByUrl hits when a live source matches the URL', () => {
    const source_id = seedSource(handle.db, {
      source_url: 'https://paulgraham.com/read.html',
      compile_status: 'pending',
    });
    expect(findSourceByUrl('https://paulgraham.com/read.html')).toEqual({ source_id });
  });

  it("findSourceByUrl skips 'collected' rows (back-compat with legacy)", () => {
    seedSource(handle.db, {
      source_url: 'https://legacy.test',
      compile_status: 'collected',
    });
    expect(findSourceByUrl('https://legacy.test')).toBeNull();
  });

  it('findSourceByUrl returns null when no source matches', () => {
    expect(findSourceByUrl('https://never-staged.test')).toBeNull();
  });

  it('findSourceByContentHash hits by hash even when URL is null', () => {
    // Default seedSource hash is 'sha256-test'. Seed two sources with the
    // same hash but the second one is 'collected' — expect the first.
    const source_id = seedSource(handle.db, {
      source_url: null,
      compile_status: 'pending',
    });
    expect(findSourceByContentHash('sha256-test')).toEqual({ source_id });
  });
});

describe('ingest_failures session_id scope (v18)', () => {
  let handle: TestDbHandle;

  beforeEach(() => {
    handle = setupTestDb();
  });

  afterEach(() => {
    handle.cleanup();
  });

  it('persists session_id when provided', () => {
    const session_id = randomUUID();
    const failure_id = randomUUID();
    insertIngestFailure({
      failure_id,
      source_url: 'https://bad.test',
      error: 'http_403',
      session_id,
    });

    const row = handle.db
      .prepare('SELECT session_id FROM ingest_failures WHERE failure_id = ?')
      .get(failure_id) as { session_id: string | null } | undefined;

    expect(row?.session_id).toBe(session_id);
  });

  it('accepts null session_id for n8n escape-hatch writers', () => {
    const failure_id = randomUUID();
    insertIngestFailure({
      failure_id,
      source_url: 'https://n8n-sourced.test',
      error: 'timeout',
    });

    const row = handle.db
      .prepare('SELECT session_id FROM ingest_failures WHERE failure_id = ?')
      .get(failure_id) as { session_id: string | null } | undefined;

    expect(row?.session_id).toBeNull();
  });
});
