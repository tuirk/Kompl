/**
 * Pure helpers for the onboarding v2 review page.
 *
 * The review page reads collect_staging rows via GET /api/onboarding/staging.
 * Each row has a payload.display object written by the connector at stage
 * time. The display is type-specific (discriminated on `kind + source_origin`)
 * and drives how the row renders on review — URL card vs bookmark card vs
 * file card vs tweet card vs saved-link card.
 *
 * This module centralises:
 *   - Display type definitions
 *   - Visual-group classification (URLs and Bookmarks show as two groups
 *     even though both are connector='url' in the DB)
 *   - Defensive coercion for rows missing/malformed display (legacy rows
 *     lifted by the v18 migration, or any stage insert that predates
 *     Phase 2's display-schema contract)
 *   - Format helpers (file size, relative mtime, date)
 */

import type { StagingConnector, StagingRow } from '@/lib/db';

// ── Display schema (discriminated union) ──────────────────────────────────

export interface UrlPasteDisplay {
  kind: 'url';
  source_origin: 'paste';
  hostname: string;
  url: string;
}

export interface BookmarkDisplay {
  kind: 'url';
  source_origin: 'bookmarks';
  hostname: string;
  url: string;
  title?: string;
  date_saved?: string;
}

export interface TwitterLinkDisplay {
  kind: 'url';
  source_origin: 'twitter-link';
  hostname: string;
  url: string;
  linked_from_tweet?: string;
}

export interface FileDisplay {
  kind: 'file-upload';
  source_origin: 'file' | 'apple-notes';
  filename: string;
  size_bytes: number;
  mtime_ms: number;
  ext: string;
}

export interface NoteDisplay {
  kind: 'text';
  source_origin: 'upnote' | 'apple-notes';
  filename: string;
  excerpt: string;
  line_count: number;
}

export interface TweetDisplay {
  kind: 'text';
  source_origin: 'twitter';
  author: string;
  excerpt: string;
  date_saved?: string;
  tweet_url?: string;
  linked_count: number;
}

export interface SavedLinkDisplay {
  kind: 'saved-link';
  source_origin: 'twitter-media';
  tweet_url?: string;
  author?: string;
  date_saved?: string;
}

export type StagingDisplay =
  | UrlPasteDisplay
  | BookmarkDisplay
  | TwitterLinkDisplay
  | FileDisplay
  | NoteDisplay
  | TweetDisplay
  | SavedLinkDisplay;

export interface TypedStagingRow extends Omit<StagingRow, 'payload'> {
  payload: Record<string, unknown>;
  display: StagingDisplay;
}

// ── Visual groups ─────────────────────────────────────────────────────────

/**
 * URLs-pasted and bookmark-imports are both connector='url' in the DB, but
 * they're different user actions and different review-card shapes — keep
 * them as two visual groups. Twitter-linked articles split out too.
 */
export type VisualGroup =
  | 'url'
  | 'bookmarks'
  | 'twitter-links'
  | 'tweets'
  | 'notes'
  | 'files'
  | 'saved-links';

/**
 * Ordering matches the review-page render order. URLs first (user's
 * primary intent), files last (bulk container), saved-links after that
 * (lowest-value "I'll look at this later" bucket).
 */
export const VISUAL_GROUP_ORDER: readonly VisualGroup[] = [
  'url',
  'bookmarks',
  'twitter-links',
  'tweets',
  'notes',
  'files',
  'saved-links',
] as const;

export const VISUAL_GROUP_LABELS: Record<VisualGroup, string> = {
  url: 'URLs',
  bookmarks: 'Bookmarks',
  'twitter-links': 'Twitter-linked articles',
  tweets: 'Tweets',
  notes: 'Notes',
  files: 'Files',
  'saved-links': 'Saved Links',
};

/**
 * Maps a visual group back to the connector slug used in the route
 * `/onboarding/[connector]`. Drives the "+ Add more" link per group.
 *
 * Multiple visual groups from the same connector collapse to the same slug
 * (bookmarks, tweets, twitter-links, saved-links all route to their native
 * connector even if the DB connector is different).
 */
export const VISUAL_GROUP_CONNECTOR_SLUG: Record<VisualGroup, string> = {
  url: 'url',
  bookmarks: 'bookmarks',
  'twitter-links': 'twitter',
  tweets: 'twitter',
  notes: 'upnote',
  files: 'file-upload',
  'saved-links': 'twitter',
};

// ── Visual-group classification ───────────────────────────────────────────

export function visualGroupOf(row: TypedStagingRow): VisualGroup {
  const d = row.display;
  if (d.kind === 'file-upload') return 'files';
  if (d.kind === 'saved-link') return 'saved-links';
  if (d.kind === 'text' && d.source_origin === 'twitter') return 'tweets';
  if (d.kind === 'text') return 'notes';
  if (d.kind === 'url' && d.source_origin === 'bookmarks') return 'bookmarks';
  if (d.kind === 'url' && d.source_origin === 'twitter-link') return 'twitter-links';
  return 'url'; // default url/paste
}

// ── Defensive coercion for rows without a proper display ──────────────────

/**
 * Turns a raw StagingRow (payload: Record<string, unknown>) into a
 * TypedStagingRow by either accepting the existing display or synthesising
 * a minimal fallback. Never throws — the review page must render whatever
 * rows the server returns, even legacy-lifted ones without display.
 *
 * Fallback strategy per connector:
 *   - url: synthesize {kind: 'url', source_origin: 'paste', hostname, url}
 *          from payload.url
 *   - file-upload: synthesize FileDisplay with zeros for size_bytes and
 *                  mtime_ms (review renders "— · —")
 *   - text: synthesize NoteDisplay with first 120 chars of markdown
 *   - saved-link: synthesize SavedLinkDisplay from payload.url as tweet_url
 */
export function coerceToTypedRow(row: StagingRow): TypedStagingRow {
  const payload = row.payload;
  const rawDisplay = payload.display;

  // Fast path: display is already well-formed enough. Don't deeply validate —
  // if the stager wrote a display, trust it. TypeScript narrows on kind.
  if (
    typeof rawDisplay === 'object' &&
    rawDisplay !== null &&
    typeof (rawDisplay as Record<string, unknown>).kind === 'string'
  ) {
    return {
      ...row,
      payload,
      display: rawDisplay as unknown as StagingDisplay,
    };
  }

  // Fallback — build the minimum viable display from what's in payload.
  const display = synthesiseDisplay(row.connector, payload);
  return { ...row, payload, display };
}

function synthesiseDisplay(
  connector: StagingConnector,
  payload: Record<string, unknown>
): StagingDisplay {
  const url = typeof payload.url === 'string' ? payload.url : '';
  const filePath = typeof payload.file_path === 'string' ? payload.file_path : '';
  const markdown = typeof payload.markdown === 'string' ? payload.markdown : '';

  switch (connector) {
    case 'url':
      return {
        kind: 'url',
        source_origin: 'paste',
        hostname: hostnameOf(url),
        url,
      };
    case 'saved-link':
      return {
        kind: 'saved-link',
        source_origin: 'twitter-media',
        tweet_url: url || undefined,
      };
    case 'file-upload':
      return {
        kind: 'file-upload',
        source_origin: 'file',
        filename: filePath.split(/[\\/]/).pop() ?? 'file',
        size_bytes: 0,
        mtime_ms: 0,
        ext: filePath.includes('.') ? filePath.split('.').pop()?.toLowerCase() ?? '' : '',
      };
    case 'text':
    default: {
      const firstLine = markdown.split('\n').find((l) => l.trim())?.trim() ?? '';
      return {
        kind: 'text',
        source_origin: 'upnote',
        filename: typeof payload.title_hint === 'string' ? payload.title_hint : 'Note',
        excerpt: firstLine.slice(0, 120),
        line_count: markdown.split('\n').length,
      };
    }
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// ── groupStagingRows — the main entry point for the review page ───────────

export type GroupedStaging = Record<VisualGroup, TypedStagingRow[]>;

export function emptyGroups(): GroupedStaging {
  return {
    url: [],
    bookmarks: [],
    'twitter-links': [],
    tweets: [],
    notes: [],
    files: [],
    'saved-links': [],
  };
}

export function groupStagingRows(rows: readonly StagingRow[]): GroupedStaging {
  const out = emptyGroups();
  for (const row of rows) {
    const typed = coerceToTypedRow(row);
    const vg = visualGroupOf(typed);
    out[vg].push(typed);
  }
  return out;
}

// ── Format helpers (for per-item card rendering) ──────────────────────────

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatRelativeMtime(mtime_ms: number, now: number = Date.now()): string {
  if (!mtime_ms || mtime_ms <= 0) return '—';
  const diffMs = now - mtime_ms;
  if (diffMs < 0) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

export function formatDate(iso?: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch {
    return '';
  }
}
