import { describe, expect, it } from 'vitest';
import {
  detectAndParse,
  detectAndParseAll,
  formatTweetMarkdown,
  type ParsedTweet,
} from '../lib/twitter-parser';

// Helpers to build GraphQL bookmark-timeline entries compactly. Shape matches
// what X's internal bookmark_timeline_v2 response delivers through exporters
// that preserve raw API responses (TweetHoarder, twitter-web-exporter).
function graphqlEnvelope(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    data: {
      bookmark_timeline_v2: {
        timeline: { instructions: [{ entries }] },
      },
    },
  });
}

function gqlTweetEntry(args: {
  rest_id: string;
  screen_name?: string;
  full_text?: string;
  note_tweet_text?: string;
  card?: { title?: string; description?: string };
}): Record<string, unknown> {
  const legacy: Record<string, unknown> = {
    id_str: args.rest_id,
    full_text: args.full_text ?? '',
    created_at: '2026-04-14T10:00:00.000Z',
  };
  const result: Record<string, unknown> = {
    rest_id: args.rest_id,
    legacy,
    core: {
      user_results: {
        result: { legacy: { screen_name: args.screen_name ?? 'someuser' } },
      },
    },
  };
  if (args.note_tweet_text) {
    result.note_tweet = {
      note_tweet_results: { result: { text: args.note_tweet_text } },
    };
  }
  if (args.card) {
    const bindings: Array<Record<string, unknown>> = [];
    if (args.card.title) {
      bindings.push({ key: 'title', value: { string_value: args.card.title } });
    }
    if (args.card.description) {
      bindings.push({
        key: 'description',
        value: { string_value: args.card.description },
      });
    }
    result.card = { legacy: { binding_values: bindings } };
  }
  return {
    content: {
      itemContent: { tweet_results: { result } },
    },
  };
}

describe('twitter-parser — GraphQL bookmark_timeline_v2', () => {
  it('promotes note_tweet body over legacy.full_text (Note Tweet recovery)', () => {
    const longBody =
      'Google DeepMind dropped a paper. '.repeat(100); // ~3200 chars
    const raw = graphqlEnvelope([
      gqlTweetEntry({
        rest_id: '2046151867177308181',
        screen_name: 'akshay_pachaar',
        full_text: 'Google DeepMind dropped a paper that should scare every agent builder.\u2026 https://t.co/abc',
        note_tweet_text: longBody,
      }),
    ]);
    const parsed = detectAndParse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text.length).toBeGreaterThan(2000);
    expect(parsed[0].text).toBe(longBody);
    expect(parsed[0].author).toBe('@akshay_pachaar');
  });

  it('extracts card title + description for Article-linked tweets', () => {
    const raw = graphqlEnvelope([
      gqlTweetEntry({
        rest_id: '2042256532927401984',
        screen_name: 'rohit4verse',
        full_text: '', // Article tweets have empty legacy.full_text
        card: {
          title: '5 pipelines I\u2019d sell today using Claude Code',
          description: 'Claude Code hit $2.5 billion ARR on its own.',
        },
      }),
    ]);
    const parsed = detectAndParse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe('');
    expect(parsed[0].card_title).toBe(
      '5 pipelines I\u2019d sell today using Claude Code'
    );
    expect(parsed[0].card_description).toBe(
      'Claude Code hit $2.5 billion ARR on its own.'
    );
  });

  it('returns short legacy.full_text unchanged for plain regular tweets', () => {
    const raw = graphqlEnvelope([
      gqlTweetEntry({
        rest_id: '100',
        screen_name: 'davidim',
        full_text: 'Introducing ABG CMO. If your CMO isn\u2019t an ABG, you\u2019re already losing',
      }),
    ]);
    const parsed = detectAndParse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe(
      'Introducing ABG CMO. If your CMO isn\u2019t an ABG, you\u2019re already losing'
    );
    expect(parsed[0].card_title).toBeUndefined();
    expect(parsed[0].card_description).toBeUndefined();
  });

  it('detectAndParseAll splits card-only tweets into `skipped`', () => {
    const raw = graphqlEnvelope([
      gqlTweetEntry({
        rest_id: '100',
        screen_name: 'davidim',
        full_text: 'regular tweet body',
      }),
      gqlTweetEntry({
        rest_id: '2042256532927401984',
        screen_name: 'rohit4verse',
        full_text: '',
        card: { title: '5 pipelines I\u2019d sell today', description: 'Claude Code hit $2.5B ARR.' },
      }),
    ]);
    const { tweets, skipped } = detectAndParseAll(raw);
    expect(tweets).toHaveLength(1);
    expect(tweets[0].text).toBe('regular tweet body');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].text).toBe('');
    expect(skipped[0].card_title).toBe('5 pipelines I\u2019d sell today');
    expect(skipped[0].tweet_url).toContain('/rohit4verse/status/2042256532927401984');
  });
});

describe('twitter-parser — Legacy / flat-array formats', () => {
  it('Legacy format promotes note_tweet when present alongside truncated full_text', () => {
    // TweetHoarder-style dump: items carry full_text + a parallel note_tweet
    // path preserving the long body.
    const longBody = 'This is the full long-form body. '.repeat(80); // ~2640 chars
    const raw = JSON.stringify([
      {
        id_str: '123',
        full_text: 'This is the first 280 characters\u2026 https://t.co/xyz',
        user: { screen_name: 'longposter' },
        created_at: '2026-04-14T10:00:00.000Z',
        note_tweet: { note_tweet_results: { result: { text: longBody } } },
      },
    ]);
    const parsed = detectAndParse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe(longBody);
    expect(parsed[0].author).toBe('@longposter');
  });

  it('Simple format falls back to legacy text when note_tweet absent', () => {
    const raw = JSON.stringify([
      { text: 'plain tweet', author: '@someone', created_at: '2026-04-14T10:00:00Z' },
    ]);
    const parsed = detectAndParse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe('plain tweet');
  });
});

describe('twitter-parser — formatTweetMarkdown', () => {
  it('renders body + Original tweet footer for a normal tweet', () => {
    const t: ParsedTweet = {
      text: 'regular body',
      author: '@alice',
      date: null,
      urls: [],
      tweet_url: 'https://twitter.com/alice/status/1',
    };
    const md = formatTweetMarkdown(t);
    expect(md).toContain('**@alice:**');
    expect(md).toContain('regular body');
    expect(md).toContain('[Original tweet](https://twitter.com/alice/status/1)');
  });

  it('appends a Linked article line when card_title is set', () => {
    const t: ParsedTweet = {
      text: '',
      author: '@bob',
      date: null,
      urls: [],
      tweet_url: 'https://twitter.com/bob/status/2',
      card_title: 'Boring Agencies',
      card_description: 'Everyone treats Claude Code like a fancy\u2026',
    };
    const md = formatTweetMarkdown(t);
    expect(md).toContain('Linked article: **Boring Agencies**');
    expect(md).toContain('Everyone treats Claude Code');
  });
});
