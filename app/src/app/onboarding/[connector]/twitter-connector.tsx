'use client';

/**
 * TwitterConnector — /onboarding/twitter
 *
 * Accepts a JSON export from any Twitter/X bookmark tool.
 * Auto-detects format, shows a preview, then ingests via:
 *   - connector: 'text'  for tweet text
 *   - connector: 'url'   for linked articles (opt-in)
 *
 * No scraping, no auth. We are an importer.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { detectAndParse, formatTweetMarkdown, isTwitterUrl, type ParsedTweet } from '../../../lib/twitter-parser';
import {
  type ConnectorProps,
  navigateNext,
  navigateBack,
  BTN_PRIMARY, BTN_PRIMARY_DISABLED, BTN_GHOST,
  BottomNav,
} from './_shared';

// ── Bookmarklet (DOM scraper for twitter.com/i/bookmarks) ─────────────────────
// DOM scraper that runs on twitter.com/i/bookmarks. Uses stable data-testid
// selectors, scrolls automatically, downloads a JSON file, then prompts the
// user to come back and upload it. Output shape matches parseSiftly() in
// twitter-parser.ts so no parser changes are needed.
const BOOKMARKLET = `(function(){
  if(!location.href.match(/\\/i\\/bookmarks/)){
    alert('Go to twitter.com/i/bookmarks first, then click this bookmark.');
    return;
  }
  var tweets=[],seen=new Set(),last=0,tries=0;
  function scrape(){
    document.querySelectorAll('[data-testid="tweet"]').forEach(function(el){
      var t=el.querySelector('time');
      var a=t&&t.closest('a');
      var url=a?a.href:null;
      if(!url||seen.has(url))return;
      seen.add(url);
      var textEl=el.querySelector('[data-testid="tweetText"]');
      var text=textEl?textEl.innerText:'';
      var author=null;
      var nameEl=el.querySelector('[data-testid="User-Name"]');
      if(nameEl)[].forEach.call(nameEl.querySelectorAll('span'),function(s){
        if(!author&&s.textContent.startsWith('@'))author=s.textContent;
      });
      var links=[];
      if(textEl)[].forEach.call(textEl.querySelectorAll('a'),function(a){
        if(a.href&&!a.href.match(/\\/\\/(twitter|x|t)\\.co\\//))links.push(a.href);
      });
      tweets.push({text:text,author:author,created_at:t?t.getAttribute('datetime'):null,tweet_url:url,urls:links,source:'bookmark'});
    });
  }
  function scroll(){
    scrape();
    window.scrollTo(0,document.body.scrollHeight);
    if(document.body.scrollHeight===last){tries++;if(tries>=3){finish();return;}}
    else{tries=0;last=document.body.scrollHeight;}
    if(tweets.length<5000)setTimeout(scroll,900);else finish();
  }
  function finish(){
    var b=new Blob([JSON.stringify(tweets,null,2)],{type:'application/json'});
    var a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(b),download:'twitter-bookmarks.json'});
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    alert('Done! Exported '+tweets.length+' bookmarks. Go back to Kompl and upload the file.');
  }
  scrape();last=document.body.scrollHeight;
  setTimeout(scroll,200);
})()`;


// ── Export Guide ──────────────────────────────────────────────────────────────

function ExportGuide({
  collapsed,
  onToggle,
  bookmarkletRef,
}: {
  collapsed: boolean;
  onToggle: () => void;
  bookmarkletRef: React.RefObject<HTMLAnchorElement | null>;
}) {
  const [extensionsOpen, setExtensionsOpen] = useState(false);

  return (
    <div style={{ marginBottom: '1.5rem' }}>

      {collapsed ? (
        /* Collapsed: single compact row */
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '0.6rem 1rem',
          border: '1px solid var(--border)', borderRadius: 6,
          background: 'var(--bg-card)', marginBottom: '0.75rem',
        }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--fg-muted)' }}>
            Step 1 — Install the exporter
          </span>
          <button
            onClick={onToggle}
            style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.78rem', padding: 0 }}
          >
            Show ↓
          </button>
        </div>
      ) : (
        /* Expanded: two columns side by side */
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>

          {/* Step 1 */}
          <div style={{ padding: '1rem 1.25rem', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-card)' }}>
            <h2 style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', fontWeight: 600 }}>
              Step 1 — Install the exporter <span style={{ color: 'var(--fg-dim)', fontWeight: 400 }}>(one time)</span>
            </h2>
            <div style={{ textAlign: 'center', margin: '0.25rem 0 0.75rem' }}>
              {/* eslint-disable-next-line jsx-a11y/anchor-is-valid */}
              <a
                ref={bookmarkletRef}
                onClick={e => e.preventDefault()}
                draggable
                style={{
                  display: 'inline-block',
                  padding: '0.5rem 1.25rem',
                  border: '2px solid var(--accent)',
                  borderRadius: 6,
                  color: 'var(--accent)',
                  fontWeight: 600,
                  fontSize: '0.82rem',
                  cursor: 'grab',
                  userSelect: 'none',
                  textDecoration: 'none',
                  background: 'transparent',
                }}
              >
                ↓ Drag to bookmark bar
              </a>
              <p style={{ margin: '0.4rem 0 0', fontSize: '0.72rem', color: 'var(--fg-dim)' }}>
                Chrome, Firefox, Safari, Edge. Mobile: use a browser extension below.
              </p>
            </div>
            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--fg-muted)', lineHeight: 1.5 }}>
              Drag above to your bookmark bar. If hidden: <strong>View → Always Show Bookmarks Bar</strong>.
            </p>
          </div>

          {/* Step 2 */}
          <div style={{ padding: '1rem 1.25rem', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-card)' }}>
            <h2 style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', fontWeight: 600 }}>
              Step 2 — Run it on Twitter
            </h2>
            <ol style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.78rem', lineHeight: 1.8, color: 'var(--fg-muted)' }}>
              <li>Go to <a href="https://twitter.com/i/bookmarks" target="_blank" rel="noreferrer">twitter.com/i/bookmarks</a></li>
              <li>Click the bookmark you just installed</li>
              <li>Page scrolls automatically — don&apos;t click anything</li>
              <li>A <code>twitter-bookmarks.json</code> downloads when done</li>
              <li>Upload it below ↓</li>
            </ol>
            <button
              onClick={onToggle}
              style={{ marginTop: '0.75rem', background: 'none', border: 'none', color: 'var(--fg-dim)', cursor: 'pointer', fontSize: '0.72rem', padding: 0 }}
            >
              Hide guide ↑
            </button>
          </div>
        </div>
      )}

      {/* Collapsible extensions fallback */}
      <div style={{ fontSize: '0.85rem' }}>
        <button
          onClick={() => setExtensionsOpen(v => !v)}
          style={{ background: 'none', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 0 }}
        >
          {extensionsOpen ? '▾' : '▸'} Or use a browser extension instead
        </button>
        {extensionsOpen && (
          <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem', lineHeight: 1.8, color: 'var(--fg-muted)' }}>
            <li>
              <a href="https://chromewebstore.google.com/detail/twitter-bookmark-exporter/aggiedibmjnhcjlngcffegdhfdmfjodc" target="_blank" rel="noreferrer">
                Twitter Bookmark Exporter
              </a>{' '}— one-click JSON
            </li>
            <li>
              <a href="https://chromewebstore.google.com/detail/x-bookmarks-exporter-expo/abgjpimjfnggkhnoehjndcociampccnm" target="_blank" rel="noreferrer">
                X Bookmarks Exporter
              </a>{' '}— JSON / CSV / XLSX
            </li>
            <li>
              <a href="https://chromewebstore.google.com/detail/twitter-bookmarks-downloa/nfkbcnohjlfnclnhhblgjafldimikcdb" target="_blank" rel="noreferrer">
                Twitter Bookmarks Downloader
              </a>{' '}— includes media
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Tweet preview card ────────────────────────────────────────────────────────

function TweetPreviewCard({ tweet }: { tweet: ParsedTweet }) {
  const text = tweet.text.length > 120 ? tweet.text.slice(0, 117) + '…' : tweet.text;
  return (
    <div
      style={{
        padding: '0.75rem 1rem',
        border: '1px solid var(--border)',
        borderRadius: 6,
        background: 'var(--bg-card)',
        fontSize: '0.88rem',
      }}
    >
      {tweet.author && (
        <div style={{ fontWeight: 600, color: 'var(--fg-muted)', marginBottom: '0.3rem' }}>
          {tweet.author}
        </div>
      )}
      <div style={{ lineHeight: 1.5 }}>{text}</div>
      {tweet.date && (
        <div style={{ marginTop: '0.3rem', fontSize: '0.8rem', color: 'var(--fg-dim)' }}>
          {new Date(tweet.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type Phase = 'idle' | 'preview' | 'collecting' | 'done';

export default function TwitterConnector({ sessionId, connectors, connectorIdx, showToast }: ConnectorProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bookmarkletRef = useRef<HTMLAnchorElement>(null);

  // React strips javascript: hrefs in JSX — set imperatively after mount
  useEffect(() => {
    bookmarkletRef.current?.setAttribute('href', `javascript:${BOOKMARKLET}`);
  }, []);

  const [activeTab, setActiveTab] = useState<'upload' | 'paste'>('upload');
  const [pasteText, setPasteText] = useState('');
  const [dragging, setDragging] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [tweets, setTweets] = useState<ParsedTweet[]>([]);
  const [guideCollapsed, setGuideCollapsed] = useState(false);
  const [fetchLinks, setFetchLinks] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [collectingStep, setCollectingStep] = useState('');
  const [storedCount, setStoredCount] = useState(0);

  const articleUrls = [...new Set(
    tweets.flatMap(t => t.urls).filter(u => !isTwitterUrl(u))
  )];
  const hasArticleLinks = articleUrls.length > 0;

  function tryParse(raw: string) {
    setParseError(null);
    try {
      const parsed = detectAndParse(raw);
      if (parsed.length === 0) {
        setParseError('No tweets found in this file. Is it the right export?');
        return;
      }
      setTweets(parsed);
      setGuideCollapsed(true);
      setPhase('preview');
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Failed to parse file.');
    }
  }

  function handleFileSelect(file: File) {
    if (!file.name.endsWith('.json')) {
      setParseError('Please upload a .json file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => tryParse(reader.result as string);
    reader.readAsText(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  }

  function handlePasteSubmit() {
    if (!pasteText.trim()) { showToast('Paste your JSON first.', 'error'); return; }
    tryParse(pasteText.trim());
  }

  function resetToIdle() {
    setTweets([]);
    setPhase('idle');
    setParseError(null);
    setFetchLinks(false);
    setGuideCollapsed(false);
    setPasteText('');
  }

  async function handleIngest() {
    if (phase !== 'preview' || tweets.length === 0) return;
    setPhase('collecting');

    try {
      // Phase 1: store tweet text
      setCollectingStep('Storing tweets…');
      const tweetItems = tweets.map(t => ({
        markdown: formatTweetMarkdown(t),
        title_hint: t.author ? `Tweet by ${t.author}` : 'Tweet',
        source_type_hint: 'tweet',
        metadata: {
          ...(t.date ? { date_saved: t.date } : {}),
          ...(t.author ? { author: t.author } : {}),
          ...(t.tweet_url ? { tweet_url: t.tweet_url } : {}),
          ...(t.urls.length > 0 ? { linked_urls: t.urls } : {}),
        },
      }));

      const r1 = await fetch('/api/onboarding/collect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, connector: 'text', items: tweetItems }),
      });
      const b1 = await r1.json() as { stored: { source_id: string }[]; error?: string };
      if (!r1.ok) {
        showToast(b1.error ?? `Collect failed (${r1.status})`, 'error');
        setPhase('preview');
        return;
      }
      let total = b1.stored.length;

      // Phase 2: linked article URLs (opt-in)
      if (fetchLinks && articleUrls.length > 0) {
        setCollectingStep(`Fetching linked articles… (${articleUrls.length} URLs)`);
        const r2 = await fetch('/api/onboarding/collect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            connector: 'url',
            items: articleUrls.map(url => ({ url })),
          }),
        });
        const b2 = await r2.json() as { stored: { source_id: string }[]; error?: string };
        if (!r2.ok) {
          showToast(b2.error ?? `URL collect failed (${r2.status})`, 'error');
          // Don't abort — tweets are already stored
        } else {
          total += b2.stored.length;
        }
      }

      setStoredCount(total);
      setPhase('done');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Network error', 'error');
      setPhase('preview');
    }
  }

  function handleSkip() {
    navigateNext(sessionId, connectors, connectorIdx, router);
  }

  function handleContinue() {
    navigateNext(sessionId, connectors, connectorIdx, router);
  }

  function handleBack() {
    navigateBack(sessionId, connectors, connectorIdx, router);
  }

  // ── Done state ───────────────────────────────────────────────────────────────
  if (phase === 'done') {
    return (
      <div>
        <div
          style={{
            padding: '1.5rem',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            marginBottom: '1.5rem',
          }}
        >
          <p style={{ margin: 0, fontWeight: 600, fontSize: '1.05rem' }}>
            ✅ {storedCount} source{storedCount !== 1 ? 's' : ''} saved
          </p>
          <p style={{ margin: '0.4rem 0 0', fontSize: '0.88rem', color: 'var(--fg-muted)' }}>
            {tweets.length} tweet{tweets.length !== 1 ? 's' : ''}
            {fetchLinks && articleUrls.length > 0 ? ` + ${articleUrls.length} linked article${articleUrls.length !== 1 ? 's' : ''}` : ''}
            {' '}queued for compilation.
          </p>
        </div>
        <BottomNav
          phase="done"
          hasInput={false}
          onIngest={() => {}}
          onSkip={() => {}}
          onContinue={handleContinue}
          onBack={handleBack}
        />
      </div>
    );
  }

  // ── Collecting state ─────────────────────────────────────────────────────────
  if (phase === 'collecting') {
    return (
      <div style={{ textAlign: 'center', padding: '2rem 0', color: 'var(--fg-muted)' }}>
        <p>{collectingStep}</p>
      </div>
    );
  }

  return (
    <div>
      {/* Export guide */}
      <ExportGuide collapsed={guideCollapsed} onToggle={() => setGuideCollapsed(v => !v)} bookmarkletRef={bookmarkletRef} />

      {/* Step 2: Upload */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ margin: '0 0 1rem', fontSize: '1rem', fontWeight: 600 }}>
          Step 2 — Upload your export
        </h2>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0, marginBottom: '1rem', borderBottom: '1px solid var(--border)' }}>
          {(['upload', 'paste'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => { setActiveTab(tab); setParseError(null); }}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                padding: '0.4rem 1rem',
                cursor: 'pointer',
                color: activeTab === tab ? 'var(--fg)' : 'var(--fg-muted)',
                fontWeight: activeTab === tab ? 600 : 400,
                fontSize: '0.9rem',
                marginBottom: -1,
              }}
            >
              {tab === 'upload' ? 'Upload file' : 'Paste JSON'}
            </button>
          ))}
        </div>

        {activeTab === 'upload' ? (
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${dragging ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 8,
              padding: '2rem',
              textAlign: 'center',
              cursor: 'pointer',
              background: dragging ? 'var(--bg-hover)' : 'transparent',
              transition: 'border-color 0.15s, background 0.15s',
            }}
          >
            <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '0.95rem' }}>
              Drop your <code>.json</code> file here, or <span style={{ color: 'var(--accent)' }}>click to browse</span>
            </p>
            <p style={{ margin: '0.4rem 0 0', fontSize: '0.8rem', color: 'var(--fg-dim)' }}>
              Supports all major Twitter bookmark export formats
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }}
            />
          </div>
        ) : (
          <div>
            <textarea
              value={pasteText}
              onChange={e => setPasteText(e.target.value)}
              placeholder="Paste your exported JSON here…"
              style={{
                width: '100%',
                minHeight: 140,
                padding: '0.75rem',
                border: '1px solid var(--border)',
                borderRadius: 6,
                background: 'var(--bg-input)',
                color: 'var(--fg)',
                fontFamily: 'monospace',
                fontSize: '0.85rem',
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ marginTop: '0.5rem', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={handlePasteSubmit}
                disabled={!pasteText.trim()}
                style={{ padding: '0.4rem 1rem', fontSize: '0.9rem' }}
              >
                Parse →
              </button>
            </div>
          </div>
        )}

        {parseError && (
          <p style={{ marginTop: '0.75rem', color: 'var(--error, #e74c3c)', fontSize: '0.88rem' }}>
            {parseError}
          </p>
        )}
      </div>

      {/* Step 3: Preview (after successful parse) */}
      {phase === 'preview' && tweets.length > 0 && (
        <div style={{ marginBottom: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
              Step 3 — Preview
            </h2>
            <button
              onClick={resetToIdle}
              style={{ background: 'none', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', fontSize: '0.85rem', padding: 0 }}
            >
              ← Try a different file
            </button>
          </div>

          <p style={{ margin: '0 0 0.75rem', color: 'var(--fg-muted)', fontSize: '0.9rem' }}>
            Found <strong>{tweets.length}</strong> tweet{tweets.length !== 1 ? 's' : ''}.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
            {tweets.slice(0, 5).map((t, i) => (
              <TweetPreviewCard key={i} tweet={t} />
            ))}
            {tweets.length > 5 && (
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--fg-dim)', textAlign: 'center' }}>
                + {tweets.length - 5} more tweets
              </p>
            )}
          </div>

          {/* Linked article opt-in */}
          {hasArticleLinks && (
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.65rem',
                padding: '0.9rem 1rem',
                border: '1px solid var(--border)',
                borderRadius: 8,
                cursor: 'pointer',
                background: 'var(--bg-card)',
              }}
            >
              <input
                type="checkbox"
                checked={fetchLinks}
                onChange={e => setFetchLinks(e.target.checked)}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              <div>
                <div style={{ fontWeight: 500, fontSize: '0.9rem' }}>
                  Fetch {articleUrls.length} linked article{articleUrls.length !== 1 ? 's' : ''} too
                </div>
                <div style={{ fontSize: '0.82rem', color: 'var(--fg-muted)', marginTop: '0.2rem' }}>
                  {articleUrls.length} of your tweets contain links to articles or blog posts.
                  Kompl will fetch and compile those pages as additional sources.
                </div>
              </div>
            </label>
          )}
        </div>
      )}

      <BottomNav
        phase="idle"
        hasInput={phase === 'preview' && tweets.length > 0}
        onIngest={handleIngest}
        onSkip={handleSkip}
        onContinue={handleContinue}
        onBack={handleBack}
      />
    </div>
  );
}
