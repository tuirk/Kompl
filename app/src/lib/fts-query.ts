/**
 * Build an FTS5 MATCH expression from what a person typed in a search box.
 *
 * FTS5's unicode61 tokenizer indexes "SHA-256" as "sha" + "256" and
 * "bitcoin's" as "bitcoin" + "s", so the query is split the same way: every
 * run of non-letter/non-digit characters becomes a word break. (Deleting
 * the punctuation instead glued "sha-256" into "sha256", which matches
 * nothing.) One-letter fragments such as the possessive "s" are dropped
 * unless nothing else is left. Each term is quoted, so words like AND / OR /
 * NOT / NEAR are searched for instead of being read as operators, and gets a
 * trailing * for prefix matching ("cryp" finds "cryptocurrency").
 *
 * Returns null when the query has no searchable terms.
 */
export function buildFtsQuery(query: string): string | null {
  const tokens = query.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  const meaningful = tokens.filter((t) => t.length > 1);
  const terms = meaningful.length > 0 ? meaningful : tokens;
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(' ');
}
