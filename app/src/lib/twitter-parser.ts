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

// ── Shape parsers ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseSimple(items: any[]): ParsedTweet[] {
  return items.map(item => {
    const text: string = item.text ?? item.content ?? '';
    return {
      text,
      author: normaliseAuthor(item.author ?? item.user ?? item.username ?? item.screen_name),
      date: toIso(item.created_at ?? item.date ?? item.timestamp ?? item.time),
      urls: extractUrls(text),
      tweet_url: item.url ?? item.tweet_url ?? item.link ?? null,
    };
  }).filter(t => t.text.trim());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseSiftly(items: any[]): ParsedTweet[] {
  return items.map(item => {
    const text: string = item.text ?? '';
    const author = normaliseAuthor(item.author ?? item.username);
    const urlsFromField: string[] = Array.isArray(item.urls)
      ? item.urls.filter((u: string) => !isTwitterUrl(u))
      : [];
    const urlsFromText = extractUrls(text);
    const allUrls = [...new Set([...urlsFromField, ...urlsFromText])];
    return {
      text,
      author,
      date: toIso(item.created_at ?? item.date),
      urls: allUrls,
      tweet_url: item.tweet_url ?? item.url ?? null,
    };
  }).filter(t => t.text.trim());
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
  return tweets.map((item: any) => {
    const text: string = item.text ?? '';
    // API v2 expands URLs in entities
    const expandedUrls: string[] = (item.entities?.urls ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((e: any) => e.expanded_url ?? e.url)
      .filter((u: string) => !isTwitterUrl(u));
    const authorId: string = item.author_id ?? '';
    const tweetUrl = authorId && item.id
      ? `https://twitter.com/i/web/status/${item.id}`
      : null;
    return {
      text,
      author: usersById[authorId] ?? null,
      date: toIso(item.created_at),
      urls: [...new Set([...expandedUrls, ...extractUrls(text)])],
      tweet_url: tweetUrl,
    };
  }).filter((t: ParsedTweet) => t.text.trim());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseLegacy(items: any[]): ParsedTweet[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return items.map(item => {
    const text: string = item.full_text ?? item.text ?? '';
    const screenName = item.user?.screen_name ?? item.user?.name ?? null;
    const tweetId = item.id_str ?? item.id;
    const tweetUrl = screenName && tweetId
      ? `https://twitter.com/${screenName.replace('@', '')}/status/${tweetId}`
      : null;
    const expandedUrls: string[] = (item.entities?.urls ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((e: any) => e.expanded_url ?? e.url)
      .filter((u: string) => !isTwitterUrl(u));
    return {
      text,
      author: normaliseAuthor(screenName),
      date: toIso(item.created_at),
      urls: [...new Set([...expandedUrls, ...extractUrls(text)])],
      tweet_url: tweetUrl,
    };
  }).filter(t => t.text.trim());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseWebExporter(items: any[]): ParsedTweet[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return items.map(item => {
    const tweet = item.tweet ?? item;
    const text: string = tweet.full_text ?? tweet.text ?? '';
    return {
      text,
      author: normaliseAuthor(tweet.user?.screen_name ?? tweet.author?.screen_name),
      date: toIso(tweet.created_at),
      urls: extractUrls(text),
      tweet_url: item.tweet_url ?? null,
    };
  }).filter(t => t.text.trim());
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
    const tweetResult =
      entry?.content?.itemContent?.tweet_results?.result;
    if (!tweetResult) continue;
    const core = tweetResult.core?.user_results?.result?.legacy ?? {};
    const legacy = tweetResult.legacy ?? tweetResult.tweet?.legacy ?? {};
    const text: string = legacy.full_text ?? legacy.text ?? '';
    if (!text.trim()) continue;
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
  parts.push(t.text);
  if (t.urls.length > 0) parts.push(`\nLinked: ${t.urls.join(', ')}`);
  if (t.tweet_url) parts.push(`\n[Original tweet](${t.tweet_url})`);
  return parts.join('\n');
}

export { isTwitterUrl };
