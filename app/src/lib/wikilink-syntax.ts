/**
 * Wikilink syntax shared by every reader of page markdown: rendering, link
 * sync (page_links) and plain-text stripping. Keep all parsing here so the
 * three can never disagree again.
 *
 *   [[Target]]          link to the page titled Target, shown as "Target"
 *   [[Target|label]]    same target, shown as "label". The deterministic
 *                       injector (wikilink-injector.ts) writes this form when
 *                       the matched surface text differs from the canonical
 *                       title, e.g. [[Ethereum Foundation|Ethereum]].
 */

const WIKILINK_SOURCE = String.raw`\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]`;

export interface Wikilink {
  /** Canonical page title the link points at. */
  target: string;
  /** Text to display (the alias, or the target when there is none). */
  label: string;
}

function toWikilink(target: string, label: string | undefined): Wikilink {
  const t = target.trim();
  const l = (label ?? '').trim();
  return { target: t, label: l || t };
}

/** Replace every wikilink in `text` with the string `fn` returns for it. */
export function replaceWikilinks(text: string, fn: (link: Wikilink) => string): string {
  return text.replace(new RegExp(WIKILINK_SOURCE, 'g'), (_m, target: string, label?: string) =>
    fn(toWikilink(target, label)),
  );
}

/** Each wikilink with its position, in order of appearance. */
export function findWikilinks(text: string): Array<Wikilink & { index: number; length: number }> {
  const out: Array<Wikilink & { index: number; length: number }> = [];
  const re = new RegExp(WIKILINK_SOURCE, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ ...toWikilink(m[1], m[2]), index: m.index, length: m[0].length });
  }
  return out;
}

/** Strip wikilink syntax, keeping the display label. */
export function stripWikilinks(text: string): string {
  return replaceWikilinks(text, (l) => l.label);
}
