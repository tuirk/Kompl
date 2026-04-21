import { describe, expect, it } from 'vitest';
import {
  detectAndParse,
  detectAndParseAll,
  formatTweetMarkdown,
  scrapeTweetTextDom,
  type ParsedTweet,
} from '../lib/twitter-parser';

// Minimal duck-typed DOM builder: matches the subset of Node/Element the
// scraper reads (nodeType, tagName, childNodes, textContent, href, alt).
// Keeps the test jsdom-free.
type FakeNode = {
  nodeType: number;
  tagName?: string;
  textContent?: string;
  childNodes?: FakeNode[];
  href?: string;
  alt?: string;
};
function el(tag: string, attrs: { href?: string; alt?: string } = {}, children: FakeNode[] = []): FakeNode {
  return { nodeType: 1, tagName: tag, childNodes: children, ...attrs };
}
function tx(s: string): FakeNode {
  return { nodeType: 3, textContent: s };
}

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

describe('scrapeTweetTextDom (bookmarklet DOM walker)', () => {
  // Regression: twitter.com renders long t.co links as
  //   <a href="t.co/..."><span>github.com/foo/bar</span><span>…</span></a>
  // with CSS line-wrapping. The old .innerText approach produced
  //   "http://\ngithub.com/multica-ai/and\nrej-karpathy-skills\n…"
  // which shipped to the LLM as "the tweet body".
  it('recovers unbroken URL from href when twitter truncates display text', () => {
    // Mimic the "* ANDREJ-KARPATHY-SKILLS:\n\n<a>github.com/multica-ai/and\nrej-karpathy-skills\n…</a>"
    const root = el('div', {}, [
      tx('* ANDREJ-KARPATHY-SKILLS:\n\n'),
      el('a', { href: 'https://t.co/abc123xyz' }, [
        el('span', {}, [tx('github.com/multica-ai/and')]),
        tx('\n'),
        el('span', {}, [tx('rej-karpathy-skills')]),
        tx('\n'),
        el('span', {}, [tx('…')]),
      ]),
    ]);
    const { text, urls } = scrapeTweetTextDom(root);
    expect(text).not.toMatch(/…/);
    expect(text).not.toMatch(/github\.com\/[\w-]+\/\w+\n/); // no mid-URL linebreak
    expect(text).toContain('https://t.co/abc123xyz');
    expect(urls).toEqual(['https://t.co/abc123xyz']);
  });

  it('collects t.co links in urls[] (old bookmarklet filter dropped them as intra-twitter)', () => {
    const root = el('div', {}, [
      tx('check this out '),
      el('a', { href: 'https://t.co/LINK1' }, [tx('example.com/a')]),
      tx(' and '),
      el('a', { href: 'https://t.co/LINK2' }, [tx('example.com/b')]),
    ]);
    const { urls } = scrapeTweetTextDom(root);
    expect(urls).toEqual(['https://t.co/LINK1', 'https://t.co/LINK2']);
  });

  it('skips intra-twitter links (mentions, hashtags) — emits display text, no url capture', () => {
    const root = el('div', {}, [
      tx('hello '),
      el('a', { href: 'https://twitter.com/alice' }, [tx('@alice')]),
      tx(' and '),
      el('a', { href: '/hashtag/kompl' }, [tx('#kompl')]),
    ]);
    const { text, urls } = scrapeTweetTextDom(root);
    expect(text).toBe('hello @alice and #kompl');
    expect(urls).toEqual([]);
  });

  it('expands emoji <img alt> into text', () => {
    const root = el('div', {}, [
      tx('shipped '),
      el('img', { alt: '🚀' }),
      tx(' today'),
    ]);
    expect(scrapeTweetTextDom(root).text).toBe('shipped 🚀 today');
  });

  // The bookmarklet injects scrapeTweetTextDom via .toString() into a
  // `javascript:` URL. If the compiled function references hoisted helpers or
  // module-scoped bindings, the stringified form breaks when eval'd in the
  // browser. Assert it's self-contained by reconstituting + calling it.
  it('stringified form is self-contained and behaves identically when eval\'d', () => {
    const src = scrapeTweetTextDom.toString();
    // bookmarklet shape: `var scrapeTweetTextDom=${src};` — must parse.
    const reconstituted = new Function(
      `${src}; return scrapeTweetTextDom;`
    )() as typeof scrapeTweetTextDom;
    const root = el('div', {}, [
      tx('hello '),
      el('a', { href: 'https://t.co/LINK' }, [tx('example.com/path')]),
      tx(' world'),
    ]);
    const original = scrapeTweetTextDom(root);
    const copy = reconstituted(root);
    expect(copy).toEqual(original);
    expect(copy.urls).toEqual(['https://t.co/LINK']);
    expect(copy.text).toBe('hello https://t.co/LINK world');
  });

  it('full RoundtableSpace-shaped tweet: 5 t.co links, no mid-URL linebreaks, no …', () => {
    const mkLink = (hash: string, display: string) =>
      el('a', { href: `https://t.co/${hash}` }, [
        el('span', {}, [tx(display.slice(0, 20))]),
        tx('\n'),
        el('span', {}, [tx(display.slice(20))]),
        tx('\n'),
        el('span', {}, [tx('…')]),
      ]);
    const root = el('div', {}, [
      tx('TOP FIVE GITHUB REPOS\n\n* A: '),
      mkLink('A1', 'github.com/multica-ai/andrej-karpathy-skills'),
      tx('\n* B: '),
      mkLink('B2', 'github.com/NousResearch/hermes-agent'),
      tx('\n* C: '),
      mkLink('C3', 'github.com/thedotmack/claude-mem'),
      tx('\n* D: '),
      mkLink('D4', 'github.com/EvoMap/evolver'),
      tx('\n* E: '),
      mkLink('E5', 'github.com/lsdefine/GenericAgent'),
    ]);
    const { text, urls } = scrapeTweetTextDom(root);
    expect(urls).toEqual([
      'https://t.co/A1', 'https://t.co/B2', 'https://t.co/C3',
      'https://t.co/D4', 'https://t.co/E5',
    ]);
    expect(text).not.toMatch(/…/);
    expect(text).not.toMatch(/http[s]?:\/\/\s/);
    for (const h of ['A1', 'B2', 'C3', 'D4', 'E5']) {
      expect(text).toContain(`https://t.co/${h}`);
    }
  });
});
