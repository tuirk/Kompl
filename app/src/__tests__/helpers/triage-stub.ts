/**
 * Test helpers for match triage and the re-check of stored triage failures:
 * a fetch stub for nlp-service (TF-IDF, triage, page writes) that can also
 * forward app routes to their real handlers, and a seed for stored pairs.
 */

import type Database from 'better-sqlite3';
import { vi } from 'vitest';

export const verdict = (decision: string, reason = 'checked') => () => Response.json({ decision, reason });
export const status = (code: number, detail: string) => () => Response.json({ detail }, { status: code });

export interface FetchStub {
  /** Page titles sent to /pipeline/triage, in call order. */
  triaged: string[];
  /** Every path fetched, in order. */
  calls: string[];
  /** The bodies the app sent to its own routes, by path. */
  routeBodies: Record<string, Array<Record<string, unknown>>>;
}

const DEFAULTS: Record<string, () => Response> = {
  '/health': () => Response.json({ status: 'ok' }),
  '/storage/write-page': () => Response.json({ current_path: '/data/pages/x.md.gz', previous_path: null }),
  '/vectors/upsert': () => Response.json({}),
  '/webhook/session-compile': () => Response.json({ ok: true }),
};

/**
 * `candidates`: a word in the source text → the page ids TF-IDF returns for
 * it. `triage`: page title → the triage answer. `routes`: app path → its
 * handler, called with the same body. `answers`: path → canned answer.
 */
export function stubFetch(opts: {
  candidates?: Record<string, string[]>;
  triage?: Record<string, () => Response>;
  routes?: Record<string, (req: Request) => Promise<Response>>;
  answers?: Record<string, () => Response>;
}): FetchStub {
  const stub: FetchStub = { triaged: [], calls: [], routeBodies: {} };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url.toString()).pathname;
      stub.calls.push(path);
      const raw = String(init?.body ?? '{}');
      const route = opts.routes?.[path];
      if (route) {
        (stub.routeBodies[path] ??= []).push(JSON.parse(raw) as Record<string, unknown>);
        return route(new Request(url.toString(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw }));
      }
      const answer = opts.answers?.[path];
      if (answer) {
        if (path.startsWith('/api/')) (stub.routeBodies[path] ??= []).push(JSON.parse(raw) as Record<string, unknown>);
        return answer();
      }
      const body = JSON.parse(raw) as Record<string, string>;
      if (path === '/extract/tfidf-overlap') {
        const key = Object.keys(opts.candidates ?? {}).find((k) => body.source_text.includes(k));
        const pages = key ? opts.candidates![key] : [];
        return Response.json({ overlap_score: 0.5, top_matches: pages.map((page_id) => ({ page_id, similarity: 0.5 })) });
      }
      if (path === '/pipeline/triage') {
        stub.triaged.push(body.page_title);
        const reply = opts.triage?.[body.page_title];
        if (!reply) throw new Error(`no triage answer for ${body.page_title}`);
        return reply();
      }
      const fallback = DEFAULTS[path];
      if (fallback) return fallback();
      throw new Error(`unexpected fetch in test: ${url.toString()}`);
    }),
  );
  return stub;
}

export interface StoredPairArgs {
  source_id: string;
  page_id: string;
  reason?: string;
  attempts?: number;
  /** SQLite datetime text; defaults to now. */
  first_failed_at?: string;
  session_id?: string;
  verdict?: string | null;
  verdict_reason?: string | null;
  verdict_session_id?: string | null;
}

export function seedStoredPair(db: Database.Database, a: StoredPairArgs): void {
  db.prepare(
    `INSERT INTO triage_rechecks
       (source_id, page_id, reason, attempts, first_failed_at, last_failed_at, session_id,
        verdict, verdict_reason, verdict_session_id)
     VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?)`,
  ).run(
    a.source_id,
    a.page_id,
    a.reason ?? 'triage_error',
    a.attempts ?? 1,
    a.first_failed_at ?? null,
    a.first_failed_at ?? null,
    a.session_id ?? 'sess-earlier',
    a.verdict ?? null,
    a.verdict_reason ?? null,
    a.verdict_session_id ?? null,
  );
}

export interface StoredPairRow {
  source_id: string;
  page_id: string;
  reason: string;
  attempts: number;
  session_id: string;
  first_failed_at: string;
  last_failed_at: string;
  verdict: string | null;
  verdict_reason: string | null;
  verdict_session_id: string | null;
}

export function storedPairs(db: Database.Database): StoredPairRow[] {
  return db
    .prepare('SELECT * FROM triage_rechecks ORDER BY first_failed_at, source_id, page_id')
    .all() as StoredPairRow[];
}
