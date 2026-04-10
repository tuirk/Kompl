/**
 * GET  /api/settings — return current settings
 * POST /api/settings — update settings
 *
 * Currently exposes: auto_approve (boolean)
 */

import { NextResponse } from 'next/server';
import { getAutoApprove, setAutoApprove } from '../../../lib/db';

export async function GET() {
  return NextResponse.json({ auto_approve: getAutoApprove() });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { auto_approve?: boolean };
  if (typeof body.auto_approve !== 'boolean') {
    return NextResponse.json({ error: 'auto_approve must be a boolean' }, { status: 422 });
  }
  setAutoApprove(body.auto_approve);
  return NextResponse.json({ auto_approve: body.auto_approve });
}
