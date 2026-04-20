/**
 * chat_model setting + per-session model lock.
 *
 * Covers:
 *   1. Settings route rejects a chat_model value outside the 3-string allowlist (422).
 *   2. Settings route accepts a valid value and round-trips via GET.
 *   3. getSessionChatModel returns null for an empty session.
 *   4. insertChatMessage stamps chat_model onto the first row only; subsequent
 *      rows carry null; getSessionChatModel always returns the first-row stamp.
 *   5. chat_messages table has the chat_model column (schema-drift guard).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { POST as settingsPOST, GET as settingsGET } from '../app/api/settings/route';
import {
  setupTestDb,
  type TestDbHandle,
} from './helpers/test-db';
import {
  getSessionChatModel,
  insertChatMessage,
  getChatModel,
} from '../lib/db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function settingsPostRequest(body: object): Request {
  return new Request('http://test/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('chat_model settings validation', () => {
  it('rejects an unknown model string with 422', async () => {
    handle = setupTestDb();
    const res = await settingsPOST(settingsPostRequest({ chat_model: 'gemini-1.5-pro' }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('chat_model');
  });

  it('accepts a valid model and round-trips via GET', async () => {
    handle = setupTestDb();
    const postRes = await settingsPOST(settingsPostRequest({ chat_model: 'gemini-2.5-pro' }));
    expect(postRes.status).toBe(200);
    const getRes = await settingsGET();
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { chat_model: string };
    expect(body.chat_model).toBe('gemini-2.5-pro');
  });

  it('defaults to gemini-2.5-flash-lite when no value has been persisted', () => {
    handle = setupTestDb();
    expect(getChatModel()).toBe('gemini-2.5-flash-lite');
  });
});

describe('per-session chat_model stamp', () => {
  it('returns null for a session with no messages', () => {
    handle = setupTestDb();
    expect(getSessionChatModel('never-seen')).toBeNull();
  });

  it('stamps chat_model on the first row only and preserves it across turns', () => {
    handle = setupTestDb();
    const sid = 'session-abc';

    // First message — stamp with flash.
    insertChatMessage({
      session_id: sid,
      role: 'user',
      content: 'hello',
      chat_model: 'gemini-2.5-flash',
    });
    expect(getSessionChatModel(sid)).toBe('gemini-2.5-flash');

    // Second/third rows — no chat_model passed. First-row stamp must persist.
    insertChatMessage({ session_id: sid, role: 'assistant', content: 'hi' });
    insertChatMessage({ session_id: sid, role: 'user', content: 'again' });
    expect(getSessionChatModel(sid)).toBe('gemini-2.5-flash');

    // Inserting a later row WITH a different chat_model must not change the
    // session's resolved model — getSessionChatModel reads the first row only.
    insertChatMessage({
      session_id: sid,
      role: 'assistant',
      content: 'answer',
      chat_model: 'gemini-2.5-pro',
    });
    expect(getSessionChatModel(sid)).toBe('gemini-2.5-flash');
  });
});

describe('schema drift guard', () => {
  it('chat_messages has the chat_model column', () => {
    handle = setupTestDb();
    const cols = handle.db
      .prepare("PRAGMA table_info(chat_messages)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('chat_model');
  });
});
