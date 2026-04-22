/**
 * detectMetaQuery — false-positive regression guard.
 *
 * A content-request like "summarise my most recent sources" used to match the
 * "most recent source" meta-query regex and short-circuit to a timestamp
 * answer, bypassing retrieval + LLM synthesis entirely. Content verbs up
 * front must fall through to retrieval; bare meta questions must still fire.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { detectMetaQuery } from '../app/api/chat/route';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe('detectMetaQuery', () => {
  function withDb() {
    handle = setupTestDb();
  }

  it('returns null for content-request verbs that mention recent sources', () => {
    const contentRequests = [
      'Summarise my most recent sources',
      'summarize my latest articles',
      'Describe my newest source',
      'tell me about my latest source',
      'list my most recent sources',
      'show my recent updates',
      'explain the latest source',
      'give me a recap of my newest articles',
    ];
    for (const q of contentRequests) {
      expect(detectMetaQuery(q), `should fall through: ${q}`).toBeNull();
    }
  });

  it('still matches bare meta questions about the last ingest', () => {
    withDb();
    expect(detectMetaQuery('when was the last source ingested')).not.toBeNull();
    expect(detectMetaQuery('what was the latest source added')).not.toBeNull();
    expect(detectMetaQuery('most recent source?')).not.toBeNull();
  });

  it('still matches bare "how many" and stats questions', () => {
    withDb();
    expect(detectMetaQuery('how many sources do I have')).not.toBeNull();
    expect(detectMetaQuery('wiki stats')).not.toBeNull();
  });
});
