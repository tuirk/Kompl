/**
 * Whether a browser sent this request from another site.
 *
 * The /api/* routes have no login: Kompl is single-user and bound to
 * localhost. A web page the user happens to visit could still POST to them,
 * so routes that can start paid work, or switch that on, refuse cross-site
 * requests. Requests without an Origin header (the MCP server, the CLI,
 * curl) don't come from a web page and pass.
 */
export function isCrossSiteRequest(request: Request): boolean {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return true;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers.get('host');
  } catch {
    return true;
  }
}
