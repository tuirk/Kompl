/**
 * Name guard — mirror of the number rules in nlp-service/routers/resolution.py
 * (_name_tokens, _numeric_signature, _numeric_conflict, _is_token_extension).
 *
 * Entity resolution must never treat "Python 2" and "Python 3" as one thing.
 * Stored aliases created before that rule existed (e.g. "Python 3" →
 * "Python 2") are filtered with numericConflict() when they are read, so new
 * sources stop being routed to the wrong page. The rows themselves are kept.
 *
 * nlp-service/tests/fixtures/name_guard_cases.json keeps both implementations
 * equal (name-guard.test.ts and tests/test_resolution.py read it).
 */

const ROMAN = /(?<![A-Za-z0-9])[IVX]{2,}(?![A-Za-z0-9])/g;
const ROMAN_VALID = /^X{0,3}(?:IX|IV|V?I{0,3})$/;
const ROMAN_VALUES: Record<string, number> = { I: 1, V: 5, X: 10 };

function romanToInt(numeral: string): number {
  let total = 0;
  for (let i = 0; i < numeral.length; i++) {
    const value = ROMAN_VALUES[numeral[i]];
    const next = ROMAN_VALUES[numeral[i + 1]] ?? 0;
    total += next > value ? -value : value;
  }
  return total;
}

/** Lower-case word tokens; "GPT4" splits to gpt + 4, "A100" stays whole. */
export function nameTokens(name: string): string[] {
  const s = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/'s(?![\p{L}\p{N}])/gu, '')
    .replace(/(?<=[0-9]),(?=[0-9]{3}(?![0-9]))/g, '')
    .replace(/(?<=\p{L}{2})(?=[0-9])/gu, ' ');
  return s.match(/[\p{L}\p{N}]+(?:\.[0-9]+)*/gu) ?? [];
}

function numericSignature(name: string): Map<string, number> {
  const sig = new Map<string, number>();
  const add = (key: string) => sig.set(key, (sig.get(key) ?? 0) + 1);
  for (const raw of nameTokens(name)) {
    if (!/[0-9]/.test(raw)) continue;
    const tok = raw.replace(/^v(?=[0-9])/, '');
    if (/^[0-9]+(?:\.[0-9]+)*$/.test(tok)) {
      const parts = tok.split('.').map((p) => String(Number(p)));
      while (parts.length > 1 && parts[parts.length - 1] === '0') parts.pop();
      add(parts.join('.'));
    } else {
      add(tok);
    }
  }
  for (const m of name.normalize('NFKC').matchAll(ROMAN)) {
    if (ROMAN_VALID.test(m[0])) add(String(romanToInt(m[0])));
  }
  return sig;
}

function sameCounts(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * null when both names carry the same numbers; 'hard' when both carry numbers
 * that differ (Python 2 / Python 3); 'soft' when only one does (Python /
 * Python 2).
 */
export function numericConflict(a: string, b: string): 'hard' | 'soft' | null {
  const sa = numericSignature(a);
  const sb = numericSignature(b);
  if (sameCounts(sa, sb)) return null;
  return sa.size > 0 && sb.size > 0 ? 'hard' : 'soft';
}

function counts(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function isSubset(a: Map<string, number>, b: Map<string, number>): boolean {
  for (const [k, v] of a) if ((b.get(k) ?? 0) < v) return false;
  return true;
}

/** One name is the other plus extra words ("Ethereum" / "Ethereum Foundation"). */
export function isTokenExtension(a: string, b: string): boolean {
  const ta = counts(nameTokens(a));
  const tb = counts(nameTokens(b));
  if (ta.size === 0 || tb.size === 0 || sameCounts(ta, tb)) return false;
  return isSubset(ta, tb) || isSubset(tb, ta);
}
