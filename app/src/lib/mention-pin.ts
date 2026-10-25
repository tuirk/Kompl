/**
 * The name a source's mention and relation rows carry (extract route).
 *
 * An existing entity or concept page whose title is the name, in any case,
 * comes first: the wiki's page is authoritative, so a stored alias never
 * sends its own title elsewhere ("Ethereum" stays on the Ethereum page
 * though an old alias maps it to "Ethereum Foundation"). The resolver binds
 * an exact page title first in the same way. Otherwise the newest active
 * alias for the name applies (getAliases() is oldest first), else the name
 * as written.
 */

const key = (name: string): string => name.normalize('NFKC').trim().toLowerCase();

export function buildMentionPin(
  pageTitles: Array<{ title: string }>,
  aliases: Array<{ alias: string; canonical_name: string }>
): (name: string) => string {
  const titles = new Map<string, string>();
  for (const { title } of pageTitles) if (!titles.has(key(title))) titles.set(key(title), title);
  const aliasMap = new Map<string, string>();
  for (const { alias, canonical_name } of aliases) aliasMap.set(key(alias), canonical_name);
  return (name: string) => titles.get(key(name)) ?? aliasMap.get(key(name)) ?? name;
}
