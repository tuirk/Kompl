import { isIP } from 'node:net';

/** The 403 message of the routes guarded below. */
export const CROSS_SITE_MESSAGE =
  "Requests from other sites, or to a host name Kompl doesn't know, are refused. To reach Kompl under your own host name, add it to KOMPL_ALLOWED_HOSTS.";

/**
 * Whether a browser sent this request from another site.
 *
 * The /api/* routes have no login: Kompl is single-user and bound to
 * localhost. A web page the user happens to visit could still POST to them,
 * so routes that can start paid work, or switch that on, refuse cross-site
 * requests. Requests without an Origin header (the MCP server, the CLI,
 * curl) don't come from a web page and pass.
 *
 * DNS rebinding: a page on evil.example whose name is then pointed at
 * 127.0.0.1 sends Origin and Host both as evil.example, so they match. A
 * browser request must therefore also reach Kompl by a host name no outside
 * DNS controls (allowedHost below), as the MCP specification asks of local
 * servers.
 */
export function isCrossSiteRequest(request: Request): boolean {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return true;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const host = request.headers.get('host');
  try {
    return new URL(origin).host !== host || !allowedHost(host);
  } catch {
    return true;
  }
}

/**
 * localhost and its subdomains, IP addresses, and the names listed in
 * KOMPL_ALLOWED_HOSTS (comma-separated, e.g. the name of your own reverse
 * proxy in front of Kompl). Ports don't matter.
 */
function allowedHost(host: string | null): boolean {
  const name = hostname(host);
  if (!name) return false;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (isIP(name.replace(/^\[|\]$/g, ''))) return true;
  const extra = (process.env.KOMPL_ALLOWED_HOSTS ?? '').split(',').map((h) => hostname(h.trim()));
  return extra.includes(name);
}

/** The lower-cased name of "host[:port]", or null when it isn't one. */
function hostname(host: string | null): string | null {
  if (!host) return null;
  try {
    return new URL(`http://${host}`).hostname || null;
  } catch {
    return null;
  }
}
