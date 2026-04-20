import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  deleteIngestFailure,
  getUnresolvedLinks,
  insertIngestFailure,
} from '../lib/db';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

describe('saved-links helpers', () => {
  let handle: TestDbHandle;

  beforeEach(() => {
    handle = setupTestDb();
  });

  afterEach(() => {
    handle.cleanup();
  });

  it('insertIngestFailure round-trips metadata JSON and getUnresolvedLinks surfaces it', () => {
    const failure_id = randomUUID();
    const metadata = JSON.stringify({
      author: '@someone',
      tweet_url: 'https://twitter.com/someone/status/123',
      date_saved: '2026-04-19T10:00:00.000Z',
    });

    insertIngestFailure({
      failure_id,
      source_url: 'https://twitter.com/someone/status/123',
      title_hint: 'Tweet by @someone',
      date_saved: '2026-04-19T10:00:00.000Z',
      error: 'saved_link_no_content',
      source_type: 'tweet',
      metadata,
      session_id: null,
    });

    const rows = getUnresolvedLinks();
    expect(rows).toHaveLength(1);
    expect(rows[0].failure_id).toBe(failure_id);
    expect(rows[0].title).toBe('Tweet by @someone');
    expect(rows[0].source_type).toBe('tweet');
    expect(rows[0].error).toBe('saved_link_no_content');
    expect(rows[0].metadata).toBe(metadata);
    const parsed = JSON.parse(rows[0].metadata!);
    expect(parsed.author).toBe('@someone');
    expect(parsed.tweet_url).toBe('https://twitter.com/someone/status/123');
  });

  it('deleteIngestFailure removes the row and returns true', () => {
    const failure_id = randomUUID();
    insertIngestFailure({
      failure_id,
      source_url: 'https://example.com/a',
      title_hint: null,
      date_saved: null,
      error: 'nlp_unreachable',
      source_type: 'url',
      metadata: null,
      session_id: null,
    });

    expect(getUnresolvedLinks()).toHaveLength(1);
    expect(deleteIngestFailure(failure_id)).toBe(true);
    expect(getUnresolvedLinks()).toHaveLength(0);
  });

  it('deleteIngestFailure returns false for an unknown id (no-op)', () => {
    expect(deleteIngestFailure(randomUUID())).toBe(false);
  });

  it('getUnresolvedLinks tolerates NULL metadata (legacy rows)', () => {
    insertIngestFailure({
      failure_id: randomUUID(),
      source_url: 'https://twitter.com/old/status/1',
      title_hint: 'Saved tweet',
      date_saved: null,
      error: 'saved_link_no_content',
      source_type: 'tweet',
      metadata: null,
      session_id: null,
    });

    const rows = getUnresolvedLinks();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toBeNull();
    expect(rows[0].title).toBe('Saved tweet');
  });
});
