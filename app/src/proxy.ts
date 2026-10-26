/**
 * The gate every request to Kompl passes before its route. Next.js 16 calls
 * middleware "proxy"; it runs in the Node.js runtime, so it reads process.env
 * when the request arrives.
 *
 * The /api/* routes have no login: Kompl is single-user and bound to
 * localhost. A web page the user visits can still send them a POST, because
 * route handlers read request.json() whatever the Content-Type, and a no-cors
 * text/plain POST needs no preflight. A guard on a few routes left the rest
 * open (staging and finalizing a paid compile, the spend cap, the compile
 * model), so every request that can change something is checked here, and
 * reads pass: the browser keeps their answers from the other site.
 *
 * Every request, reads included, must also name Kompl by a host it answers
 * to, which shuts out DNS rebinding (lib/same-origin.ts isKnownHost).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { CROSS_SITE_MESSAGE, isCrossSiteRequest, isKnownHost } from '@/lib/same-origin';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function proxy(request: NextRequest): NextResponse {
  if (!isKnownHost(request)) {
    return NextResponse.json({ error: 'unknown_host', message: CROSS_SITE_MESSAGE }, { status: 403 });
  }
  if (!READ_METHODS.has(request.method) && isCrossSiteRequest(request)) {
    return NextResponse.json({ error: 'cross_site', message: CROSS_SITE_MESSAGE }, { status: 403 });
  }
  return NextResponse.next();
}
