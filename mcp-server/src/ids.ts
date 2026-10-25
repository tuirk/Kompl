import { z } from 'zod';

/**
 * Ids that go into an app URL path. Same rule as the app's own check
 * (app/src/lib/safe-paths.ts): page slugs and source UUIDs. Checked here so
 * '..' or 'a/b' get a clear error instead of reaching another route.
 */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const RULE = 'lower-case letters, digits, - and _; at most 80 characters';

export function pageIdInput() {
  return z.string().regex(ID_RE, `page_id must be a Kompl page id (${RULE}), e.g. proof-of-work. Find page ids with search_wiki.`);
}

export function sourceIdInput() {
  return z
    .string()
    .regex(ID_RE, `source_id must be a Kompl source id (${RULE}), as source lists show it. Find source ids with list_sources.`);
}
