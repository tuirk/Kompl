/**
 * Source citations inside compiled pages.
 *
 * Stored form — what page markdown holds — is one token per cited source,
 * right after the claim: "…created in 2009.[^5624ad54-…][^fa237b2f-…]".
 * Drafting form — what the LLM reads and writes — is a short label such as
 * [S1], defined next to each source in the prompt. The draft route converts
 * labels to stored tokens before a page is saved, and stored tokens back to
 * labels when an existing page goes back to the LLM for an update, so a
 * citation keeps pointing at the same source across redrafts.
 *
 * Pages drafted before this format cite raw source UUIDs in assorted shapes:
 * "(uuid, uuid)", "[uuid]", "(Source uuid)", "(From source uuid…)",
 * "(Pre-extracted data from source uuid, [[Title]])", "(uuid, Source A)".
 * The same scanner reads those, so old pages show numbered citations without
 * being redrafted.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STORED_TOKEN = String.raw`\[\^(${UUID})\]`;
// A bracket or paren group with at least one UUID inside. [[wikilinks]] may
// appear inside a paren group (legacy "(…source uuid, [[Title]])").
const LEGACY_PAREN = String.raw`\((?:[^()\n]|\[\[[^\]\n]*\]\])*?${UUID}(?:[^()\n]|\[\[[^\]\n]*\]\])*?\)`;
const LEGACY_BRACKET = String.raw`\[(?!\[)(?!\^)[^\[\]\n]*?${UUID}[^\[\]\n]*?\]`;
const CITATION_GROUP = new RegExp(`${STORED_TOKEN}|${LEGACY_PAREN}|${LEGACY_BRACKET}`, 'gi');

// One comma-separated item of a legacy citation group: an id with an
// optional "Source" / "From source" / "Pre-extracted data from source" lead-in.
const CITATION_ITEM = new RegExp(
  String.raw`^(?:(?:pre-extracted\s+data\s+)?(?:from\s+)?sources?\s+)?${UUID}$`,
  'i',
);

/** Does this group item only label a citation (rather than carry prose)? */
function isCitationItem(item: string, isKnownTitle: (title: string) => boolean): boolean {
  const t = item.trim().replace(/[.:…]+$/, '').trim();
  if (t === '') return true;
  if (CITATION_ITEM.test(t)) return true;
  if (/^sources?\s+[a-z]$/i.test(t)) return true; // "Source A"
  if (/^\[\[[^\]]+\]\]$/.test(t)) return true; // [[Source page]]
  return isKnownTitle(t);
}

/** Placeholder pair wrapped around citation numbers until the HTML pass. */
const OPEN = '';
const CLOSE = '';

function uuidsIn(text: string): string[] {
  return (text.match(new RegExp(UUID, 'gi')) ?? []).map((u) => u.toLowerCase());
}

/**
 * Run `fn` over every citation group outside fenced code blocks and
 * frontmatter. `fn` receives the source ids in the group and returns the
 * replacement. A group whose items are all citation labels (ids, "Source A",
 * [[source page]], a known source title) is replaced whole; a group that also
 * carries prose keeps the prose and only its ids are replaced.
 */
function mapCitationGroups(
  markdown: string,
  fn: (sourceIds: string[]) => string,
  isKnownTitle: (title: string) => boolean = () => false,
): string {
  const lines = markdown.split('\n');
  let inFence = false;
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.trim() === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === '---') inFrontmatter = false;
      continue;
    }
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    lines[i] = line.replace(CITATION_GROUP, (group: string, storedId: string | undefined, offset: number) => {
      // A paren group right after "]" is a markdown link target, not a citation.
      if (group.startsWith('(') && offset > 0 && line[offset - 1] === ']') return group;
      if (storedId) return fn([storedId.toLowerCase()]);
      const ids = uuidsIn(group);
      const items = group.slice(1, -1).split(/[,;]/);
      if (items.every((item) => isCitationItem(item, isKnownTitle))) return fn(ids);
      // Mixed prose: keep the words, swap each id (and its "source" lead-in).
      return group.replace(
        new RegExp(String.raw`(?:(?:from\s+)?source\s+)?(${UUID})`, 'gi'),
        (_m, id: string) => fn([id.toLowerCase()]),
      );
    });
  }
  return lines.join('\n');
}

// ── Rendering ───────────────────────────────────────────────────────────────

export interface CitationScan {
  /** Markdown with each citation group replaced by a placeholder. */
  markdown: string;
  /** Source ids in order of first citation; index + 1 is the citation number. */
  order: string[];
}

/**
 * Replace citation groups with numbered placeholders that survive markdown
 * rendering. Pair with renderCitationMarkers() on the HTML output.
 */
export function scanCitations(
  markdown: string,
  isKnownTitle: (title: string) => boolean = () => false,
): CitationScan {
  const order: string[] = [];
  const numberOf = (id: string): number => {
    let n = order.indexOf(id);
    if (n === -1) {
      order.push(id);
      n = order.length - 1;
    }
    return n + 1;
  };
  const replaced = mapCitationGroups(
    markdown,
    (ids) => {
      const nums = [...new Set(ids.map(numberOf))];
      return `${OPEN}${nums.join(',')}${CLOSE}`;
    },
    isKnownTitle,
  );
  // Superscripts attach to the claim: drop whitespace before a marker and
  // merge adjacent markers ("[^a][^b]" → one group).
  const markdownOut = replaced
    .replace(new RegExp(`[ \\t]+${OPEN}`, 'g'), OPEN)
    .replace(new RegExp(`${CLOSE}${OPEN}`, 'g'), ',');
  return { markdown: markdownOut, order };
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Turn placeholders in rendered HTML into superscript links to the numbered
 * source list (#src-N). `titleOf` supplies the hover title for each number.
 */
export function renderCitationMarkers(html: string, titleOf: (n: number) => string): string {
  return html.replace(new RegExp(`${OPEN}([\\d,]+)${CLOSE}`, 'g'), (_m, nums: string) => {
    const unique = [...new Set(nums.split(',').map(Number))];
    const links = unique
      .map((n) => `<a href="#src-${n}" title="${escapeAttr(titleOf(n))}">${n}</a>`)
      .join('<span aria-hidden="true">,</span>');
    return `<sup class="cite">${links}</sup>`;
  });
}

/** Remove citation placeholders, e.g. from heading text shown in a TOC. */
export function stripCitationPlaceholders(text: string): string {
  return text.replace(new RegExp(`${OPEN}[\\d,]+${CLOSE}`, 'g'), '').trim();
}

/** Plain-text citations ("[1][2]") for agents and exports. */
export function citationsToText(
  markdown: string,
  isKnownTitle: (title: string) => boolean = () => false,
): CitationScan {
  const scan = scanCitations(markdown, isKnownTitle);
  const text = scan.markdown.replace(
    new RegExp(`${OPEN}([\\d,]+)${CLOSE}`, 'g'),
    (_m, nums: string) => nums.split(',').map((n) => `[${n}]`).join(''),
  );
  return { markdown: text, order: scan.order };
}

// ── Drafting ────────────────────────────────────────────────────────────────

/** "S1", "S2", … in the order given. */
export function assignCitationLabels(sourceIds: string[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const id of sourceIds) {
    const key = id.toLowerCase();
    if (!labels.has(key)) labels.set(key, `S${labels.size + 1}`);
  }
  return labels;
}

/**
 * Convert stored tokens and legacy UUID citations in an existing page into
 * the labels of the current draft. Ids the draft doesn't know get the next
 * free label and are returned in `added` so the prompt can name them.
 */
export function citationsToLabels(
  markdown: string,
  labels: Map<string, string>,
  isKnownTitle: (title: string) => boolean = () => false,
): { markdown: string; added: string[] } {
  const added: string[] = [];
  const out = mapCitationGroups(
    markdown,
    (ids) =>
      ids
        .map((id) => {
          let label = labels.get(id);
          if (!label) {
            label = `S${labels.size + 1}`;
            labels.set(id, label);
            added.push(id);
          }
          return `[${label}]`;
        })
        .join(''),
    isKnownTitle,
  );
  return { markdown: out, added };
}

/**
 * Convert the LLM's [S1]-style labels in a drafted page into stored tokens.
 * Accepts the bracket shapes models produce: [S1], [S1][S2], [S1, S2],
 * [S1; S2]. Parenthesised "(S3)" is deliberately NOT converted — it collides
 * with real text such as "Galaxy (S3)". Unknown labels are dropped.
 * Frontmatter and fenced code blocks are left alone.
 */
export function labelsToStoredCitations(markdown: string, labels: Map<string, string>): string {
  const idByLabel = new Map<string, string>();
  for (const [id, label] of labels) idByLabel.set(label.toUpperCase(), id);
  // Not followed by "(" — that would be a markdown link "[S1](…)".
  const group = /[ \t]?\[\s*(S\d+(?:\s*[,;]\s*S\d+)*)\s*\](?!\()/gi;
  const lines = markdown.split('\n');
  let inFence = false;
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.trim() === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === '---') inFrontmatter = false;
      continue;
    }
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    lines[i] = line.replace(group, (_m, inner: string) =>
      inner
        .split(/[,;]/)
        .map((l) => idByLabel.get(l.trim().toUpperCase()))
        .filter((id): id is string => Boolean(id))
        .map((id) => `[^${id}]`)
        .join(''),
    );
  }
  return lines.join('\n');
}

// A label group as the model writes it: [S1], [S1][S2], [S1, S2].
const LABEL_GROUP = String.raw`(?:\[\s*S\d+(?:\s*[,;]\s*S\d+)*\s*\])+`;
const SUBJECT_VERBS =
  'states|claims|notes|says|reports|argues|describes|mentions|adds|gives|lists|records|suggests|indicates|' +
  'asserts|contends|attributes|credits|dates|places|puts|cites|explains|writes|observes|confirms|specifies';
const LABEL_AS_SUBJECT = new RegExp(
  String.raw`(${LABEL_GROUP})(\s+)((?:also|instead|further|similarly)\s+)?(${SUBJECT_VERBS})\b`,
  'gi',
);
const LABEL_AFTER_PREPOSITION = new RegExp(String.raw`\b(according\s+to|per|in|from)(\s+)(${LABEL_GROUP})`, 'gi');

/**
 * A citation label is a footnote marker, not a word, but models sometimes
 * write "[S2] states that…" or "according to [S1]". Once labels become
 * superscripts that reads "² states that…". Give such sentences a subject
 * ("One source [S2] states…", "while a source [S1] claims…") so the label
 * goes back to being a marker. Frontmatter and fenced code are left alone.
 */
export function rewordLabelSubjects(markdown: string): { markdown: string; count: number } {
  let count = 0;
  const lines = markdown.split('\n');
  let inFence = false;
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.trim() === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === '---') inFrontmatter = false;
      continue;
    }
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !/\[\s*S\d/i.test(line)) continue;

    const subjects = new Set<string>();
    let next = line.replace(
      LABEL_AS_SUBJECT,
      (match: string, group: string, gap: string, adverb: string | undefined, verb: string, offset: number, whole: string) => {
        const before = whole.slice(0, offset);
        if (/\bsources?\s*$/i.test(before)) return match;
        count++;
        const key = group.replace(/\s+/g, '').toUpperCase();
        const multi = (group.match(/S\d+/gi) ?? []).length > 1;
        const sentenceStart =
          /^\s*(?:(?:[-*+]|\d+\.)\s+)?$/.test(before) || /[.!?]["')\]]*\s*$/.test(before);
        let lead: string;
        if (subjects.has(key)) lead = multi ? 'the same sources' : 'the same source';
        else lead = multi ? 'sources' : sentenceStart ? 'one source' : 'a source';
        subjects.add(key);
        if (sentenceStart) lead = lead[0].toUpperCase() + lead.slice(1);
        const space = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
        const agreedVerb = multi ? verb.replace(/s$/i, '') : verb;
        return `${space}${lead} ${group}${gap}${adverb ?? ''}${agreedVerb}`;
      },
    );
    next = next.replace(LABEL_AFTER_PREPOSITION, (_match: string, preposition: string, gap: string, group: string) => {
      count++;
      const multi = (group.match(/S\d+/gi) ?? []).length > 1;
      return `${preposition}${gap}${multi ? 'sources' : 'one source'} ${group}`;
    });
    lines[i] = next;
  }
  return { markdown: lines.join('\n'), count };
}

/**
 * Rewrite the dossier's "From source <id>:" block headers (emitted by
 * buildDossier and relied on by capDossierByRelevance) into the draft's
 * labels: From [S1] "Title":
 */
export function relabelDossier(
  dossier: string,
  labels: Map<string, string>,
  titleOf: (id: string) => string,
): string {
  return dossier.replace(new RegExp(String.raw`^From source (${UUID}):`, 'gim'), (_m, id: string) => {
    const key = id.toLowerCase();
    let label = labels.get(key);
    if (!label) {
      label = `S${labels.size + 1}`;
      labels.set(key, label);
    }
    return `From [${label}] "${titleOf(key).replace(/"/g, "'")}":`;
  });
}
