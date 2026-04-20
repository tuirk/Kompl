/**
 * NLP-service convert helpers — called by the ingest-* pipeline steps
 * (ingest-urls, ingest-files) of the unified compile pipeline.
 *
 * Every function resolves to a discriminated union (never throws) so callers
 * can handle the code-paths linearly without try/catch around each invocation.
 */

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConvertResponse {
  source_id: string;
  source_type: string;
  title: string;
  source_url: string | null;
  markdown: string;
  content_hash: string;
  metadata: Record<string, unknown>;
}

export type ConvertErrorCode = 'nlp_unreachable' | 'nlp_convert_failed';

export type ConvertResult =
  | { ok: true; data: ConvertResponse }
  | { ok: false; code: ConvertErrorCode; detail: string };

export interface MetadataPeek {
  title: string | null;
  description: string | null;
  og_image: string | null;
}

// ---------------------------------------------------------------------------
// URL classification
// ---------------------------------------------------------------------------

export function isYouTubeUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?(youtube\.com\/watch|youtu\.be\/)/.test(url);
}

// ---------------------------------------------------------------------------
// Convert calls
// ---------------------------------------------------------------------------

export async function callConvertUrl(
  sourceId: string,
  url: string
): Promise<ConvertResult> {
  let res: Response;
  try {
    res = await fetch(`${NLP_SERVICE_URL}/convert/url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_id: sourceId, url }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return {
      ok: false,
      code: 'nlp_unreachable',
      detail: e instanceof Error ? e.message : 'fetch failed',
    };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const code: ConvertErrorCode =
      res.status >= 502 && res.status <= 504 ? 'nlp_unreachable' : 'nlp_convert_failed';
    return { ok: false, code, detail: `${res.status} ${detail}`.trim() };
  }
  return { ok: true, data: (await res.json()) as ConvertResponse };
}

export async function callConvertFilePath(
  sourceId: string,
  filePath: string,
  titleHint?: string
): Promise<ConvertResult> {
  let res: Response;
  try {
    res = await fetch(`${NLP_SERVICE_URL}/convert/file-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_id: sourceId,
        file_path: filePath,
        title_hint: titleHint,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return {
      ok: false,
      code: 'nlp_unreachable',
      detail: e instanceof Error ? e.message : 'fetch failed',
    };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const code: ConvertErrorCode =
      res.status >= 502 && res.status <= 504 ? 'nlp_unreachable' : 'nlp_convert_failed';
    return { ok: false, code, detail: `${res.status} ${detail}`.trim() };
  }
  return { ok: true, data: (await res.json()) as ConvertResponse };
}

/**
 * Best-effort og-tag fetch for URLs whose primary conversion failed.
 * Always resolves — never throws — so the failure path stays linear.
 * 3.5s timeout (shorter than the convert timeout) so a deeply-stuck peek
 * can't extend the failure reporting window meaningfully.
 */
export async function peekMetadata(url: string): Promise<MetadataPeek> {
  const empty: MetadataPeek = { title: null, description: null, og_image: null };
  try {
    const res = await fetch(`${NLP_SERVICE_URL}/metadata/peek`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(3_500),
    });
    if (!res.ok) return empty;
    return (await res.json()) as MetadataPeek;
  } catch {
    return empty;
  }
}
