/**
 * Regression: export → import must preserve every persistent user-visible
 * table. Exactly mirrors the shape of export-import-provenance.test.ts: for
 * each newly-serialized table, prove that the `getAll*` SELECT includes every
 * NOT NULL column so the import route's `INSERT OR IGNORE` can replay without
 * silent drops (the same class of bug the provenance content_hash regression
 * exists to catch).
 *
 * Originally prompted by the graph bug: after a .kompl round-trip, the
 * Knowledge Graph showed N pages / 0 links because page_links was never
 * serialized. Scope then expanded to cover drafts, activity_log,
 * compile_progress, chat_messages, page_plans, entity_mentions, and
 * relationship_mentions — every persistent table that had drifted out of the
 * export set.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  getAllActivityLog,
  getAllChatMessages,
  getAllCompileProgress,
  getAllDrafts,
  getAllEntityMentions,
  getAllPageLinks,
  getAllPagePlans,
  getAllRelationshipMentions,
  getWikiGraph,
  insertPageLink,
  insertEntityMentions,
  insertRelationshipMentions,
} from '../lib/db';
import {
  seedCompileProgress,
  seedPage,
  seedPagePlan,
  seedSource,
  setupTestDb,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe('page_links export shape', () => {
  it('getAllPageLinks returns NOT NULL columns so import can re-insert', () => {
    handle = setupTestDb();
    const alpha = seedPage(handle.db, { title: 'Alpha' });
    const beta = seedPage(handle.db, { title: 'Beta' });
    insertPageLink(alpha, beta, 'wikilink');

    const rows = getAllPageLinks();
    expect(rows).toHaveLength(1);
    expect(rows[0].source_page_id).toBe(alpha);
    expect(rows[0].target_page_id).toBe(beta);
    expect(rows[0].link_type).toBe('wikilink');
    expect(rows[0].created_at).toBeTruthy();
  });

  it('replaying getAllPageLinks through the import INSERT restores graph edges', () => {
    handle = setupTestDb();
    const alpha = seedPage(handle.db, { title: 'Alpha' });
    const beta = seedPage(handle.db, { title: 'Beta' });
    insertPageLink(alpha, beta, 'wikilink');

    const exported = getAllPageLinks();
    handle.db.prepare('DELETE FROM page_links').run();
    expect(getWikiGraph().links).toHaveLength(0);

    for (const l of exported) {
      handle.db.prepare(
        `INSERT OR IGNORE INTO page_links
           (source_page_id, target_page_id, link_type, created_at)
         VALUES (?, ?, ?, ?)`
      ).run(l.source_page_id, l.target_page_id, l.link_type, l.created_at);
    }

    const graph = getWikiGraph();
    expect(graph.links).toHaveLength(1);
    expect(graph.links[0].source).toBe(alpha);
    expect(graph.links[0].target).toBe(beta);
    expect(graph.links[0].type).toBe('wikilink');
  });
});

describe('entity_mentions export shape', () => {
  it('getAllEntityMentions returns PK columns so import can re-insert', () => {
    handle = setupTestDb();
    const source_id = seedSource(handle.db);
    insertEntityMentions([
      { canonical_name: 'GPT-4', source_id, entity_type: 'PRODUCT' },
      { canonical_name: 'OpenAI', source_id, entity_type: 'ORG' },
    ]);

    const rows = getAllEntityMentions();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.canonical_name).toBeTruthy();
      expect(row.source_id).toBe(source_id);
      expect(row.first_seen_at).toBeTruthy();
    }
  });
});

describe('relationship_mentions export shape', () => {
  it('getAllRelationshipMentions returns PK columns so import can re-insert', () => {
    handle = setupTestDb();
    const source_id = seedSource(handle.db);
    insertRelationshipMentions([
      { from_canonical: 'GPT-4', to_canonical: 'OpenAI', relationship_type: 'built_by', source_id },
    ]);

    const rows = getAllRelationshipMentions();
    expect(rows).toHaveLength(1);
    expect(rows[0].from_canonical).toBe('GPT-4');
    expect(rows[0].to_canonical).toBe('OpenAI');
    expect(rows[0].relationship_type).toBe('built_by');
    expect(rows[0].source_id).toBe(source_id);
    expect(rows[0].first_seen_at).toBeTruthy();
  });
});

describe('drafts export shape', () => {
  it('getAllDrafts returns NOT NULL columns so import can re-insert', () => {
    handle = setupTestDb();
    handle.db.prepare(
      `INSERT INTO drafts (draft_id, page_id, draft_content, draft_type, source_id, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('draft-1', 'page-1', '# Draft body', 'page_recompile', 'src-1', 'pending');

    const rows = getAllDrafts();
    expect(rows).toHaveLength(1);
    expect(rows[0].draft_id).toBe('draft-1');
    expect(rows[0].draft_content).toBe('# Draft body');
    expect(rows[0].draft_type).toBe('page_recompile');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].created_at).toBeTruthy();
  });
});

describe('activity_log export shape', () => {
  it('getAllActivityLog returns NOT NULL columns so import can re-insert', () => {
    handle = setupTestDb();
    handle.db.prepare(
      `INSERT INTO activity_log (action_type, source_id, details)
       VALUES (?, ?, ?)`
    ).run('page_compiled', 'src-1', JSON.stringify({ page_id: 'page-1' }));

    const rows = getAllActivityLog();
    expect(rows).toHaveLength(1);
    expect(rows[0].action_type).toBe('page_compiled');
    expect(rows[0].source_id).toBe('src-1');
    expect(rows[0].details).toBe(JSON.stringify({ page_id: 'page-1' }));
    expect(rows[0].timestamp).toBeTruthy();
  });
});

describe('compile_progress export shape', () => {
  it('getAllCompileProgress returns NOT NULL columns so import can re-insert', () => {
    handle = setupTestDb();
    seedCompileProgress(handle.db, 'session-1', 3);

    const rows = getAllCompileProgress();
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('session-1');
    expect(rows[0].status).toBe('in_progress');
    expect(rows[0].steps).toBe('[]');
    expect(rows[0].source_count).toBe(3);
    expect(rows[0].created_at).toBeTruthy();
  });
});

describe('chat_messages export shape', () => {
  it('getAllChatMessages returns NOT NULL columns so import can re-insert', () => {
    handle = setupTestDb();
    handle.db.prepare(
      `INSERT INTO chat_messages (session_id, role, content, citations, pages_used, chat_model)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'chat-session-1',
      'user',
      'What is GPT-4?',
      JSON.stringify([]),
      JSON.stringify(['page-1']),
      'gemini-2.5-flash'
    );

    const rows = getAllChatMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('chat-session-1');
    expect(rows[0].role).toBe('user');
    expect(rows[0].content).toBe('What is GPT-4?');
    expect(rows[0].chat_model).toBe('gemini-2.5-flash');
    expect(rows[0].created_at).toBeTruthy();
  });
});

describe('page_plans export shape', () => {
  it('getAllPagePlans returns NOT NULL columns so import can re-insert', () => {
    handle = setupTestDb();
    const source_id = seedSource(handle.db);
    const plan_id = seedPagePlan(handle.db, {
      session_id: 'session-1',
      title: 'Transformer',
      source_ids: [source_id],
      draft_content: '# Transformer\n\nSome content.',
    });

    const rows = getAllPagePlans();
    expect(rows).toHaveLength(1);
    expect(rows[0].plan_id).toBe(plan_id);
    expect(rows[0].session_id).toBe('session-1');
    expect(rows[0].title).toBe('Transformer');
    expect(rows[0].page_type).toBe('entity');
    expect(rows[0].action).toBe('create');
    expect(rows[0].source_ids).toBe(JSON.stringify([source_id]));
    expect(rows[0].draft_content).toBe('# Transformer\n\nSome content.');
    expect(rows[0].draft_status).toBe('planned');
    expect(rows[0].created_at).toBeTruthy();
  });
});
