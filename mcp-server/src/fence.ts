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
 * "&lt;"), so no text can close the fence early. Nothing else changes:
 * quotes, [n] markers and source lists reach the agent word for word.
 * (Encoding or marking the text itself, which resists injection better,
 * would break those quotes, so it is not done.)
 */
export const FENCE_TAG = 'wiki-data';

/** "<wiki-data", "</ Wiki_Data", "< /wiki data", "<\/wiki-data": anything an agent could take for the tag. */
const TAG_LIKE = /<([\s/\\]*wiki[\s_-]*data)/gi;

/** `body` between `<wiki-data-CODE>` and `</wiki-data-CODE>` lines, with copies of the tag inside it broken. */
export function fence(body: string, code: string = randomBytes(4).toString('hex')): string {
  const tag = `${FENCE_TAG}-${code}`;
  return `<${tag}>\n${body.replace(TAG_LIKE, '&lt;$1')}\n</${tag}>`;
}
