/**
 * Which claim pairs the claim check judges (plan 3.3, owner decision D3).
 *
 * A candidate pair is two claims from different sources that share a
 * subject (WikiClaim.subjects, canonical names). Anchoring on a shared
 * subject is what makes two claims comparable at all: a contradiction needs
 * both sides to speak about the same thing (de Marneffe et al. 2008,
 * "Finding Contradictions in Text"). On top of that:
 *
 *   - a subject found in more than TOO_COMMON_SUBJECT_SHARE of all claims
 *     anchors nothing (a wiki about one company names it in most claims);
 *   - a subject anchors only when it has an entity or concept page, where a
 *     finding is shown;
 *   - each claim keeps its PAIRS_PER_CLAIM most similar claims (TF-IDF
 *     cosine over the claims' words; local, no model);
 *   - pairs whose numbers or dates differ come first (a numeric mismatch is
 *     the most common sign of a contradiction), then by similarity.
 *
 * The top pairs per claim are chosen before judged pairs are dropped, so the
 * candidate set is fixed for a given wiki and every run gets through more
 * of it: the whole-wiki check ends at zero pairs left.
 *
 * Pure: no database, no fetch.
 */

import { mentionKey } from '../mention-pin';
import { pairKey, type WikiClaim } from './claims';
import { PAIRS_PER_CLAIM, TOO_COMMON_SUBJECT_SHARE } from './limits';

export interface CandidatePair {
  pair_key: string;
  /** The pair's two claims, in no meaningful order (the runner orders them by date). */
  first: WikiClaim;
  second: WikiClaim;
  /** The shared subject the finding is shown on (its least common shared subject with a page). */
  subject: string;
  page_id: string;
  similarity: number;
  /** Each claim has a number or date the other lacks. */
  number_mismatch: boolean;
}

export interface CandidateOptions {
  /** Entity and concept pages by title (mentionKey). */
  pageBySubject: ReadonlyMap<string, { page_id: string }>;
  /** Pairs already judged (pair keys): left out of the result. */
  judged: ReadonlySet<string>;
  /**
   * A compile's claim check: only pairs with a claim from these sources
   * (the session's new sources). Absent for the whole-wiki check.
   */
  newSourceIds?: ReadonlySet<string>;
}

const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'being', 'but',
  'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how',
  'in', 'into', 'is', 'it', 'its', 'more', 'most', 'not', 'of', 'on', 'or', 'other', 'over', 'she', 'so',
  'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'to', 'up', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'will',
  'with', 'would', 'you',
]);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_WORD = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi;
const NUMBER = /\d+(?:[.,]\d+)*/g;

function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/** A number as written, without thousands separators or leading zeros ("1,200" = "1200", "08" = "8"). */
function normalNumber(raw: string): string {
  const plain = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw) ? raw.replace(/,/g, '') : raw.replace(/,/g, '.');
  const n = Number(plain);
  return Number.isFinite(n) ? String(n) : plain;
}

/** The numbers and month names a claim gives ("March 2009" → {m3, 2009}). */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(NUMBER)) out.add(normalNumber(m[0]));
  for (const m of text.matchAll(MONTH_WORD)) out.add(`m${MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1}`);
  return out;
}

/** Each side gives a number or date the other does not ("2008" / "2009"; not "2009, 21M" / "21M"). */
export function numbersDiffer(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  return [...a].some((n) => !b.has(n)) && [...b].some((n) => !a.has(n));
}

type Vector = Map<string, number>;
/** A word's claims and its weight in each, side by side. */
interface Posting {
  claims: number[];
  weights: number[];
}

/** TF-IDF vectors of the claims' texts, unit length. */
function tfidf(claims: readonly WikiClaim[]): Vector[] {
  const tokenized = claims.map((c) => words(c.text));
  const df = new Map<string, number>();
  for (const tokens of tokenized) for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = claims.length;
  return tokenized.map((tokens) => {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v: Vector = new Map();
    let norm = 0;
    for (const [t, f] of tf) {
      const w = f * (Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1);
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });
}

/**
 * A subject's claims by word, with the word's weight in each. A claim is
 * scored only against the claims it shares a subject and a word with
 * (every other one scores 0), so a subject that anchors thousands of claims
 * costs what their shared words cost, not a cosine for every pair.
 */
function wordsOf(members: readonly number[], vectors: readonly Vector[]): Map<string, Posting> {
  const byWord = new Map<string, Posting>();
  for (const j of members) {
    for (const [t, w] of vectors[j]) {
      const posting = byWord.get(t);
      if (posting) {
        posting.claims.push(j);
        posting.weights.push(w);
      } else byWord.set(t, { claims: [j], weights: [w] });
    }
  }
  return byWord;
}

/** How many claims name each subject (mentionKey). */
function subjectCounts(claims: readonly WikiClaim[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of claims) for (const s of new Set(c.subjects.map(mentionKey))) counts.set(s, (counts.get(s) ?? 0) + 1);
  return counts;
}

/** Ranked candidate pairs not judged yet: number/date mismatches first, then by similarity. */
export function findCandidatePairs(claims: readonly WikiClaim[], options: CandidateOptions): CandidatePair[] {
  const counts = subjectCounts(claims);
  const limit = claims.length * TOO_COMMON_SUBJECT_SHARE;
  // The subjects each claim may be paired on: not too common, with a page.
  const anchors = claims.map(
    (c) => new Set(c.subjects.map(mentionKey).filter((s) => (counts.get(s) ?? 0) <= limit && options.pageBySubject.has(s))),
  );
  const bySubject = new Map<string, number[]>();
  anchors.forEach((subjects, i) => {
    for (const s of subjects) {
      const list = bySubject.get(s);
      if (list) list.push(i);
      else bySubject.set(s, [i]);
    }
  });
  const vectors = tfidf(claims);
  // Built when a claim of the subject is first scored: a compile's check needs few.
  const postings = new Map<string, Map<string, Posting>>();
  const numbers = claims.map((c) => numbersIn(c.text));
  const names = new Map<string, string>();
  for (const c of claims) for (const s of c.subjects) if (!names.has(mentionKey(s))) names.set(mentionKey(s), s);
  const score = new Float64Array(claims.length);
  // The claim score[j] is being summed for, and the claim j was last ranked for.
  const scoredFor = new Int32Array(claims.length).fill(-1);
  const rankedFor = new Int32Array(claims.length).fill(-1);

  const pairs = new Map<string, CandidatePair>();
  claims.forEach((claim, i) => {
    if (anchors[i].size === 0) return;
    if (options.newSourceIds && !options.newSourceIds.has(claim.source_id)) return;
    // Its PAIRS_PER_CLAIM most similar claims from other sources, ties by
    // claim key, kept in order as they come: a subject can anchor thousands.
    const top: Array<{ j: number; similarity: number }> = [];
    const before = (j: number, similarity: number, other: { j: number; similarity: number }) =>
      similarity > other.similarity || (similarity === other.similarity && claims[j].key < claims[other.j].key);
    const rank = (j: number, similarity: number) => {
      if (rankedFor[j] === i) return;
      rankedFor[j] = i;
      if (claims[j].source_id === claim.source_id) return;
      let at = top.length;
      while (at > 0 && before(j, similarity, top[at - 1])) at--;
      if (at >= PAIRS_PER_CLAIM) return;
      top.splice(at, 0, { j, similarity });
      if (top.length > PAIRS_PER_CLAIM) top.pop();
    };
    // The cosine with each claim sharing a subject and a word, summed word by word.
    for (const s of anchors[i]) {
      let byWord = postings.get(s);
      if (!byWord) postings.set(s, (byWord = wordsOf(bySubject.get(s)!, vectors)));
      const scored: number[] = [];
      for (const [t, w] of vectors[i]) {
        const posting = byWord.get(t);
        if (!posting) continue;
        for (let k = 0; k < posting.claims.length; k++) {
          const j = posting.claims[k];
          if (rankedFor[j] === i) continue;
          if (scoredFor[j] !== i) {
            scoredFor[j] = i;
            score[j] = 0;
            scored.push(j);
          }
          score[j] += w * posting.weights[k];
        }
      }
      for (const j of scored) rank(j, score[j]);
    }
    // Claims sharing no word score 0: they fill what is left, by claim key.
    if (top.length < PAIRS_PER_CLAIM) for (const s of anchors[i]) for (const j of bySubject.get(s)!) rank(j, 0);
    for (const { j, similarity } of top) {
      const key = pairKey(claim.key, claims[j].key);
      if (pairs.has(key) || options.judged.has(key)) continue;
      // The least common subject both claims are anchored on: the most specific page.
      const subject = [...anchors[i]]
        .filter((s) => anchors[j].has(s))
        .sort((x, y) => (counts.get(x) ?? 0) - (counts.get(y) ?? 0) || (x < y ? -1 : 1))[0];
      pairs.set(key, {
        pair_key: key,
        first: claim,
        second: claims[j],
        subject: names.get(subject) ?? subject,
        page_id: options.pageBySubject.get(subject)!.page_id,
        similarity,
        number_mismatch: numbersDiffer(numbers[i], numbers[j]),
      });
    }
  });
  return [...pairs.values()].sort(
    (a, b) =>
      Number(b.number_mismatch) - Number(a.number_mismatch) ||
      b.similarity - a.similarity ||
      (a.pair_key < b.pair_key ? -1 : a.pair_key > b.pair_key ? 1 : 0),
  );
}
