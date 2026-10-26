/**
 * Friendly-copy mapping for ingest_failures.error strings.
 *
 * The raw `error` column stores the wrapper produced in compile/steps/ingest-urls.ts:
 *   `nlp_convert_failed: 422 {"detail":"<code>"}`
 *
 * — the wrapper prefix comes from callConvertUrl, and the inner JSON envelope
 * is FastAPI's default body shape for `raise HTTPException(detail=...)`.
 * nlp-service/routers/conversion.py also raises nested Firecrawl errors:
 *   `nlp_convert_failed: 502 {"detail":{"detail":"firecrawl_error","upstream_status":0,"message":"reserved_tld: …"}}`
 * and code-plus-prose details such as `{"detail":"url_blocked: dns_failure — …"}`.
 * The Saved Links page and the activity feed both want a short human-readable
 * reason instead of any layer of that wrapper.
 *
 * Unknown codes fall through to a `null` friendly copy so the caller can keep
 * its existing raw-truncation behaviour; ingestFailureReason() always returns
 * display text.
 */

const FRIENDLY: Record<string, string> = {
  youtube_transcript_blocked: 'YouTube blocked our IP — try a residential proxy',
  youtube_no_transcript: 'Video has no captions',
  youtube_metadata_unavailable: 'YouTube metadata unavailable',
  firecrawl_timeout: 'Page took too long to load',
  firecrawl_empty_markdown: 'Page had no readable text',
  conversion_failed: 'Page could not be read — add a Firecrawl key to fetch it',
};

// Reasons raised by nlp-service/services/url_safety.py.
const URL_BLOCKED: Record<string, string> = {
  dns_failure: "Address doesn't resolve — check the link",
  dns_no_results: "Address doesn't resolve — check the link",
  private_address: 'Private or local address — not fetched',
  invalid_ip: 'Private or local address — not fetched',
  host_blocked: 'Blocked host — not fetched',
  scheme_not_allowed: 'Only http and https links can be fetched',
  missing_host: 'Not a valid web address',
};

const FIRECRAWL_STATUS: Record<number, string> = {
  401: 'Firecrawl rejected the API key',
  402: 'Firecrawl credits used up',
  403: "Firecrawl can't scrape this site",
  408: 'Page took too long to load',
  429: 'Firecrawl rate limit — try again later',
};

export interface ParsedIngestError {
  /** Outer wrapper code, e.g. nlp_convert_failed, nlp_unreachable. */
  wrapper: string | null;
  /** HTTP status inside the wrapper ("… 502 {…}"). */
  status: number | null;
  /** Inner error code, e.g. firecrawl_error, youtube_no_transcript, url_blocked. */
  code: string | null;
  /** Text after "code: " in a string detail ("url_blocked: dns_failure — …"). */
  detail: string | null;
  /** upstream_status of a nested Firecrawl error. */
  upstreamStatus: number | null;
  /** Human message: a nested error's message, or a string detail that isn't a code. */
  message: string | null;
}

/** Split a stored ingest error into its wrapper and FastAPI detail parts. */
export function parseIngestError(raw: string): ParsedIngestError {
  const out: ParsedIngestError = {
    wrapper: null,
    status: null,
    code: null,
    detail: null,
    upstreamStatus: null,
    message: null,
  };
  const text = raw.trim();
  const wrapper = text.match(/^([a-z_]+):\s*(?:(\d{3})\b\s*)?/i);
  if (wrapper) {
    out.wrapper = wrapper[1].toLowerCase();
    out.status = wrapper[2] ? Number(wrapper[2]) : null;
  }
  const brace = text.indexOf('{');
  if (brace === -1) return out;

  let body: unknown;
  try {
    body = JSON.parse(text.slice(brace));
  } catch {
    const flat = text.match(/\{"detail"\s*:\s*"([a-z0-9_]+)"\}/i);
    if (flat) out.code = flat[1];
    return out;
  }
  const detail = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : undefined;
  if (typeof detail === 'string') {
    const m = detail.match(/^([a-z0-9_]+)(?::\s*([\s\S]*))?$/i);
    if (m) {
      out.code = m[1];
      out.detail = m[2]?.trim() || null;
    } else {
      out.message = detail;
    }
  } else if (Array.isArray(detail)) {
    out.code = 'request_invalid';
  } else if (detail && typeof detail === 'object') {
    const nested = detail as { detail?: unknown; upstream_status?: unknown; message?: unknown };
    if (typeof nested.detail === 'string') out.code = nested.detail;
    if (typeof nested.upstream_status === 'number') out.upstreamStatus = nested.upstream_status;
    if (typeof nested.message === 'string') out.message = nested.message;
  }
  return out;
}

/**
 * Extract the inner FastAPI `detail` code from a wrapped ingest error string.
 * Returns the bare code (e.g. `youtube_transcript_blocked`, `firecrawl_error`)
 * or null when the envelope isn't recognised.
 */
export function extractIngestErrorCode(raw: string): string | null {
  return parseIngestError(raw).code;
}

function firecrawlCopy(e: ParsedIngestError): string {
  const tld = e.message?.match(/^reserved_tld:\s*(\.?[\w-]+)/i);
  if (tld) return `Reserved test domain (${tld[1].startsWith('.') ? tld[1] : `.${tld[1]}`}) — not a real website`;
  const status = e.upstreamStatus;
  if (status && FIRECRAWL_STATUS[status]) return FIRECRAWL_STATUS[status];
  if (status && status >= 500) return 'Firecrawl server error — try again later';
  if (status && status !== 200) return `Firecrawl couldn't scrape this page (HTTP ${status})`;
  return "Firecrawl couldn't scrape this page";
}

/**
 * Map a raw ingest_failures.error string to a friendly one-liner.
 * Returns null when the error doesn't map to a known code — callers should
 * fall back to whatever raw display they were doing before.
 */
export function friendlyIngestError(raw: string): string | null {
  const e = parseIngestError(raw);
  if (!e.code) return null;
  if (e.code === 'firecrawl_error') return firecrawlCopy(e);
  if (e.code === 'url_blocked') {
    const reason = e.detail?.match(/^([a-z_]+)/i)?.[1]?.toLowerCase();
    return (reason ? URL_BLOCKED[reason] : undefined) ?? 'Link blocked — not a public web address';
  }
  return FRIENDLY[e.code] ?? null;
}

function clip(text: string, max = 80): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * Short display text for a stored ingest error — always returns something
 * readable and never raw JSON. Used by the Saved Links page and screen.
 */
export function ingestFailureReason(raw: string): string {
  const friendly = friendlyIngestError(raw);
  if (friendly) return friendly;
  const e = parseIngestError(raw);
  if (e.wrapper === 'nlp_convert_timeout') return 'Timed out while fetching the page';
  if (e.wrapper === 'nlp_unreachable') return "Kompl's NLP service was unreachable — try again";
  if (/^saved_link_no_content\b/i.test(raw.trim())) return 'Saved link had no text to import';
  if (e.message) return clip(e.message);
  if (e.code) return clip(e.detail ? `${e.code}: ${e.detail}` : e.code);
  const brace = raw.indexOf('{');
  const stripped = (brace === -1 ? raw : raw.slice(0, brace))
    .replace(/^(nlp_unreachable|nlp_convert_failed|nlp_convert_timeout):\s*(\d+\s*)?/i, '')
    .replace(/^convert_url_failed:\s*\d+\s*/i, '')
    .replace(/^ingest_failed:\s*/i, '');
  return clip(stripped) || 'Import failed';
}
