import { describe, expect, it } from 'vitest';
import {
  extractIngestErrorCode,
  friendlyIngestError,
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
