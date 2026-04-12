/**
 * GET  /api/settings — return current settings
 * POST /api/settings — update settings
 *
 * Exposes: auto_approve (boolean), chat_provider ('gemini' | 'ollama')
 */

import { NextResponse } from 'next/server';
import { getAutoApprove, setAutoApprove, getChatProvider, setChatProvider } from '../../../lib/db';

export async function GET() {
  return NextResponse.json({
    auto_approve: getAutoApprove(),
    chat_provider: getChatProvider(),
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    auto_approve?: boolean;
    chat_provider?: string;
  };

  if (body.auto_approve === undefined && body.chat_provider === undefined) {
    return NextResponse.json({ error: 'no recognized setting field in request body' }, { status: 422 });
  }

  if (body.auto_approve !== undefined) {
    if (typeof body.auto_approve !== 'boolean') {
      return NextResponse.json({ error: 'auto_approve must be a boolean' }, { status: 422 });
    }
    setAutoApprove(body.auto_approve);
  }

  if (body.chat_provider !== undefined) {
    if (body.chat_provider !== 'gemini' && body.chat_provider !== 'ollama') {
      return NextResponse.json(
        { error: "chat_provider must be 'gemini' or 'ollama'" },
        { status: 422 },
      );
    }
    setChatProvider(body.chat_provider);
  }

  return NextResponse.json({
    auto_approve: getAutoApprove(),
    chat_provider: getChatProvider(),
  });
}
