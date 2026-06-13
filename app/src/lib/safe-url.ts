/**
 * URL scheme allowlisting for anything rendered into href/src attributes.
 *
 * DB-sourced URLs (provenance source_url, saved-link source_url, imported
 * metadata) and markdown link targets are untrusted: scraped content, LLM
 * output, or a crafted import zip can carry `javascript:`/`data:` URLs.
 * Browsers execute those on click — classic stored XSS adjacent vector.
 *
 * Kept dependency-free so client components can import it without pulling
 * the marked bundle in.
 */

/** External links only: http(s). Returns null for anything else. */
export function safeExternalUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null;
}

/**
 * Markdown link/image targets: http(s), in-page anchors, and same-origin
 * relative paths. Protocol-relative (`//host`) is rejected — it silently
 * changes origin. Everything else (javascript:, data:, vbscript:, file:)
 * is rejected.
 */
export function safeMarkdownHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (trimmed === '') return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('#')) return trimmed;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  if (/^\.{1,2}\//.test(trimmed)) return trimmed;
  return null;
}
