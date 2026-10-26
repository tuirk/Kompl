import { randomBytes } from 'node:crypto';

/**
 * Text from the user's saved sources, and the pages compiled from them, was
 * written by whoever wrote those pages: it can say "ignore your instructions"
 * as easily as anything else. Tool results put that text between tags so the
 * agent can tell it from Kompl's own lines, and the server instructions say
 * to read it as data, never as instructions.
 *
 * The tag ends in a random code chosen for each result, which the text can't
 * know, and any copy of the tag inside the text is broken ("<" becomes
 * "&lt;"), so no text can close the fence early. A copy hidden by zero-width
 * characters, other dashes, wide or look-alike letters, or an "&lt;" entity
 * counts too. Nothing else changes: quotes, [n] markers and source lists
 * reach the agent word for word.
 * (Encoding or marking the text itself, which resists injection better,
 * would break those quotes, so it is not done.)
 */
export const FENCE_TAG = 'wiki-data';

/** "<wiki-data", "</ Wiki_Data", "< /wiki data", "<\/wiki-data": anything an agent could take for the tag. */
const TAG_LIKE = /<[\s/\\]*wiki[\s_-]*data/g;

/** "<" written as an entity: an agent may read "&lt;/wiki-data" as the tag too. */
const LT_ENTITY = /^&(?:lt|#0*60|#x0*3c);/i;

/** Invisible characters (zero-width spaces, joiners, soft hyphens, direction marks) and combining marks. */
const INVISIBLE = /^[\p{Cf}\p{Mn}]$/u;
const DASH = /^\p{Pd}$/u;

/**
 * Characters that read as one of "<", "/", "-" or a letter of "wiki data"
 * but that NFKC leaves alone: angle quotes and brackets, other slashes and
 * dashes, and the Cyrillic and Greek letters that look like the Latin ones.
 */
const LOOK_ALIKE: Record<string, string> = {
  '\u2039': '<', '\u2329': '<', '\u3008': '<', '\u276e': '<', '\u27e8': '<',
  '\u2044': '/', '\u2215': '/', '\u29f8': '/', '\u2216': '\\', '\u2212': '-',
  '\u0430': 'a', '\u03b1': 'a', '\u0456': 'i', '\u04cf': 'i', '\u0131': 'i', '\u03b9': 'i',
  '\u043a': 'k', '\u03ba': 'k', '\u0501': 'd', '\u0442': 't', '\u03c4': 't',
  '\u0461': 'w', '\u051d': 'w', '\u03c9': 'w',
};

/** How one character reads when looking for the tag. */
function fold(ch: string): string {
  if (ch < '\u0080') return ch.toLowerCase();
  return [...ch.normalize('NFKC').toLowerCase()]
    .map((c) => (INVISIBLE.test(c) ? '' : LOOK_ALIKE[c] ?? (DASH.test(c) ? '-' : c)))
    .join('');
}

/** `body` as it reads when looking for the tag, and where each of its characters starts in `body`. */
function foldText(body: string): { folded: string; origin: number[] } {
  let folded = '';
  const origin: number[] = [];
  for (let i = 0; i < body.length; ) {
    const entity = body[i] === '&' ? LT_ENTITY.exec(body.slice(i, i + 12)) : null;
    const ch = entity ? entity[0] : String.fromCodePoint(body.codePointAt(i)!);
    for (const c of entity ? '<' : fold(ch)) {
      folded += c;
      origin.push(i);
    }
    i += ch.length;
  }
  return { folded, origin };
}

/**
 * `body` with every copy of the tag broken: its "<" becomes "&lt;", or, when
 * it already is an entity, its "&" becomes "&amp;". The search reads the text
 * folded (invisible characters dropped, NFKC, look-alikes mapped), so a tag
 * spelled with any of those is found too; only the "<" of a tag changes.
 */
function breakTags(body: string): string {
  // ASCII text without "&" reads as itself, lower-cased.
  const { folded, origin } = /[^\x00-\x7f]|&/.test(body)
    ? foldText(body)
    : { folded: body.toLowerCase(), origin: null };
  let out = '';
  let last = 0;
  for (const m of folded.matchAll(TAG_LIKE)) {
    const at = origin ? origin[m.index!] : m.index!;
    out += body.slice(last, at) + (body[at] === '&' ? '&amp;' : '&lt;');
    last = at + (body[at] === '&' ? 1 : String.fromCodePoint(body.codePointAt(at)!).length);
  }
  return out + body.slice(last);
}

/** `body` between `<wiki-data-CODE>` and `</wiki-data-CODE>` lines, with copies of the tag inside it broken. */
export function fence(body: string, code: string = randomBytes(4).toString('hex')): string {
  const tag = `${FENCE_TAG}-${code}`;
  return `<${tag}>\n${breakTags(body)}\n</${tag}>`;
}
