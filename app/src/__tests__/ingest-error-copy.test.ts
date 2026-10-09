import { describe, expect, it } from 'vitest';
import {
  extractIngestErrorCode,
  friendlyIngestError,
  ingestFailureReason,
  parseIngestError,
} from '../lib/ingest-error-copy';

describe('extractIngestErrorCode', () => {
  it('extracts the code from a wrapped FastAPI envelope', () => {
    const raw = 'nlp_convert_failed: 422 {"detail":"youtube_transcript_blocked"}';
    expect(extractIngestErrorCode(raw)).toBe('youtube_transcript_blocked');
  });

  it('extracts the code with whitespace around the colon', () => {
    const raw = 'nlp_convert_failed: 422 {"detail" : "youtube_no_transcript"}';
    expect(extractIngestErrorCode(raw)).toBe('youtube_no_transcript');
  });

  it('returns null when no envelope is present', () => {
    expect(extractIngestErrorCode('nlp_unreachable: ECONNREFUSED')).toBeNull();
    expect(extractIngestErrorCode('saved_link_no_content')).toBeNull();
    expect(extractIngestErrorCode('')).toBeNull();
  });
});

describe('friendlyIngestError', () => {
  it('maps youtube_transcript_blocked to the proxy hint', () => {
    const raw = 'nlp_convert_failed: 422 {"detail":"youtube_transcript_blocked"}';
    expect(friendlyIngestError(raw)).toBe(
      'YouTube blocked our IP — try a residential proxy'
    );
  });

  it('maps youtube_no_transcript to the no-captions copy', () => {
    const raw = 'nlp_convert_failed: 422 {"detail":"youtube_no_transcript"}';
    expect(friendlyIngestError(raw)).toBe('Video has no captions');
  });

  it('maps youtube_metadata_unavailable', () => {
    const raw = 'nlp_convert_failed: 422 {"detail":"youtube_metadata_unavailable"}';
    expect(friendlyIngestError(raw)).toBe('YouTube metadata unavailable');
  });

  it('returns null for unknown codes so callers can fall back', () => {
    const raw = 'nlp_convert_failed: 422 {"detail":"some_future_code"}';
    expect(friendlyIngestError(raw)).toBeNull();
  });

  it('returns null when the wrapper has no JSON envelope at all', () => {
    expect(friendlyIngestError('nlp_unreachable: fetch failed')).toBeNull();
    expect(friendlyIngestError('saved_link_no_content')).toBeNull();
  });
});

// The stored error behind the e2e Saved Links entry that showed raw JSON.
const RESERVED_TLD =
  'nlp_convert_failed: 502 {"detail":{"detail":"firecrawl_error","upstream_status":0,"message":"reserved_tld: .test is not resolvable on the public internet"}}';

const firecrawl = (status: number, message = 'HTTP error') =>
  `nlp_convert_failed: 502 {"detail":{"detail":"firecrawl_error","upstream_status":${status},"message":"${message}"}}`;

describe('nested and prose error shapes', () => {
  it('parses the nested Firecrawl envelope', () => {
    expect(parseIngestError(RESERVED_TLD)).toEqual({
      wrapper: 'nlp_convert_failed',
      status: 502,
      code: 'firecrawl_error',
      detail: null,
      upstreamStatus: 0,
      message: 'reserved_tld: .test is not resolvable on the public internet',
    });
    expect(extractIngestErrorCode(RESERVED_TLD)).toBe('firecrawl_error');
  });

  it('gives friendly copy for Firecrawl failures', () => {
    expect(friendlyIngestError(RESERVED_TLD)).toBe('Reserved test domain (.test) — not a real website');
    expect(friendlyIngestError(firecrawl(402))).toBe('Firecrawl credits used up');
    expect(friendlyIngestError(firecrawl(401))).toBe('Firecrawl rejected the API key');
    expect(friendlyIngestError(firecrawl(503))).toBe('Firecrawl server error — try again later');
    expect(friendlyIngestError(firecrawl(418))).toBe("Firecrawl couldn't scrape this page (HTTP 418)");
    expect(friendlyIngestError(firecrawl(200, 'firecrawl response missing data object'))).toBe(
      "Firecrawl couldn't scrape this page",
    );
    expect(friendlyIngestError('nlp_convert_failed: 504 {"detail":"firecrawl_timeout"}')).toBe(
      'Page took too long to load',
    );
    expect(friendlyIngestError('nlp_convert_failed: 502 {"detail":"firecrawl_empty_markdown"}')).toBe(
      'Page had no readable text',
    );
  });

  it('splits code-plus-prose details', () => {
    const blocked =
      'nlp_convert_failed: 422 {"detail":"url_blocked: dns_failure — URL does not resolve to a fetchable public address"}';
    expect(parseIngestError(blocked).code).toBe('url_blocked');
    expect(friendlyIngestError(blocked)).toBe("Address doesn't resolve — check the link");
    expect(
      friendlyIngestError('nlp_convert_failed: 422 {"detail":"url_blocked: private_address — URL does not resolve"}'),
    ).toBe('Private or local address — not fetched');
    expect(
      friendlyIngestError(
        'nlp_convert_failed: 422 {"detail":"conversion_failed: markitdown returned insufficient content and firecrawl is not configured"}',
      ),
    ).toBe('Page could not be read — add a Firecrawl key to fetch it');
  });

  it('handles validation arrays and broken JSON', () => {
    expect(extractIngestErrorCode('nlp_convert_failed: 422 {"detail":[{"loc":["body"]}]}')).toBe('request_invalid');
    expect(extractIngestErrorCode('nlp_convert_failed: 422 {"detail":"youtube_no_transcript"} trailing')).toBe(
      'youtube_no_transcript',
    );
  });
});

describe('ingestFailureReason', () => {
  it('always returns readable text, never JSON', () => {
    const cases: Array<[string, string]> = [
      [RESERVED_TLD, 'Reserved test domain (.test) — not a real website'],
      ['nlp_convert_timeout: The operation was aborted due to timeout', 'Timed out while fetching the page'],
      ['nlp_unreachable: fetch failed', "Kompl's NLP service was unreachable — try again"],
      ['saved_link_no_content', 'Saved link had no text to import'],
      ['media-only tweet — no text content', 'media-only tweet — no text content'],
      ['nlp_convert_failed: 500 {"detail":"Internal Server Error"}', 'Internal Server Error'],
      ['nlp_convert_failed: 422 {"detail":"some_future_code: with detail"}', 'some_future_code: with detail'],
      ['nlp_convert_failed: 500 {not json', 'Import failed'],
    ];
    for (const [raw, expected] of cases) {
      const reason = ingestFailureReason(raw);
      expect(reason).toBe(expected);
      expect(reason).not.toContain('{');
    }
  });

  it('clips long reasons to 80 characters', () => {
    const reason = ingestFailureReason(`ingest_failed: ${'x'.repeat(200)}`);
    expect(reason.length).toBe(80);
    expect(reason.endsWith('…')).toBe(true);
  });
});
