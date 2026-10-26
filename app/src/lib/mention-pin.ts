/**
 * The name a source's mention and relation rows carry.
 *
 * At extract time (buildMentionPin): an existing entity or concept page whose
 * title is the name, in any case, comes first: the wiki's page is
 * authoritative, so a stored alias never sends its own title elsewhere
 * ("Ethereum" stays on the Ethereum page though an old alias maps it to
 * "Ethereum Foundation"). The resolver binds an exact page title first in
 * the same way. Otherwise the newest active alias for the name applies
 * (getAliases() is oldest first), else the name as written.
 *
 * After resolve (buildResolverPin): the resolver's groups decide, and the
 * extract-time pin covers the names no group holds.
 */

/** How names are compared: NFKC, trimmed, lower case. */
export const mentionKey = (name: string): string => name.normalize('NFKC').trim().toLowerCase();

export function buildMentionPin(
  pageTitles: Array<{ title: string }>,
  aliases: Array<{ alias: string; canonical_name: string }>
): (name: string) => string {
  const titles = new Map<string, string>();
  for (const { title } of pageTitles) if (!titles.has(mentionKey(title))) titles.set(mentionKey(title), title);
  const aliasMap = new Map<string, string>();
  for (const { alias, canonical_name } of aliases) aliasMap.set(mentionKey(alias), canonical_name);
  return (name: string) => titles.get(mentionKey(name)) ?? aliasMap.get(mentionKey(name)) ?? name;
}

/**
 * Kinds one resolver group may hold together. Mirrors _COMPATIBLE_TYPE_GROUPS
 * in nlp-service/routers/resolution.py.
 */
export const KIND_FAMILIES: ReadonlyArray<readonly string[]> = [['ORG', 'PRODUCT'], ['CONCEPT', 'OTHER']];

const kindFamily = (kind: string): string => {
  const k = kind.trim();
  return KIND_FAMILIES.find((f) => f.includes(k))?.join('|') ?? k;
};

/** A group as /api/compile/resolve returns it. */
export interface ResolverGroup {
  canonical: string;
  type: string;
  aliases: string[];
  source_ids: string[];
}

/**
 * The canonical each source's names take after resolve. For a source, a name
 * takes the canonical of the group holding that name with that source,
 * preferring a group of the name's own kind (an ORG "Chrome" and a CONCEPT
 * "Chrome" of one source can be two groups); with no kind (a relation end),
 * the first such group. A name no group holds with the source (a relation
 * end the source never listed as an entity) takes the canonical every group
 * holding the name agrees on, else `fallback` (buildMentionPin, with the
 * aliases resolve has just stored).
 */
export function buildResolverPin(
  groups: ResolverGroup[],
  fallback: (name: string) => string
): (sourceId: string) => (name: string, kind?: string) => string {
  const bySource = new Map<string, Map<string, Array<{ canonical: string; family: string }>>>();
  const session = new Map<string, { canonical: string; agreed: boolean }>();
  for (const g of groups) {
    const family = kindFamily(g.type ?? '');
    for (const name of new Set([g.canonical, ...g.aliases].map(mentionKey))) {
      for (const sid of g.source_ids) {
        const names = bySource.get(sid) ?? new Map<string, Array<{ canonical: string; family: string }>>();
        bySource.set(sid, names);
        names.set(name, [...(names.get(name) ?? []), { canonical: g.canonical, family }]);
      }
      const held = session.get(name);
      if (!held) session.set(name, { canonical: g.canonical, agreed: true });
      else if (mentionKey(held.canonical) !== mentionKey(g.canonical)) held.agreed = false;
    }
  }
  return (sourceId) => (name, kind) => {
    const key = mentionKey(name);
    const claims = bySource.get(sourceId)?.get(key);
    if (claims) {
      const own = kind === undefined ? undefined : claims.find((c) => c.family === kindFamily(kind));
      return (own ?? claims[0]).canonical;
    }
    const held = session.get(key);
    return held?.agreed ? held.canonical : fallback(name);
  };
}
