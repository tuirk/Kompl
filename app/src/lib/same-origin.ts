import { isIP } from 'node:net';

/** The 403 message of proxy.ts and the routes guarded below. */
export const CROSS_SITE_MESSAGE =
  "Requests from other sites, or to a host name Kompl doesn't know, are refused. To reach Kompl under your own host name, add it to KOMPL_ALLOWED_HOSTS.";

/**
 * Whether a browser sent this request from another site.
 *
 * The /api/* routes have no login: Kompl is single-user and bound to
 * localhost. A web page the user happens to visit could still POST to them,
 * so proxy.ts refuses every cross-site request that can change something,
 * and the routes that start paid work, or switch that on, check again.
 * Requests without an Origin header (the MCP server, the CLI,
 * curl) don't come from a web page and pass.
 *
 * DNS rebinding: a page on evil.example whose name is then pointed at
 * 127.0.0.1 sends Origin and Host both as evil.example, so they match. A
 * browser request must therefore also reach Kompl by a host name no outside
 * DNS controls (allowedHost below), as the MCP specification asks of local
 * servers.
 *
 * Behind your own reverse proxy that rewrites Host (nginx does by default),
 * Origin names the proxy and Host names Kompl. A browser's own
 * "Sec-Fetch-Site: same-origin", which no page can forge, still lets such a
 * request through.
 */
export function isCrossSiteRequest(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site === 'cross-site') return true;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const host = request.headers.get('host');
  if (site === 'same-origin' && allowedHost(host)) return false;
  try {
    return new URL(origin).host !== host || !allowedHost(host);
  } catch {
    return true;
  }
}

/**
 * Whether the request names Kompl by a host it answers to (allowedHost).
 *
 * DNS rebinding reaches more than the routes that start paid work: once
 * evil.example points at 127.0.0.1, the page on it is same-origin with
 * Kompl, so its reads carry no Origin header and could fetch /api/export or
 * any wiki page. Only the Host header gives it away, so proxy.ts checks it
 * on every request. A request without one doesn't come from a browser.
 */
export function isKnownHost(request: Request): boolean {
  const host = request.headers.get('host');
  return host === null || allowedHost(host);
}

/** Kompl's services on the compose network, which call each other by these names. */
const SERVICE_NAMES = new Set(['app', 'nlp-service', 'n8n']);

/**
 * localhost and its subdomains, IP addresses, Kompl's service names (and the
 * one APP_URL gives the app, which calls itself by it), and the names listed
 * in KOMPL_ALLOWED_HOSTS (comma-separated, e.g. the name of your own reverse
 * proxy in front of Kompl). Ports don't matter.
 */
function allowedHost(host: string | null): boolean {
  const name = hostname(host);
  if (!name) return false;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (isIP(name.replace(/^\[|\]$/g, ''))) return true;
  if (SERVICE_NAMES.has(name) || name === urlHostname(process.env.APP_URL)) return true;
  const extra = (process.env.KOMPL_ALLOWED_HOSTS ?? '').split(',').map((h) => hostname(h.trim()));
  return extra.includes(name);
}

/** The host name of a URL, or null when it isn't one. */
function urlHostname(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
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
