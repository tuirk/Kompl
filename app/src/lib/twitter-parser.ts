/**
 * twitter-parser.ts
 *
 * Client-side JSON format detection and normalisation for Twitter/X bookmark exports.
 * Supports 7 common export shapes from browser extensions, bookmarklets, and CLI tools.
 * All parsing happens in the browser — no server-side processing needed.
 */

export interface ParsedTweet {
  text: string;
  author: string | null;       // @handle or display name, null if unknown
  date: string | null;         // ISO date string of when tweet was posted, null if unknown
  urls: string[];              // non-twitter article links extracted from tweet
  tweet_url: string | null;    // permanent link to the tweet itself
  // X has two distinct long-form formats. Note Tweets (long regular tweets, ≤25K
  // chars) live at note_tweet.note_tweet_results.result.text and are promoted
  // into `text` above when present — so consumers never see the 280-char
  // truncation that legacy.full_text carries. X Articles are a different
  // entity: the body lives behind an authenticated GraphQL call no exporter
  // makes, but the bookmark response carries a card preview (title +
  // description) which surfaces here for display-only use.
  card_title?: string;
  card_description?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isTwitterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'twitter.com' || host === 'x.com' || host === 't.co';
  } catch {
    return false;
  }
}

function toIso(value: string | number | undefined | null): string | null {
  if (value == null) return null;
  try {
    // Unix timestamp (seconds)
    if (typeof value === 'number' || /^\d{9,10}$/.test(String(value))) {
      const ts = Number(value) * 1000;
      return new Date(ts).toISOString();
    }
    const d = new Date(value as string);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
  return [...new Set(matches.filter(u => !isTwitterUrl(u)))];
}

function normaliseAuthor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.startsWith('@') ? s : `@${s}`;
}

// ── Long-form extractors ─────────────────────────────────────────────────────
// These two helpers read the "extra" body-carrying fields that exporters
// preserve from X's internal GraphQL but that earlier versions of this parser
// ignored. `noteTweetText` recovers the full body of a Note Tweet (long regular
// tweet) — legacy.full_text truncates these at 280 + t.co. `cardPreview` reads
// the link-preview card that accompanies any tweet linking to an Article, a
// YouTube video, etc.

function noteTweetText(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const nt = (obj as Record<string, unknown>).note_tweet;
  if (!nt || typeof nt !== 'object') return null;
  const results = (nt as Record<string, unknown>).note_tweet_results;
  if (!results || typeof results !== 'object') return null;
  const result = (results as Record<string, unknown>).result;
  if (!result || typeof result !== 'object') return null;
  const text = (result as Record<string, unknown>).text;
  return typeof text === 'string' && text.length > 0 ? text : null;
}

interface CardPreview {
  title?: string;
  description?: string;
}

function cardPreview(obj: unknown): CardPreview | null {
  if (!obj || typeof obj !== 'object') return null;
  const card = (obj as Record<string, unknown>).card;
  if (!card || typeof card !== 'object') return null;
  const legacy = (card as Record<string, unknown>).legacy;
  if (!legacy || typeof legacy !== 'object') return null;
  const binding = (legacy as Record<string, unknown>).binding_values;
  if (!Array.isArray(binding)) return null;
  let title: string | undefined;
  let description: string | undefined;
  for (const entry of binding as Array<Record<string, unknown>>) {
    const key = entry?.key;
    const value = entry?.value as Record<string, unknown> | undefined;
    const stringValue = value?.string_value;
    if (typeof stringValue !== 'string') continue;
    if (key === 'title') title = stringValue;
    else if (key === 'description') description = stringValue;
  }
  if (!title && !description) return null;
  return { title, description };
}

// ── Shape parsers ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseSimple(items: any[]): ParsedTweet[] {
  return items.flatMap(item => {
    const short: string = item.text ?? item.content ?? '';
    const long = noteTweetText(item);
    const text = long ?? short;
    const card = cardPreview(item);
    if (!text.trim() && !card) return [];
    return [{
      text,
      author: normaliseAuthor(item.author ?? item.user ?? item.username ?? item.screen_name),
      date: toIso(item.created_at ?? item.date ?? item.timestamp ?? item.time),
      urls: extractUrls(text),
      tweet_url: item.url ?? item.tweet_url ?? item.link ?? null,
      ...(card?.title ? { card_title: card.title } : {}),
      ...(card?.description ? { card_description: card.description } : {}),
    }];
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseSiftly(items: any[]): ParsedTweet[] {
  return items.flatMap(item => {
    const short: string = item.text ?? '';
    const long = noteTweetText(item);
    const text = long ?? short;
    const card = cardPreview(item);
    if (!text.trim() && !card) return [];
    const author = normaliseAuthor(item.author ?? item.username);
    const urlsFromField: string[] = Array.isArray(item.urls)
      ? item.urls.filter((u: string) => !isTwitterUrl(u))
      : [];
    const urlsFromText = extractUrls(text);
    const allUrls = [...new Set([...urlsFromField, ...urlsFromText])];
    return [{
      text,
      author,
      date: toIso(item.created_at ?? item.date),
      urls: allUrls,
      tweet_url: item.tweet_url ?? item.url ?? null,
      ...(card?.title ? { card_title: card.title } : {}),
      ...(card?.description ? { card_description: card.description } : {}),
    }];
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseApiV2(data: any): ParsedTweet[] {
  const tweets = data.data ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usersById: Record<string, string> = {};
  if (data.includes?.users) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const u of data.includes.users as any[]) {
      if (u.id && u.username) usersById[u.id] = `@${u.username}`;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return tweets.flatMap((item: any) => {
    const short: string = item.text ?? '';
    const long = noteTweetText(item);
    const text = long ?? short;
    const card = cardPreview(item);
    if (!text.trim() && !card) return [];
    // API v2 expands URLs in entities
    const expandedUrls: string[] = (item.entities?.urls ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((e: any) => e.expanded_url ?? e.url)
      .filter((u: string) => !isTwitterUrl(u));
    const authorId: string = item.author_id ?? '';
    const tweetUrl = authorId && item.id
      ? `https://twitter.com/i/web/status/${item.id}`
      : null;
    return [{
      text,
      author: usersById[authorId] ?? null,
      date: toIso(item.created_at),
      urls: [...new Set([...expandedUrls, ...extractUrls(text)])],
      tweet_url: tweetUrl,
      ...(card?.title ? { card_title: card.title } : {}),
      ...(card?.description ? { card_description: card.description } : {}),
    }];
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseLegacy(items: any[]): ParsedTweet[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return items.flatMap(item => {
    const short: string = item.full_text ?? item.text ?? '';
    const long = noteTweetText(item);
    const text = long ?? short;
    const card = cardPreview(item);
    if (!text.trim() && !card) return [];
    const screenName = item.user?.screen_name ?? item.user?.name ?? null;
    const tweetId = item.id_str ?? item.id;
    const tweetUrl = screenName && tweetId
      ? `https://twitter.com/${screenName.replace('@', '')}/status/${tweetId}`
      : null;
    const expandedUrls: string[] = (item.entities?.urls ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((e: any) => e.expanded_url ?? e.url)
      .filter((u: string) => !isTwitterUrl(u));
    return [{
      text,
      author: normaliseAuthor(screenName),
      date: toIso(item.created_at),
      urls: [...new Set([...expandedUrls, ...extractUrls(text)])],
      tweet_url: tweetUrl,
      ...(card?.title ? { card_title: card.title } : {}),
      ...(card?.description ? { card_description: card.description } : {}),
    }];
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseWebExporter(items: any[]): ParsedTweet[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return items.flatMap(item => {
    const tweet = item.tweet ?? item;
    const short: string = tweet.full_text ?? tweet.text ?? '';
    const long = noteTweetText(tweet);
    const text = long ?? short;
    const card = cardPreview(tweet);
    if (!text.trim() && !card) return [];
    return [{
      text,
      author: normaliseAuthor(tweet.user?.screen_name ?? tweet.author?.screen_name),
      date: toIso(tweet.created_at),
      urls: extractUrls(text),
      tweet_url: item.tweet_url ?? null,
      ...(card?.title ? { card_title: card.title } : {}),
      ...(card?.description ? { card_description: card.description } : {}),
    }];
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseGraphQL(data: any): ParsedTweet[] {
  const instructions: unknown[] =
    data.data?.bookmark_timeline_v2?.timeline?.instructions ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries: any[] = [];
  for (const inst of instructions as any[]) {
    if (Array.isArray(inst?.entries)) entries.push(...inst.entries);
  }
  const result: ParsedTweet[] = [];
  for (const entry of entries) {
    // Most long-form fields live directly on tweetResult (note_tweet, card);
    // legacy holds the short text + ids.
    const tweetResult =
      entry?.content?.itemContent?.tweet_results?.result;
    if (!tweetResult) continue;
    const core = tweetResult.core?.user_results?.result?.legacy ?? {};
    const legacy = tweetResult.legacy ?? tweetResult.tweet?.legacy ?? {};
    const long = noteTweetText(tweetResult) ?? noteTweetText(tweetResult.tweet);
    const short: string = legacy.full_text ?? legacy.text ?? '';
    const text = long ?? short;
    const card = cardPreview(tweetResult) ?? cardPreview(tweetResult.tweet);
    if (!text.trim() && !card) continue;
    const screenName = core.screen_name ?? null;
    const tweetId = legacy.id_str ?? tweetResult.rest_id;
    result.push({
      text,
      author: normaliseAuthor(screenName),
      date: toIso(legacy.created_at),
      urls: extractUrls(text),
      tweet_url: screenName && tweetId
        ? `https://twitter.com/${screenName}/status/${tweetId}`
        : null,
      ...(card?.title ? { card_title: card.title } : {}),
      ...(card?.description ? { card_description: card.description } : {}),
    });
  }
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Auto-detect the JSON format and return normalised tweets.
 * Throws with a helpful message if the format is not recognised.
 */
export function detectAndParse(raw: string): ParsedTweet[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('Not valid JSON. Make sure you uploaded the exported .json file, not HTML or a zip.');
  }

  // Envelope — recurse on inner array
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;

    // Raw GraphQL response
    if ((obj as Record<string, unknown>).data &&
        typeof (obj as Record<string, Record<string, unknown>>).data === 'object' &&
        (obj as Record<string, Record<string, unknown>>).data?.bookmark_timeline_v2) {
      return parseGraphQL(obj);
    }

    // Twitter API v2 envelope: { data: [...], includes: {...} }
    if (Array.isArray(obj.data)) {
      return parseApiV2(obj);
    }

    // Metadata envelope: { bookmarks: [...], ... }
    if (Array.isArray(obj.bookmarks)) {
      return detectAndParse(JSON.stringify(obj.bookmarks));
    }

    // Other named array fields
    for (const key of ['tweets', 'items', 'results', 'records']) {
      if (Array.isArray(obj[key])) return detectAndParse(JSON.stringify(obj[key]));
    }
  }

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(
      'Unrecognized format. Try exporting as JSON from one of the recommended tools ' +
      '(Twitter Bookmark Exporter, Siftly bookmarklet, TweetHoarder, or x-bookmarks).'
    );
  }

  const arr = data as Record<string, unknown>[];
  const first = arr[0];

  // Siftly bookmarklet: { source: 'bookmark', text, author, created_at, urls }
  if (first.source === 'bookmark' || (first.source && first.text && first.author)) {
    return parseSiftly(arr);
  }

  // Legacy full_text (TweetHoarder, v1 API)
  if (first.full_text != null) {
    return parseLegacy(arr);
  }

  // twitter-web-exporter: [{ tweet: {...} }]
  if (first.tweet && typeof first.tweet === 'object') {
    return parseWebExporter(arr);
  }

  // Simple array with text field
  if (typeof first.text === 'string') {
    return parseSimple(arr);
  }

  throw new Error(
    'Unrecognized format. Try exporting as JSON from one of the recommended tools ' +
    '(Twitter Bookmark Exporter, Siftly bookmarklet, TweetHoarder, or x-bookmarks).'
  );
}

/**
 * Format a parsed tweet as markdown for storage via connector: 'text'.
 */
export function formatTweetMarkdown(t: ParsedTweet): string {
  const parts: string[] = [];
  if (t.author) parts.push(`**${t.author}:**\n`);
  if (t.text) parts.push(t.text);
  if (t.card_title) {
    const desc = t.card_description ? ` — ${t.card_description}` : '';
    parts.push(`\nLinked article: **${t.card_title}**${desc}`);
  }
  if (t.urls.length > 0) parts.push(`\nLinked: ${t.urls.join(', ')}`);
  if (t.tweet_url) parts.push(`\n[Original tweet](${t.tweet_url})`);
  return parts.join('\n');
}

/**
 * Like detectAndParse but also returns tweets without body text.
 * Skipped items represent two cases:
 *   (1) X Articles — the tweet is a stub (empty legacy.full_text, no note_tweet)
 *       but the bookmark carries a card preview with article title + description.
 *       The parser surfaces these with card_title/card_description set.
 *   (2) Media-only tweets — no text, no card, but a tweet_url worth preserving
 *       on Saved Links so the user can reopen them later.
 * Both go to the saved-link connector rather than creating a source row.
 */
export function detectAndParseAll(
  raw: string
): { tweets: ParsedTweet[]; skipped: ParsedTweet[] } {
  const allParsed = detectAndParse(raw);

  const tweets: ParsedTweet[] = [];
  const skipped: ParsedTweet[] = [];
  for (const t of allParsed) {
    if (t.text.trim()) {
      tweets.push(t);
    } else if (t.tweet_url) {
      // Article preview (card) or anything else with no body but a permalink.
      skipped.push(t);
    }
  }

  // Additionally recover media-only tweets that the parsers dropped because
  // they had neither body text nor a card. Only applies to flat-array formats
  // (Simple, Siftly, Legacy, WebExporter) — GraphQL tweet_urls aren't on the
  // raw item.
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return { tweets, skipped }; }

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    for (const key of ['bookmarks', 'tweets', 'items', 'results', 'records']) {
      if (Array.isArray(obj[key])) { data = obj[key]; break; }
    }
  }

  if (!Array.isArray(data)) return { tweets, skipped };

  const alreadySeen = new Set(
    [...tweets, ...skipped].map((t) => t.tweet_url).filter(Boolean)
  );

  for (const item of data as Record<string, unknown>[]) {
    const text = String(item.text ?? item.full_text ?? '').trim();
    const noteLong = noteTweetText(item);
    const card = cardPreview(item);
    const url = item.tweet_url ?? item.url ?? null;
    // Only keep rows that carry no body and no card — card-bearing rows are
    // already in `skipped` via the parser path above.
    if (text || noteLong || card) continue;
    if (typeof url !== 'string' || !url) continue;
    if (alreadySeen.has(url)) continue;
    skipped.push({
      text: '',
      author: normaliseAuthor(
        String(item.author ?? item.username ??
          ((item.user as Record<string, unknown>)?.screen_name) ?? '')
      ),
      date: toIso((item.created_at ?? item.date ?? null) as string | number | null),
      urls: [],
      tweet_url: url,
    });
  }

  return { tweets, skipped };
}

export { isTwitterUrl };

// ── Bookmarklet DOM scraper ───────────────────────────────────────────────────
// Used by the twitter.com/i/bookmarks bookmarklet in twitter-connector.tsx.
// Exported and kept pure so it can be unit-tested without jsdom AND injected
// verbatim into the bookmarklet IIFE via .toString().
//
// Why a DOM walker instead of .innerText: twitter.com renders long URLs as
// <a href="https://t.co/XXX"><span>github.com/foo</span><span>…</span></a>
// with CSS-driven line wrapping, so innerText returns "github.com/foo\n…"
// with mid-URL linebreaks. We replace each anchor's visible content with its
// href (t.co wrappers are fine — downstream scrapers follow redirects).

export interface ScrapedTweetText {
  text: string;
  urls: string[];
}

// Accept anything duck-typed — the bookmarklet feeds real DOM elements,
// tests feed plain-object fakes with the same minimal shape.
type ElementLike = {
  nodeType?: number;
  tagName?: string;
  textContent?: string | null;
  childNodes?: ArrayLike<ElementLike>;
  href?: string;
  alt?: string;
};

export function scrapeTweetTextDom(root: ElementLike): ScrapedTweetText {
  const parts: string[] = [];
  const urls: string[] = [];

  function isIntraTwitter(href: string): boolean {
    try {
      const u = new URL(href, 'https://x.com');
      const host = u.host.replace(/^www\./, '');
      if (host === 'twitter.com' || host === 'x.com') {
        // Mentions/hashtags/routes live on twitter.com/x.com directly.
        return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  function walk(node: ElementLike, insideAnchor: boolean): void {
    const nt = node.nodeType;
    if (nt === 3 /* text */) {
      if (insideAnchor) return; // anchor body is visually truncated; href already emitted
      parts.push(node.textContent ?? '');
      return;
    }
    if (nt !== 1 /* element */) return;
    const tag = (node.tagName ?? '').toUpperCase();
    if (tag === 'A') {
      const href = node.href ?? '';
      if (href && !isIntraTwitter(href)) {
        parts.push(href);
        urls.push(href);
        return; // skip children — already captured as href
      }
      // Intra-twitter anchor (mention, hashtag, route): walk children as text.
      const kids = node.childNodes;
      if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i], false);
      return;
    }
    if (tag === 'IMG') {
      const alt = node.alt ?? '';
      if (alt) parts.push(alt);
      return;
    }
    if (tag === 'BR') {
      parts.push('\n');
      return;
    }
    const kids = node.childNodes;
    if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i], insideAnchor);
  }

  walk(root, false);
  return {
    text: parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    urls: [...new Set(urls)],
  };
}
