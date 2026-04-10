/**
 * GET /api/chat/history?session_id=xxx
 *
 * Returns the message history for a chat session.
 *
 * Response: { session_id: string, messages: ChatMessage[] }
 */

import { NextResponse } from 'next/server';
import { getChatHistory } from '@/lib/db';
import type { Citation, ChatMessage } from '@/lib/chat-types';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('session_id')?.trim();

    if (!sessionId) {
      return NextResponse.json(
        { error: 'session_id query parameter is required' },
        { status: 400 },
      );
    }

    const rows = getChatHistory(sessionId, 20);

    const messages: ChatMessage[] = rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      citations: r.citations
        ? (JSON.parse(r.citations) as Citation[])
        : [],
      created_at: r.created_at,
    }));

    return NextResponse.json({ session_id: sessionId, messages });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
