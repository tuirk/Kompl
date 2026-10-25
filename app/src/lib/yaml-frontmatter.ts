/**
 * YAML frontmatter field extraction — scoped to the leading `---\n...\n---`
 * envelope ONLY. Body content cannot inject metadata.
 *
 * Why this exists: drafts can embed arbitrary user-controlled text in the
 * markdown body (chat questions, scraped content). Running a multi-line
 * regex over the whole document lets a body line like `category: forged`
 * masquerade as a frontmatter field. Always parse the envelope first.
 */

/**
 * Returns the contents of the leading YAML frontmatter block (the text
 * between the opening `---` and the matching closing `---`), or null if the
 * document has no frontmatter envelope.
 *
 * The envelope MUST start at offset 0 — this matches the writer convention
 * across the codebase. Trailing whitespace on the closing fence is allowed.
 */
export function extractFrontmatter(markdown: string): string | null {
  // Anchored at start. Tolerate optional leading BOM, CRLF or LF line endings,
  // and a trailing newline after the closing fence.
  const m = markdown.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return m ? m[1] : null;
}

/**
 * Extracts a single scalar YAML field from the frontmatter envelope only.
 * Returns null if the document has no frontmatter, or if the field is
 * absent / empty / has only block-scalar continuation (which we don't
 * support — callers should keep frontmatter scalars on a single line).
 *
 * Strips matching surrounding `"..."` or `'...'` quotes. Does NOT decode
 * escape sequences (callers in this codebase don't write escaped values
 * for category/summary).
 */
export function extractFrontmatterField(
  markdown: string,
  field: string,
): string | null {
  const envelope = extractFrontmatter(markdown);
  if (envelope === null) return null;
  // Field name is provided by trusted callers — no metacharacters expected,
  // but escape defensively to avoid regex injection if that ever changes.
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}:[ \\t]*["']?(.+?)["']?[ \\t]*$`, 'm');
  const match = envelope.match(re);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * Replaces one scalar field's value inside the frontmatter envelope only;
 * the body is never touched, even when it holds a line like `category: x`.
 * `value` is written as given (callers quote it when YAML needs that). Line
 * endings are kept. Returns null if there is no envelope or the field is not
 * in it.
 */
export function replaceFrontmatterField(
  markdown: string,
  field: string,
  value: string,
): string | null {
  // Same envelope as extractFrontmatter, with the fences captured around it.
  const m = markdown.match(/^(﻿?---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/);
  if (!m) return null;
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}:[^\\r\\n]*`, 'm');
  if (!re.test(m[2])) return null;
  const envelope = m[2].replace(re, () => `${field}: ${value}`);
  return m[1] + envelope + m[3] + markdown.slice(m[0].length);
}
