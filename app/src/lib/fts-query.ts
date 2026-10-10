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
  const tokens = tokenize(query);
  const meaningful = tokens.filter((t) => t.length > 1);
  const terms = meaningful.length > 0 ? meaningful : tokens;
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(' ');
}

/**
 * Looser companion for questions written in plain language ("who created
 * bitcoin", "how do networks agree on history"): common words are dropped and
 * a page matches if it contains ANY remaining term. buildFtsQuery requires
 * every term, so a question rarely matches anything. FTS5 rank still puts
 * pages matching more of the terms first.
 *
 * Returns null when only common words are left.
 */
export function buildFtsQueryAny(query: string): string | null {
  const terms = topicTerms(query);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(' OR ');
}

/**
 * Like buildFtsQuery (every term must match) but without common words, which
 * as prefixes match unrelated text ("who"* finds "whose"). For questions in
 * plain language. Returns null when only common words are left.
 */
export function buildFtsQueryAll(query: string): string | null {
  const terms = topicTerms(query);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(' ');
}

function tokenize(query: string): string[] {
  return query.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}

/** The words of a query that carry its topic: no common words, no one-letter fragments. */
export function topicTerms(query: string): string[] {
  return tokenize(query).filter((t) => t.length > 1 && !STOPWORDS.has(t.toLowerCase()));
}

/** English words that carry no topic in a search question. */
const STOPWORDS = new Set(
  (
    'a about after all also an and any are as at be been being but by can could did do does doing ' +
    'for from get got had has have how i if in into is it its just know me more most my no not of ' +
    'on one or other our out over said should so some such tell than that the their them then there ' +
    'these they this those to too up us use used using was we were what when where which while who ' +
    'whom whose why will with would you your'
  ).split(' ')
);
