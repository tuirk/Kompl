/**
 * Alias shapes the screen (alias-screen.ts) sets aside: stored aliases made
 * before schema v29 whose two names have a shape the resolver no longer
 * merges on its own, and which are clearly wrong more often than not.
 *
 *   token_extension          one name is the other plus words, and they are
 *                            not one person's shorter and fuller name
 *                            ("Ethereum" -> "Ethereum Foundation")
 *   parenthetical_expansion  "Full Name (ABBR)" against a different expansion
 *                            of ABBR ("Confidence Interval" -> "Continuous
 *                            Integration (CI)")
 *   content words differ     the names share different content words; set
 *                            aside only when the names alone are less than
 *                            0.9 alike ("English" -> "programming language"),
 *                            which needs the embedding model, so this shape
 *                            comes back as 'needs_similarity'
 *
 * Kept, whatever else holds: one spelling of a name (same letters and digits,
 * or a simple plural, not for people), the same content words ("The
 * Beatles" / "Beatles", "Zürich" / "Zurich"), a person's shorter or fuller
 * name or initials, a bracketed name against its own full name or
 * abbreviation, and names whose numbers differ (getAliases() already leaves
 * those out; see name-guard.ts). An acronym or ticker against its expansion
 * ("ETH" / "Ethereum", "LLM" / "Large language model") is kept too, unless
 * it only adds words ("AI" / "AI Act"): the Layer 3 AI check judges those
 * pairs, not the screen (acronymPair, the same pairs the resolver asks it
 * about). Spelling helpers mirror nlp-service/routers/resolution.py
 * (_skeleton, _is_simple_plural, _split_parenthetical, _is_abbreviation,
 * _initials, _person_initials, _is_acronym_pair) and
 * routers/resolution_rules.py (expansion_words, ticker_abbreviates).
 */

import { isTokenExtension, nameTokens, numericConflict } from './name-guard';

export type SuspendReason = 'token_extension' | 'parenthetical_expansion' | 'content_words';
export type AliasShape = 'keep' | 'needs_similarity' | Exclude<SuspendReason, 'content_words'>;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'for', 'in', 'on', 'at', 'to', 'by', 'with', 'from', 'as', 'via', 'vs',
]);

/** Lower-case word tokens with accents removed: "Zürich" -> ["zurich"]. */
function foldedTokens(name: string): string[] {
  return nameTokens(name.normalize('NFD').replace(/\p{M}+/gu, ''));
}

/** The name's words without stopwords, accents or case. */
export function contentWords(name: string): Set<string> {
  return new Set(foldedTokens(name).filter((t) => !STOPWORDS.has(t)));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** Case, spaces, hyphens and punctuation removed; "+" and "#" kept. */
function skeleton(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}+#]/gu, '');
}

function isSimplePlural(a: string, b: string): boolean {
  let [sa, sb] = [skeleton(a), skeleton(b)];
  if (sa.length > sb.length) {
    [a, b, sa, sb] = [b, a, sb, sa];
  }
  if (sa.length < 3) return sa.length === 2 && a === a.toUpperCase() && b === `${a}s`;
  if (sb === `${sa}s`) return !sa.endsWith('s');
  if (sb === `${sa}es`) return /(s|x|z|ch|sh)$/.test(sa);
  return sa.endsWith('y') && sb === `${sa.slice(0, -1)}ies`;
}

function splitParenthetical(name: string): { base: string; inner: string } | null {
  const m = /^(?<base>.*[^\s(])\s*\((?<inner>[^()]+)\)\s*$/u.exec(name);
  return m?.groups ? { base: m.groups.base.trim(), inner: m.groups.inner.trim() } : null;
}

/** `short` in capitals reads as an abbreviation of `long` (letters in order, first one first). */
function isAbbreviation(short: string, long: string): boolean {
  const letters = [...short.toLowerCase()].filter((c) => /\p{L}/u.test(c));
  const first = [...long.toLowerCase()].find((c) => /[\p{L}\p{N}]/u.test(c)) ?? '';
  if (letters.length < 2 || short !== short.toUpperCase() || /\s/.test(short) || letters[0] !== first) return false;
  const text = long.toLowerCase();
  let pos = 0;
  for (const c of letters) {
    pos = text.indexOf(c, pos) + 1;
    if (pos === 0) return false;
  }
  return true;
}

function initials(name: string): string | null {
  const words = name.split(/\s+/).filter(Boolean);
  return words.length < 2 ? null : words.map((w) => w[0]).join('').toUpperCase();
}

/** `other` expands `abbr` too, but is not `ownBase` (the expansion the bracket gave). */
function differentExpansion(abbr: string, ownBase: string, other: string): boolean {
  if (skeleton(other) === skeleton(abbr) || skeleton(other) === skeleton(ownBase)) return false;
  if (sameSet(contentWords(other), contentWords(ownBase))) return false;
  return initials(other) === abbr.toUpperCase() || isAbbreviation(abbr, other);
}

/** The long name's words, stopwords dropped, in order: "Generative Pre-trained Transformer" -> generative, pretrained, transformer. */
function expansionWords(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
}

/** Has a letter with a case, and every such letter is a capital (Python's str.isupper). */
function isUpper(s: string): boolean {
  return s === s.toUpperCase() && s !== s.toLowerCase();
}

/** `short` in capitals spells the initials of every word of `long`: "ML" / "Machine Learning", "LOTR" / "Lord of the Rings". */
function initialism(short: string, long: string): boolean {
  const ini = initials(long);
  return ini !== null && isUpper(short) && short.toUpperCase() === ini;
}

/** `short` is 2-6 capital letters that give `long`'s content-word initials or start its first word: "UNESCO", "ETH" / "Ethereum". */
function tickerAbbreviates(short: string, long: string): boolean {
  const s = short.trim();
  if (!/^\p{Lu}{2,6}$/u.test(s)) return false;
  const letters = s.toLowerCase();
  const words = expansionWords(long);
  if (words.length === 0) return false;
  return words.map((w) => w[0]).join('') === letters || words[0].startsWith(letters);
}

/**
 * An acronym or ticker and its expansion, either way round ("LLM" / "Large
 * language model", "LOTR" / "Lord of the Rings", "ETH" / "Ethereum"): one
 * name in capitals spells the initials of the other's words, or is 2-6
 * capital letters that give its content-word initials or start its first
 * word. Never a spelling, a plural, a name plus words ("AI" / "AI Act") or
 * names whose numbers differ. The owner decided such pairs are judged by
 * the Layer 3 AI check, and the resolver asks it about exactly these pairs
 * whatever their similarity (nlp-service routers/resolution.py
 * _is_acronym_pair; tests/fixtures/acronym_pair_cases.json holds the two to
 * the same cases), so the screen never sets one aside on similarity; a
 * bracketed abbreviation against another expansion still is
 * (parenthetical_expansion).
 */
export function acronymPair(a: string, b: string): boolean {
  if (!(initialism(a, b) || initialism(b, a) || tickerAbbreviates(a, b) || tickerAbbreviates(b, a))) return false;
  return !(
    skeleton(a) === skeleton(b) ||
    numericConflict(a, b) !== null ||
    isSimplePlural(a, b) ||
    isTokenExtension(a, b)
  );
}

/** "A. Karpathy" / "Andrej Karpathy": same surname, other names equal or initials. */
function personInitials(a: string, b: string): boolean {
  const [ta, tb] = [nameTokens(a), nameTokens(b)];
  if (ta.length !== tb.length || ta.length < 2 || ta[ta.length - 1] !== tb[tb.length - 1]) return false;
  return ta.slice(0, -1).every((x, i) => {
    const y = tb[i];
    return x === y || (x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y));
  });
}

/** One person's shorter and fuller name: every word of the shorter one, none an initial. */
function personSubset(a: string, b: string): boolean {
  const [ta, tb] = [nameTokens(a), nameTokens(b)];
  const shorter = ta.length <= tb.length ? ta : tb;
  return shorter.every((t) => t.length >= 2);
}

/** What the screen does with a stored alias -> canonical pair; `person` when either name is a PERSON. */
export function aliasShape(alias: string, canonical: string, person: boolean): AliasShape {
  if (numericConflict(alias, canonical) !== null) return 'keep';
  if (skeleton(alias) === skeleton(canonical)) return 'keep';
  if (!person && isSimplePlural(alias, canonical)) return 'keep';
  if (sameSet(contentWords(alias), contentWords(canonical))) return 'keep';

  const [pa, pc] = [splitParenthetical(alias), splitParenthetical(canonical)];
  if (pa && pc) {
    if (skeleton(pa.inner) === skeleton(pc.inner) && isAbbreviation(pa.inner, pa.base) && isAbbreviation(pc.inner, pc.base)) {
      return differentExpansion(pa.inner, pa.base, pc.base) ? 'parenthetical_expansion' : 'keep';
    }
  } else if (pa || pc) {
    const [{ base, inner }, other] = pa ? [pa, canonical] : [pc!, alias];
    if (isAbbreviation(inner, base)) {
      if (skeleton(other) === skeleton(inner) || skeleton(other) === skeleton(base)) return 'keep';
      if (sameSet(contentWords(other), contentWords(base))) return 'keep';
      if (differentExpansion(inner, base, other)) return 'parenthetical_expansion';
    }
  }

  if (person && (personInitials(alias, canonical) || (isTokenExtension(alias, canonical) && personSubset(alias, canonical)))) {
    return 'keep';
  }
  if (isTokenExtension(alias, canonical)) return 'token_extension';
  if (acronymPair(alias, canonical)) return 'keep';
  return 'needs_similarity';
}
