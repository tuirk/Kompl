/**
 * Friendly-copy mapping for ingest_failures.error strings.
 *
 * The raw `error` column stores the wrapper produced in compile/steps/ingest-urls.ts:
 *   `nlp_convert_failed: 422 {"detail":"<code>"}`
 *
 * — the wrapper prefix comes from callConvertUrl, and the inner JSON envelope
 * is FastAPI's default body shape for `raise HTTPException(detail=...)`. The
 * Saved Links page and the activity feed both want a short human-readable
 * reason instead of either layer of that wrapper.
 *
 * Unknown codes fall through to a `null` friendly copy so the caller can keep
 * its existing raw-truncation behaviour.
 */

const FRIENDLY: Record<string, string> = {
  youtube_transcript_blocked: 'YouTube blocked our IP — try a residential proxy',
  youtube_no_transcript: 'Video has no captions',
  youtube_metadata_unavailable: 'YouTube metadata unavailable',
};

/**
 * Extract the inner FastAPI `detail` code from a wrapped ingest error string.
 * Returns the bare code (e.g. `youtube_transcript_blocked`) or null when the
 * envelope isn't recognised.
 */
export function extractIngestErrorCode(raw: string): string | null {
  const m = raw.match(/\{"detail"\s*:\s*"([a-z0-9_]+)"\}/i);
  return m ? m[1] : null;
}

/**
 * Map a raw ingest_failures.error string to a friendly one-liner.
 * Returns null when the error doesn't map to a known code — callers should
 * fall back to whatever raw display they were doing before.
 */
export function friendlyIngestError(raw: string): string | null {
  const code = extractIngestErrorCode(raw);
  return code ? FRIENDLY[code] ?? null : null;
}
