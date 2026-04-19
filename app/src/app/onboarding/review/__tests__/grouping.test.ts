import { describe, it, expect } from 'vitest';
import type { StagingRow } from '@/lib/db';
import {
  coerceToTypedRow,
  visualGroupOf,
  groupStagingRows,
  formatBytes,
  formatRelativeMtime,
  formatDate,
  VISUAL_GROUP_CONNECTOR_SLUG,
  VISUAL_GROUP_ORDER,
  type VisualGroup,
} from '../grouping';

function stagingRow(partial: Partial<StagingRow> & { stage_id: string }): StagingRow {
  return {
    stage_id: partial.stage_id,
    session_id: partial.session_id ?? 'sess-test',
    connector: partial.connector ?? 'url',
    payload: partial.payload ?? {},
    included: partial.included ?? true,
    status: partial.status ?? 'pending',
    resolved_source_id: partial.resolved_source_id ?? null,
    error_code: partial.error_code ?? null,
    error_message: partial.error_message ?? null,
    created_at: partial.created_at ?? '2026-04-19T00:00:00Z',
    ingested_at: partial.ingested_at ?? null,
  };
}

describe('coerceToTypedRow', () => {
  it('passes through a well-formed display', () => {
    const row = stagingRow({
      stage_id: 's1',
      connector: 'url',
      payload: {
        url: 'https://example.com',
        display: {
          kind: 'url',
          source_origin: 'paste',
          hostname: 'example.com',
          url: 'https://example.com',
        },
      },
    });
    const typed = coerceToTypedRow(row);
    expect(typed.display.kind).toBe('url');
    if (typed.display.kind === 'url') {
      expect(typed.display.source_origin).toBe('paste');
      expect(typed.display.hostname).toBe('example.com');
    }
  });

  it('synthesises url display from payload when display missing', () => {
    const row = stagingRow({
      stage_id: 's-legacy',
      connector: 'url',
      payload: { url: 'https://legacy.test/path' },
    });
    const typed = coerceToTypedRow(row);
    expect(typed.display.kind).toBe('url');
    if (typed.display.kind === 'url') {
      expect(typed.display.source_origin).toBe('paste');
      expect(typed.display.hostname).toBe('legacy.test');
      expect(typed.display.url).toBe('https://legacy.test/path');
    }
  });

  it('synthesises file-upload display with zeros when display missing', () => {
    const row = stagingRow({
      stage_id: 's-file-legacy',
      connector: 'file-upload',
      payload: { file_path: '/data/raw/uploads/abc-doc.pdf' },
    });
    const typed = coerceToTypedRow(row);
    expect(typed.display.kind).toBe('file-upload');
    if (typed.display.kind === 'file-upload') {
      expect(typed.display.filename).toBe('abc-doc.pdf');
      expect(typed.display.size_bytes).toBe(0);
      expect(typed.display.mtime_ms).toBe(0);
      expect(typed.display.ext).toBe('pdf');
    }
  });

  it('synthesises text display from markdown first-line excerpt', () => {
    const row = stagingRow({
      stage_id: 's-text-legacy',
      connector: 'text',
      payload: {
        markdown: '\n\n# Hello world\nThis is the second line.',
        title_hint: 'my-note.md',
      },
    });
    const typed = coerceToTypedRow(row);
    expect(typed.display.kind).toBe('text');
    // Synthesised text displays always use the Note shape (source_origin='upnote')
    // — the coercion fallback can't know if it should be a tweet.
    if (typed.display.kind === 'text' && typed.display.source_origin !== 'twitter') {
      expect(typed.display.filename).toBe('my-note.md');
      expect(typed.display.excerpt).toBe('# Hello world');
      expect(typed.display.line_count).toBeGreaterThan(0);
    }
  });

  it('handles hostname extraction for malformed URLs', () => {
    const row = stagingRow({
      stage_id: 's-bad',
      connector: 'url',
      payload: { url: 'not-a-url' },
    });
    const typed = coerceToTypedRow(row);
    if (typed.display.kind === 'url') {
      // fallback returns the raw input
      expect(typed.display.hostname).toBe('not-a-url');
    }
  });

  it('strips www. from hostname', () => {
    const row = stagingRow({
      stage_id: 's-www',
      connector: 'url',
      payload: { url: 'https://www.paulgraham.com/read.html' },
    });
    const typed = coerceToTypedRow(row);
    if (typed.display.kind === 'url') {
      expect(typed.display.hostname).toBe('paulgraham.com');
    }
  });
});

describe('visualGroupOf', () => {
  const cases: Array<{
    name: string;
    display: Record<string, unknown>;
    expected: VisualGroup;
  }> = [
    {
      name: 'url paste → url',
      display: { kind: 'url', source_origin: 'paste', hostname: 'x.com', url: 'https://x.com' },
      expected: 'url',
    },
    {
      name: 'url bookmarks → bookmarks',
      display: { kind: 'url', source_origin: 'bookmarks', hostname: 'x.com', url: 'https://x.com' },
      expected: 'bookmarks',
    },
    {
      name: 'url twitter-link → twitter-links',
      display: { kind: 'url', source_origin: 'twitter-link', hostname: 'x.com', url: 'https://x.com' },
      expected: 'twitter-links',
    },
    {
      name: 'text twitter → tweets',
      display: { kind: 'text', source_origin: 'twitter', author: '@a', excerpt: 'x', linked_count: 0 },
      expected: 'tweets',
    },
    {
      name: 'text upnote → notes',
      display: { kind: 'text', source_origin: 'upnote', filename: 'x.md', excerpt: 'x', line_count: 1 },
      expected: 'notes',
    },
    {
      name: 'text apple-notes → notes',
      display: { kind: 'text', source_origin: 'apple-notes', filename: 'x.md', excerpt: 'x', line_count: 1 },
      expected: 'notes',
    },
    {
      name: 'file-upload file → files',
      display: { kind: 'file-upload', source_origin: 'file', filename: 'a.pdf', size_bytes: 1, mtime_ms: 1, ext: 'pdf' },
      expected: 'files',
    },
    {
      name: 'file-upload apple-notes → files',
      display: { kind: 'file-upload', source_origin: 'apple-notes', filename: 'a.pdf', size_bytes: 1, mtime_ms: 1, ext: 'pdf' },
      expected: 'files',
    },
    {
      name: 'saved-link → saved-links',
      display: { kind: 'saved-link', source_origin: 'twitter-media', tweet_url: 'https://x.com/1' },
      expected: 'saved-links',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const row = coerceToTypedRow(
        stagingRow({ stage_id: 's', connector: 'url', payload: { display: c.display } })
      );
      expect(visualGroupOf(row)).toBe(c.expected);
    });
  }
});

describe('groupStagingRows', () => {
  it('buckets mixed rows into the right visual groups', () => {
    const rows: StagingRow[] = [
      stagingRow({
        stage_id: 'a',
        connector: 'url',
        payload: { display: { kind: 'url', source_origin: 'paste', hostname: 'x.com', url: 'https://x.com' } },
      }),
      stagingRow({
        stage_id: 'b',
        connector: 'url',
        payload: { display: { kind: 'url', source_origin: 'bookmarks', hostname: 'y.com', url: 'https://y.com', title: 't' } },
      }),
      stagingRow({
        stage_id: 'c',
        connector: 'file-upload',
        payload: { display: { kind: 'file-upload', source_origin: 'file', filename: 'a.pdf', size_bytes: 100, mtime_ms: 123, ext: 'pdf' } },
      }),
      stagingRow({
        stage_id: 'd',
        connector: 'text',
        payload: { display: { kind: 'text', source_origin: 'twitter', author: '@a', excerpt: 'x', linked_count: 0 } },
      }),
      stagingRow({
        stage_id: 'e',
        connector: 'saved-link',
        payload: { display: { kind: 'saved-link', source_origin: 'twitter-media', tweet_url: 'https://x.com/1' } },
      }),
    ];
    const grouped = groupStagingRows(rows);
    expect(grouped.url).toHaveLength(1);
    expect(grouped.bookmarks).toHaveLength(1);
    expect(grouped.files).toHaveLength(1);
    expect(grouped.tweets).toHaveLength(1);
    expect(grouped['saved-links']).toHaveLength(1);
    expect(grouped.notes).toHaveLength(0);
    expect(grouped['twitter-links']).toHaveLength(0);
  });

  it('fallbacks for rows missing display still bucket correctly', () => {
    const rows: StagingRow[] = [
      stagingRow({ stage_id: 'leg-1', connector: 'url', payload: { url: 'https://legacy.test' } }),
      stagingRow({ stage_id: 'leg-2', connector: 'file-upload', payload: { file_path: '/x/y.pdf' } }),
      stagingRow({ stage_id: 'leg-3', connector: 'text', payload: { markdown: 'a note' } }),
    ];
    const grouped = groupStagingRows(rows);
    expect(grouped.url).toHaveLength(1);
    expect(grouped.files).toHaveLength(1);
    expect(grouped.notes).toHaveLength(1);
  });
});

describe('VISUAL_GROUP_CONNECTOR_SLUG', () => {
  it('every visual group resolves to a known connector slug', () => {
    // Known connectors per /onboarding/[connector]/page.tsx CONNECTOR_COMPONENTS map.
    const knownSlugs = new Set([
      'url', 'file-upload', 'bookmarks', 'twitter', 'upnote', 'apple-notes',
    ]);
    for (const group of VISUAL_GROUP_ORDER) {
      const slug = VISUAL_GROUP_CONNECTOR_SLUG[group];
      expect(knownSlugs.has(slug)).toBe(true);
    }
  });
});

describe('format helpers', () => {
  it('formatBytes', () => {
    expect(formatBytes(0)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('formatRelativeMtime buckets to humanized ranges', () => {
    const now = 1_700_000_000_000;
    expect(formatRelativeMtime(0, now)).toBe('—');
    expect(formatRelativeMtime(now - 30_000, now)).toBe('just now');
    expect(formatRelativeMtime(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(formatRelativeMtime(now - 2 * 3600_000, now)).toBe('2 hours ago');
    expect(formatRelativeMtime(now - 3 * 86400_000, now)).toBe('3 days ago');
    expect(formatRelativeMtime(now - 14 * 86400_000, now)).toBe('2 weeks ago');
  });

  it('formatDate ignores malformed iso', () => {
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('')).toBe('');
    // valid ISO should at least contain the year
    expect(formatDate('2024-03-14T12:00:00Z')).toContain('2024');
  });
});
