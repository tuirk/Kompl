/**
 * POST /api/chat/save-draft
 *
 * Manually save a chat answer as a pending_approval draft in page_plans.
 * Triggered by the "Save to wiki" button on each assistant message.
 */

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { insertChatDraft } from '../../../../lib/db';
import type { Citation } from '../../../../lib/chat-types';

interface SaveDraftRequest {
  session_id: string;
  content: string;
  citations: Citation[];
}

export async function POST(request: Request) {
  const body = (await request.json()) as SaveDraftRequest;
  const { session_id, content, citations } = body;

  if (!session_id || !content) {
    return NextResponse.json({ error: 'session_id and content required' }, { status: 422 });
  }

  const title = `Chat insight: ${content.slice(0, 80).replace(/\n/g, ' ')}${content.length > 80 ? '…' : ''}`;

  const citationLines =
    citations.length > 0
      ? '\n\n---\n**Sources:**\n' +
        citations.map((c) => `- [${c.page_title}](/wiki/${c.page_id})`).join('\n')
      : '';

  const draft_content = `---
title: "${title.replace(/"/g, '\\"')}"
page_type: query-generated
category: "Chat Insights"
summary: "${content.slice(0, 200).replace(/"/g, '\\"').replace(/\n/g, ' ')}"
entities: []
---

# ${title}

${content}${citationLines}
`;

  insertChatDraft({
    plan_id: randomUUID(),
    session_id: `chat-manual-${session_id}`,
    title,
    draft_content,
  });

  return NextResponse.json({ saved: true });
}
