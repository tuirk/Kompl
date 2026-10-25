/**
 * POST /api/agent/sources — MCP add_source (lib/agent-sources.ts).
 *
 * Request: { urls: string[] } or { text: string, title?: string }, plus
 *          client (the agent's name, for the activity feed).
 * Response 200: { session_id, queued, added, already_in_wiki, blocked }
 * Errors: 403 agent_sources_disabled (off in Settings) / cross_site (sent
 *         by another web page, or to a host name Kompl doesn't know), 422 invalid_request,
 *         409 compile_running (with active_session_id and started_at; a
 *         compile left queued that nothing will start doesn't count) /
 *         page_upgrade_in_progress, 429 daily_limit,
 *         503 when the compile trigger fails (the session stays queued).
 */

import { NextResponse } from 'next/server';
import { addAgentSources } from '@/lib/agent-sources';
import { CROSS_SITE_MESSAGE, isCrossSiteRequest } from '@/lib/same-origin';

export async function POST(request: Request) {
  if (isCrossSiteRequest(request)) {
    return NextResponse.json({ error: 'cross_site', message: CROSS_SITE_MESSAGE }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json', message: 'Send a JSON body.' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'invalid_request', message: 'Send a JSON object.' }, { status: 422 });
  }
  const result = await addAgentSources(body);
  return NextResponse.json(result.body, { status: result.status });
}
