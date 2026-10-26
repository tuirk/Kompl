/**
 * A synthetic heavy wiki for the scale tests (scale-heavy-wiki.test.ts):
 * about 800 sources (some archived), 1,500 pages over 12 categories and every
 * page type, 8,000 relation rows, 400 aliases, 6,000 wikilinks, provenance
 * and one extraction per source. Shaped like a real wiki: a few hub pages
 * carry most relations, many relation ends are names with no page, and 40%
 * of the rows predate schema v28 (description NULL, the sentence still in
 * the extraction). A seeded PRNG builds the same rows on every run.
 */

import type Database from 'better-sqlite3';
import { orderRelationPair } from '../../lib/relation-rows';

export const HEAVY = { sources: 800, relations: 8000, wikilinks: 6000 } as const;

export interface HeavyWiki {
  /** The page with the most relation rows, and how many. */
  busiestPageId: string;
  busiestRows: number;
  /** The median page among pages with any relation row. */
  medianPageId: string;
  medianRows: number;
  /** NULL-description rows whose extraction carries a sentence. */
  fillable: number;
}

/** mulberry32: small, fast and the same everywhere. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Names carry no digits, so no alias trips the numbers guard by accident.
const SYL = ['ka', 'lo', 'mi', 'ra', 'zen', 'tor', 'vel', 'qua', 'nis', 'dor', 'bel', 'sha', 'fen', 'gor', 'lu', 'tam'];
const WORDS = ['Protocol', 'Network', 'Museum', 'River', 'Theory', 'Engine', 'Festival', 'Island', 'Market', 'Library', 'Method', 'Council', 'Valley', 'Archive', 'Bridge', 'Garden'];
const CATEGORIES = ['Travel', 'AI', 'Crypto', 'Board Games', 'History', 'Biology', 'Music', 'Cooking', 'Finance', 'Physics', 'Literature', 'Sports'];
/** Non-source pages, in order: low indexes are the hubs. */
const PAGE_TYPES: Array<[string, number]> = [
  ['entity', 300], ['concept', 250], ['comparison', 40], ['overview', 30], ['original-source', 40], ['archived', 30],
];
const TYPES: Array<[string, number]> = [
  ['related_to', 0.55], ['part_of', 0.13], ['uses', 0.12], ['competes_with', 0.09], ['created_by', 0.08],
  ['contradicts', 0.01], ['influenced_by', 0.01], ['located_in', 0.01],
];

/** A distinct, digit-free name for every i below 4096. */
function name(i: number): string {
  const core = [SYL[(i >> 8) & 15], SYL[(i >> 4) & 15], SYL[i & 15]].join('');
  return `${core[0].toUpperCase()}${core.slice(1)} ${WORDS[(i * 7) % WORDS.length]}`;
}
const hex = (i: number, width = 8) => i.toString(16).padStart(width, '0');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, '-');
/** About 170 characters, the live average for a page summary. */
const summaryOf = (title: string) =>
  `${title} is covered by several sources in this wiki; this line pads the summary out to the length that a compiled page summary usually has.`;
const day = (s: number) => new Date(Date.UTC(2025, 0, 1) + s * 43_200_000).toISOString().slice(0, 19).replace('T', ' ');

export function seedHeavyWiki(db: Database.Database, seed = 20261016): HeavyWiki {
  const rand = prng(seed);
  const skew = (n: number, power: number) => Math.min(n - 1, Math.floor(n * rand() ** power));
  const run = (sql: string) => db.prepare(sql);
  const insSource = run(`INSERT INTO sources (source_id, title, source_type, source_url, content_hash, file_path, status, date_ingested, compile_status)
                         VALUES (?, ?, 'url', ?, 'sha256-heavy', ?, ?, ?, 'compiled')`);
  const insPage = run(`INSERT INTO pages (page_id, title, page_type, category, summary, content_path, source_count, last_updated)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insProv = run(`INSERT INTO provenance (source_id, page_id, content_hash, contribution_type, date_compiled) VALUES (?, ?, 'h', ?, ?)`);
  const insAlias = run('INSERT INTO aliases (alias, canonical_name, canonical_page_id) VALUES (?, ?, ?)');
  const insLink = run('INSERT OR IGNORE INTO page_links (source_page_id, target_page_id, link_type) VALUES (?, ?, ?)');
  const insRel = run(`INSERT OR IGNORE INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, description, first_seen_at)
                      VALUES (?, ?, ?, ?, ?, ?)`);
  const insMention = run('INSERT OR IGNORE INTO entity_mentions (canonical_name, source_id, entity_type) VALUES (?, ?, ?)');
  const insExtraction = run(`INSERT INTO extractions (source_id, ner_output, profile, llm_output) VALUES (?, '{"entities":[]}', 'default', ?)`);
  const category = () => (rand() < 0.08 ? null : CATEGORIES[skew(CATEGORIES.length, 1.5)]);

  const sources: Array<{ id: string; title: string; archived: boolean }> = [];
  const pages: Array<{ id: string; title: string; type: string }> = [];
  let fillable = 0;
  const rowsPerPage = new Map<string, number>();

  db.transaction(() => {
    for (let s = 0; s < HEAVY.sources; s++) {
      const src = { id: `00000000-0000-4000-8000-${hex(s, 12)}`, title: `${name(3000 + s)}: notes and a field report`, archived: s % 20 === 7 };
      sources.push(src);
      insSource.run(src.id, src.title, `https://example.com/${slug(src.title)}`, `/data/raw/${src.id}.md.gz`, src.archived ? 'archived' : 'active', day(s));
      const pid = `summary-${slug(name(3000 + s))}-${hex(s)}`;
      insPage.run(pid, src.title, 'source-summary', category(), summaryOf(src.title), `/data/pages/${pid}.md.gz`, 1, day(s));
      insProv.run(src.id, pid, 'created', day(s));
    }
    let i = 0;
    for (const [type, count] of PAGE_TYPES) {
      for (let k = 0; k < count; k++, i++) {
        const title = name(i);
        const id = `${slug(title)}-${hex(i)}`;
        // Hubs gather many sources; ~10 pages rest only on archived sources.
        const n = i < 12 ? 20 + skew(25, 1) : 1 + skew(14, 2.5);
        const onlyArchived = i % 70 === 33;
        const picked = new Set<number>();
        while (picked.size < n) {
          const s = onlyArchived ? 7 + 20 * skew(40, 1) : skew(HEAVY.sources, 1);
          picked.add(s);
        }
        insPage.run(id, title, type, category(), summaryOf(title), `/data/pages/${id}.md.gz`, picked.size, day(i));
        [...picked].forEach((s, j) => insProv.run(sources[s].id, id, j === 0 ? 'created' : 'updated', day(s)));
        pages.push({ id, title, type });
      }
    }
    insPage.run('saved-links', 'Saved Links', 'overview', null, null, '/data/pages/saved-links.md.gz', 0, day(0));

    // 400 aliases: to page titles (half pinned to the page), to names with no
    // page, numbers-guarded ones that never resolve, and to archived pages.
    const aliases: Array<{ alias: string; canonical: string; page: string | null }> = [];
    for (let k = 0; k < 400; k++) {
      let alias = name(2000 + k);
      let canonical: string;
      let page: string | null = null;
      if (k < 300) {
        const p = pages[skew(620, 1.6)];
        [canonical, page] = [p.title, p.id];
        insAlias.run(alias, canonical, k % 2 === 0 ? page : null);
      } else if (k < 360) {
        canonical = name(1000 + skew(600, 1.6));
        insAlias.run(alias, canonical, null);
      } else if (k < 380) {
        alias = `${name(2000 + k)} 3`;
        canonical = pages[k].title;
        insAlias.run(alias, canonical, null);
      } else {
        const p = pages[660 + (k - 380)];
        [canonical, page] = [p.title, p.id];
        insAlias.run(alias, canonical, null);
      }
      if (k < 300) aliases.push({ alias, canonical, page });
    }

    // Relation ends: 55% a page title (hubs first), 15% an alias of a page
    // (half stored pinned to the canonical name), 30% a name with no page.
    const end = (): { stored: string; llm: string; page: string | null } => {
      const r = rand();
      if (r < 0.55) {
        const p = pages[skew(pages.length, 2.2)];
        return { stored: p.title, llm: p.title, page: p.id };
      }
      if (r < 0.7) {
        const a = aliases[skew(aliases.length, 1.4)];
        return { stored: rand() < 0.5 ? a.canonical : a.alias, llm: a.alias, page: a.page };
      }
      const plain = name(1000 + skew(600, 1.6));
      return { stored: plain, llm: plain, page: null };
    };
    const pickType = () => {
      let r = rand();
      for (const [type, p] of TYPES) if ((r -= p) < 0) return type;
      return 'related_to';
    };
    const llm = new Map<number, Array<Record<string, string>>>();
    let inserted = 0;
    while (inserted < HEAVY.relations) {
      const s = skew(HEAVY.sources, 1.3);
      const [a, b] = [end(), end()];
      if (a.stored.toLowerCase() === b.stored.toLowerCase() || (a.page !== null && a.page === b.page)) continue;
      const type = pickType();
      const [from, to] = orderRelationPair(type, a.stored, b.stored);
      const sentence = `${a.llm} ${type.replace(/_/g, ' ')} ${b.llm}, as ${sources[s].title.slice(0, 24)} explains in its second section.`;
      const stored = rand() < 0.4 ? null : sentence;
      if (insRel.run(from, to, type, sources[s].id, stored, day(s)).changes === 0) continue;
      inserted++;
      for (const e of [a, b]) {
        if (e.page !== null) rowsPerPage.set(e.page, (rowsPerPage.get(e.page) ?? 0) + 1);
        insMention.run(e.stored, sources[s].id, e.page ? 'ORG' : 'CONCEPT');
      }
      const said = stored !== null || rand() < 0.95 ? sentence : null;
      if (stored === null && said !== null) fillable++;
      const rel: Record<string, string> = { from_entity: a.llm, to: b.llm, type };
      if (said !== null) rel.description = said;
      llm.set(s, [...(llm.get(s) ?? []), rel]);
    }
    for (let s = 0; s < HEAVY.sources; s++) {
      const relationships = llm.get(s) ?? [];
      const names = [...new Set(relationships.flatMap((r) => [r.from_entity, r.to]))];
      insExtraction.run(sources[s].id, JSON.stringify({
        entities: names.map((n) => ({ name: n, type: 'ORG', context: `${n} appears in the source.` })),
        concepts: [{ name: 'Field report', definition: 'A first-hand account.' }],
        relationships,
        key_claims: Array.from({ length: 8 }, (_, k) => `Claim ${SYL[k]} of ${sources[s].title}: a sentence long enough to look like a real claim from the text.`),
        summary: `${sources[s].title} `.repeat(12),
      }));
    }

    // Wikilinks: each source page names ~4 pages; pages name each other,
    // about half of the time both ways. Plus legacy entity-ref rows and
    // Saved Links rows, which the read model must skip.
    const ssPages = (db.prepare(`SELECT page_id FROM pages WHERE page_type = 'source-summary'`).all() as Array<{ page_id: string }>).map((r) => r.page_id);
    const wl = (x: string, y: string) => (x === y ? 0 : insLink.run(x, y, 'wikilink').changes);
    let links = 0;
    for (const ss of ssPages) for (let k = 0; k < 4; k++) links += wl(ss, pages[skew(pages.length, 1.8)].id);
    while (links < HEAVY.wikilinks) {
      const [x, y] = [pages[skew(pages.length, 1.5)].id, pages[skew(pages.length, 1.5)].id];
      links += wl(x, y);
      if (links < HEAVY.wikilinks && rand() < 0.45) links += wl(y, x);
    }
    for (let k = 0; k < 200; k++) insLink.run(pages[skew(pages.length, 1)].id, pages[skew(pages.length, 1)].id, 'entity-ref');
    for (let k = 0; k < 20; k++) insLink.run('saved-links', pages[k * 3].id, 'wikilink');
  })();

  const ranked = [...rowsPerPage].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  const [busiestPageId, busiestRows] = ranked[0];
  const [medianPageId, medianRows] = ranked[Math.floor(ranked.length / 2)];
  // The two measured pages get a real body: cited sources and wikilinks.
  const body = db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?');
  for (const pid of [busiestPageId, medianPageId]) {
    const cited = (db.prepare('SELECT source_id FROM provenance WHERE page_id = ?').all(pid) as Array<{ source_id: string }>).map((r) => r.source_id);
    const paragraphs = cited.map((sid, k) => `Paragraph ${k} links [[${pages[k % pages.length].title}]] and says something sourced [^${sid}].`);
    body.run(['---', `title: ${pid}`, '---', ...paragraphs, '', '## Contradictions', '', 'None.'].join('\n\n'), pid);
  }
  return { busiestPageId, busiestRows, medianPageId, medianRows, fillable };
}
