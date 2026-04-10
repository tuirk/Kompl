'use client';
export const dynamic = 'force-dynamic';

/**
 * /onboarding/[connector] — Per-connector source collection screen.
 *
 * Reads session state from sessionStorage:
 *   kompl_session_id    — UUID for this onboarding run
 *   kompl_connectors    — JSON array of selected connector ids
 *   kompl_connector_idx — current index into kompl_connectors
 *
 * Active connectors: 'url', 'file-upload', 'bookmarks', 'upnote'
 * Unknown or coming-soon connectors show a holding screen.
 *
 * Navigation:
 *   "Ingest & continue" → calls collect API → next connector or /review
 *   "Skip for now"      → next connector or /review (no API call)
 */

import { type ComponentType, useEffect, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';

import { useToast } from '../../../components/Toast';

const CONNECTOR_LABELS: Record<string, string> = {
  url: 'URLs',
  'file-upload': 'Files',
  'google-drive': 'Google Drive',
  notion: 'Notion',
  bookmarks: 'Browser Bookmarks',
  twitter: 'Twitter / X Bookmarks',
  upnote: 'Upnote',
  'iphone-notes': 'iPhone Notes',
};

const FILE_ACCEPT =
  '.pdf,.docx,.pptx,.xlsx,.txt,.md,.html,.htm,.csv,.json,.xml,.jpg,.jpeg,.png,.mp3,.wav';

function parseUrls(raw: string): { urls: string[]; invalid: string[] } {
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        invalid.push(trimmed);
        continue;
      }
      urls.push(trimmed);
    } catch {
      invalid.push(trimmed);
    }
  }
  return { urls, invalid };
}

interface CollectResult {
  stored: number;
  failed: number;
  youtubeWarnings: number;
}

interface UploadedFile {
  file_path: string;
  filename: string;
}

interface ConnectorProps {
  sessionId: string;
  connectors: string[];
  connectorIdx: number;
  showToast: (msg: string, type?: 'error') => void;
}

function navigateNext(
  sessionId: string,
  connectors: string[],
  connectorIdx: number,
  router: AppRouterInstance
) {
  const nextIdx = connectorIdx + 1;
  if (nextIdx >= connectors.length) {
    router.push(`/onboarding/review?session_id=${encodeURIComponent(sessionId)}`);
  } else {
    sessionStorage.setItem('kompl_connector_idx', String(nextIdx));
    router.push(`/onboarding/${connectors[nextIdx]}?session_id=${encodeURIComponent(sessionId)}`);
  }
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function SummaryCard({ result }: { result: CollectResult }) {
  return (
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
        ✅ {result.stored} source{result.stored !== 1 ? 's' : ''} saved
        {result.failed > 0 && ` · ${result.failed} failed`}
      </p>
      {result.youtubeWarnings > 0 && (
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--fg-muted)' }}>
          ⚠ {result.youtubeWarnings} YouTube URL
          {result.youtubeWarnings !== 1 ? 's' : ''} processed without transcript (full support coming soon).
        </p>
      )}
      {result.failed > 0 && (
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--fg-muted)' }}>
          Failed sources were skipped. You can add them again later.
        </p>
      )}
    </div>
  );
}

function BottomNav({
  phase,
  hasInput,
  onIngest,
  onSkip,
  onContinue,
  onBack,
}: {
  phase: 'idle' | 'loading' | 'done';
  hasInput: boolean;
  onIngest: () => void;
  onSkip: () => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  return (
    <div style={{ marginTop: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <button
        onClick={onBack}
        style={{ background: 'none', border: 'none', color: 'var(--fg-muted)', cursor: 'pointer', padding: 0 }}
      >
        ← Back
      </button>

      <div style={{ display: 'flex', gap: '0.75rem' }}>
        {phase !== 'done' && (
          <button
            onClick={onSkip}
            disabled={phase === 'loading'}
            style={{
              background: 'none',
              border: '1px solid var(--border)',
              color: 'var(--fg-muted)',
              cursor: 'pointer',
              padding: '0.5rem 1.1rem',
              borderRadius: 6,
            }}
          >
            Skip for now
          </button>
        )}

        {phase === 'idle' && (
          <button onClick={onIngest} disabled={!hasInput} style={{ padding: '0.5rem 1.3rem' }}>
            Ingest &amp; continue →
          </button>
        )}

        {phase === 'done' && (
          <button onClick={onContinue} style={{ padding: '0.5rem 1.3rem' }}>
            Continue →
          </button>
        )}
      </div>
    </div>
  );
}

// ── URL Connector ─────────────────────────────────────────────────────────────

function UrlConnector({ sessionId, connectors, connectorIdx, showToast }: ConnectorProps) {
  const router = useRouter();
  const [urlInput, setUrlInput] = useState('');
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done'>('idle');
  const [result, setResult] = useState<CollectResult | null>(null);

  const { urls } = parseUrls(urlInput);

  async function handleIngest() {
    const { urls: validUrls, invalid } = parseUrls(urlInput);
    if (validUrls.length === 0) { showToast('Paste at least one http(s) URL.', 'error'); return; }
    if (invalid.length > 0) showToast(`Skipping ${invalid.length} invalid line(s).`);
    setPhase('loading');
    try {
      const res = await fetch('/api/onboarding/collect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, connector: 'url', items: validUrls.map(url => ({ url })) }),
      });
      const body = await res.json() as {
        stored: { source_id: string }[];
        failed: { item: unknown; error: string }[];
        warnings: { source_id: string; warning: string }[];
        error?: string;
      };
      if (!res.ok) { showToast(body.error ?? `Collect failed (${res.status})`, 'error'); setPhase('idle'); return; }
      setResult({
        stored: body.stored.length,
        failed: body.failed.length,
        youtubeWarnings: body.warnings.filter(w => w.warning === 'youtube_no_transcript').length,
      });
      setPhase('done');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Network error', 'error');
      setPhase('idle');
    }
  }

  return (
    <>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.8rem' }}>🔗 Add URLs</h1>
        <p style={{ color: 'var(--fg-muted)', marginTop: '0.5rem' }}>
          Paste any links — articles, blogs, YouTube videos. One URL per line.
        </p>
      </header>

      {phase !== 'done' && (
        <>
          <textarea
            rows={10}
            placeholder={`https://paulgraham.com/read.html\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ`}
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            disabled={phase === 'loading'}
            style={{ width: '100%', resize: 'vertical', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13, boxSizing: 'border-box' }}
          />
          <p style={{ fontSize: '0.85rem', color: 'var(--fg-dim)', marginTop: '0.4rem' }}>
            YouTube URLs will be processed via Firecrawl for now (transcript extraction coming soon).
          </p>
        </>
      )}

      {phase === 'loading' && (
        <div style={{ padding: '2rem 0', color: 'var(--fg-muted)' }}>
          ⏳ Processing {urls.length} URL{urls.length !== 1 ? 's' : ''}…
        </div>
      )}

      {phase === 'done' && result && <SummaryCard result={result} />}

      <BottomNav
        phase={phase}
        hasInput={urls.length > 0}
        onIngest={handleIngest}
        onSkip={() => navigateNext(sessionId, connectors, connectorIdx, router)}
        onContinue={() => navigateNext(sessionId, connectors, connectorIdx, router)}
        onBack={() => router.push('/onboarding')}
      />
    </>
  );
}

// ── File Upload Connector ─────────────────────────────────────────────────────

function FileConnector({ sessionId, connectors, connectorIdx, showToast }: ConnectorProps) {
  const router = useRouter();
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done'>('idle');
  const [loadingMsg, setLoadingMsg] = useState('');
  const [result, setResult] = useState<CollectResult | null>(null);

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;
    setSelectedFiles(prev => [...prev, ...Array.from(fileList)].slice(0, 20));
  }

  function removeFile(idx: number) {
    setSelectedFiles(prev => prev.filter((_, i) => i !== idx));
  }

  async function handleIngest() {
    if (selectedFiles.length === 0) { showToast('Select at least one file.', 'error'); return; }
    setPhase('loading');
    setLoadingMsg('Uploading files…');

    const fd = new FormData();
    for (const f of selectedFiles) fd.append('files', f);

    let uploaded: UploadedFile[];
    try {
      const uploadRes = await fetch('/api/onboarding/upload', { method: 'POST', body: fd });
      const uploadBody = await uploadRes.json() as {
        files: UploadedFile[];
        failed: { filename: string; error: string }[];
        error?: string;
      };
      if (!uploadRes.ok || uploadBody.files.length === 0) {
        showToast(uploadBody.error ?? 'Upload failed', 'error'); setPhase('idle'); return;
      }
      if (uploadBody.failed.length > 0) showToast(`${uploadBody.failed.length} file(s) could not be saved — continuing with the rest.`);
      uploaded = uploadBody.files;
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Upload error', 'error');
      setPhase('idle');
      return;
    }

    setLoadingMsg(`Converting ${uploaded.length} file${uploaded.length !== 1 ? 's' : ''}…`);
    try {
      const collectRes = await fetch('/api/onboarding/collect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          connector: 'file-upload',
          items: uploaded.map(({ file_path, filename }) => ({
            file_path,
            title_hint: filename.replace(/\.[^.]+$/, ''),
          })),
        }),
      });
      const body = await collectRes.json() as {
        stored: { source_id: string }[];
        failed: { item: unknown; error: string }[];
        warnings: { source_id: string; warning: string }[];
        error?: string;
      };
      if (!collectRes.ok) { showToast(body.error ?? `Convert failed (${collectRes.status})`, 'error'); setPhase('idle'); return; }
      setResult({ stored: body.stored.length, failed: body.failed.length, youtubeWarnings: 0 });
      setPhase('done');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Network error', 'error');
      setPhase('idle');
    }
  }

  return (
    <>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.8rem' }}>📄 Upload Files</h1>
        <p style={{ color: 'var(--fg-muted)', marginTop: '0.5rem' }}>
          PDF, DOCX, PPTX, XLSX, HTML, images, audio. Up to 20 files at a time.
        </p>
      </header>

      {phase !== 'done' && (
        <>
          <div
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={e => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${isDragging ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 8, padding: '2rem', textAlign: 'center', cursor: 'pointer',
              background: isDragging ? 'var(--bg-card-hover)' : 'var(--bg-card)',
              color: 'var(--fg-muted)', marginBottom: '1rem',
            }}
          >
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📂</div>
            <div>Drag files here or <span style={{ color: 'var(--accent)' }}>click to browse</span></div>
            <div style={{ fontSize: '0.8rem', marginTop: '0.3rem', color: 'var(--fg-dim)' }}>
              PDF, DOCX, PPTX, XLSX, TXT, MD, HTML, CSV, images, audio · max 50 MB each
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={FILE_ACCEPT}
            style={{ display: 'none' }}
            onChange={e => addFiles(e.target.files)}
          />

          {selectedFiles.length > 0 && (
            <div style={{ marginBottom: '1rem' }}>
              <p style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', marginBottom: '0.5rem' }}>
                {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''} selected
                {selectedFiles.length >= 20 && ' (max 20)'}
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {selectedFiles.map((f, i) => (
                  <span
                    key={i}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.2rem 0.6rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 999, fontSize: '0.8rem' }}
                  >
                    {f.name.slice(0, 40)}{f.name.length > 40 ? '…' : ''}
                    <button
                      onClick={e => { e.stopPropagation(); removeFile(i); }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-dim)', padding: 0, lineHeight: 1, fontSize: '0.9rem' }}
                    >×</button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {phase === 'loading' && (
        <div style={{ padding: '2rem 0', color: 'var(--fg-muted)' }}>⏳ {loadingMsg}</div>
      )}

      {phase === 'done' && result && <SummaryCard result={result} />}

      <BottomNav
        phase={phase}
        hasInput={selectedFiles.length > 0}
        onIngest={handleIngest}
        onSkip={() => navigateNext(sessionId, connectors, connectorIdx, router)}
        onContinue={() => navigateNext(sessionId, connectors, connectorIdx, router)}
        onBack={() => router.push('/onboarding')}
      />
    </>
  );
}

// ── Bookmarks Connector ───────────────────────────────────────────────────────

function BookmarksConnector({ sessionId, connectors, connectorIdx, showToast }: ConnectorProps) {
  const router = useRouter();
  const [bookmarkFile, setBookmarkFile] = useState<File | null>(null);
  const [parsedItems, setParsedItems] = useState<{ url: string; title: string; dateSaved: string | null }[]>([]);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done'>('idle');
  const [result, setResult] = useState<CollectResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function parseBookmarksHtml(html: string): { url: string; title: string; dateSaved: string | null }[] {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'));
    const items: { url: string; title: string; dateSaved: string | null }[] = [];
    for (const a of anchors) {
      const href = a.getAttribute('href') ?? '';
      if (!href.startsWith('http://') && !href.startsWith('https://')) continue;
      const addDate = a.getAttribute('ADD_DATE') ?? a.getAttribute('add_date');
      let dateSaved: string | null = null;
      if (addDate) {
        const ts = Number(addDate);
        if (!isNaN(ts) && ts > 0) dateSaved = new Date(ts * 1000).toISOString();
      }
      items.push({ url: href, title: a.textContent?.trim() || href, dateSaved });
    }
    return items;
  }

  function handleFileSelect(file: File | null) {
    if (!file) return;
    setBookmarkFile(file);
    const reader = new FileReader();
    reader.onload = e => {
      const items = parseBookmarksHtml(e.target?.result as string);
      setParsedItems(items);
    };
    reader.readAsText(file);
  }

  async function handleIngest() {
    if (parsedItems.length === 0) { showToast('No valid bookmarks found in this file.', 'error'); return; }
    setPhase('loading');
    try {
      const res = await fetch('/api/onboarding/collect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          connector: 'url',
          items: parsedItems.map(({ url, title, dateSaved }) => ({
            url,
            title_hint: title,
            ...(dateSaved ? { metadata_hint: { date_saved: dateSaved } } : {}),
          })),
        }),
      });
      const body = await res.json() as {
        stored: { source_id: string }[];
        failed: { item: unknown; error: string }[];
        warnings: { source_id: string; warning: string }[];
        error?: string;
      };
      if (!res.ok) { showToast(body.error ?? `Collect failed (${res.status})`, 'error'); setPhase('idle'); return; }
      setResult({
        stored: body.stored.length,
        failed: body.failed.length,
        youtubeWarnings: body.warnings.filter(w => w.warning === 'youtube_no_transcript').length,
      });
      setPhase('done');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Network error', 'error');
      setPhase('idle');
    }
  }

  return (
    <>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.8rem' }}>🔖 Browser Bookmarks</h1>
        <p style={{ color: 'var(--fg-muted)', marginTop: '0.5rem' }}>
          Export your bookmarks from Chrome, Firefox, or Safari as an HTML file, then upload it here.
        </p>
      </header>

      {phase !== 'done' && (
        <>
          <div
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: '2px dashed var(--border)', borderRadius: 8, padding: '2rem',
              textAlign: 'center', cursor: 'pointer',
              background: 'var(--bg-card)', color: 'var(--fg-muted)', marginBottom: '1rem',
            }}
          >
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🔖</div>
            {bookmarkFile ? (
              <div>
                <strong>{bookmarkFile.name}</strong>
                {parsedItems.length > 0 && (
                  <div style={{ marginTop: '0.4rem', color: 'var(--accent)', fontWeight: 500 }}>
                    Found {parsedItems.length} bookmark{parsedItems.length !== 1 ? 's' : ''}
                  </div>
                )}
                {parsedItems.length === 0 && (
                  <div style={{ marginTop: '0.4rem', color: 'var(--warning)' }}>
                    No http/https bookmarks found — is this a valid bookmarks export?
                  </div>
                )}
              </div>
            ) : (
              <>
                <div>Click to select your bookmarks <code>.html</code> file</div>
                <div style={{ fontSize: '0.8rem', marginTop: '0.3rem', color: 'var(--fg-dim)' }}>
                  Chrome: Bookmarks → ⋮ → Export bookmarks · Firefox: Bookmarks → Manage → Import &amp; Backup → Export
                </div>
              </>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".html,.htm"
            style={{ display: 'none' }}
            onChange={e => handleFileSelect(e.target.files?.[0] ?? null)}
          />
        </>
      )}

      {phase === 'loading' && (
        <div style={{ padding: '2rem 0', color: 'var(--fg-muted)' }}>
          ⏳ Processing {parsedItems.length} bookmark{parsedItems.length !== 1 ? 's' : ''}…
        </div>
      )}

      {phase === 'done' && result && <SummaryCard result={result} />}

      <BottomNav
        phase={phase}
        hasInput={parsedItems.length > 0}
        onIngest={handleIngest}
        onSkip={() => navigateNext(sessionId, connectors, connectorIdx, router)}
        onContinue={() => navigateNext(sessionId, connectors, connectorIdx, router)}
        onBack={() => router.push('/onboarding')}
      />
    </>
  );
}

// ── Upnote Connector ──────────────────────────────────────────────────────────

function UpnoteConnector({ sessionId, connectors, connectorIdx, showToast }: ConnectorProps) {
  const router = useRouter();
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done'>('idle');
  const [result, setResult] = useState<CollectResult | null>(null);

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;
    const mdFiles = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith('.md'));
    setSelectedFiles(prev => [...prev, ...mdFiles].slice(0, 50));
  }

  function removeFile(idx: number) {
    setSelectedFiles(prev => prev.filter((_, i) => i !== idx));
  }

  async function handleIngest() {
    if (selectedFiles.length === 0) { showToast('Select at least one .md file.', 'error'); return; }
    setPhase('loading');
    try {
      const items = await Promise.all(
        selectedFiles.map(
          f => new Promise<{ markdown: string; title_hint: string; source_type_hint: string }>(
            (resolve, reject) => {
              const reader = new FileReader();
              reader.onload = e => resolve({
                markdown: e.target?.result as string,
                title_hint: f.name.replace(/\.md$/i, ''),
                source_type_hint: 'note',
              });
              reader.onerror = () => reject(new Error(`Failed to read ${f.name}`));
              reader.readAsText(f);
            }
          )
        )
      );

      const res = await fetch('/api/onboarding/collect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, connector: 'text', items }),
      });
      const body = await res.json() as {
        stored: { source_id: string }[];
        failed: { item: unknown; error: string }[];
        warnings: { source_id: string; warning: string }[];
        error?: string;
      };
      if (!res.ok) { showToast(body.error ?? `Collect failed (${res.status})`, 'error'); setPhase('idle'); return; }
      setResult({ stored: body.stored.length, failed: body.failed.length, youtubeWarnings: 0 });
      setPhase('done');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Network error', 'error');
      setPhase('idle');
    }
  }

  return (
    <>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.8rem' }}>📔 Upnote Export</h1>
        <p style={{ color: 'var(--fg-muted)', marginTop: '0.5rem' }}>
          Export your notes from Upnote as markdown files, then upload them here.
        </p>
      </header>

      {phase !== 'done' && (
        <>
          <div
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={e => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${isDragging ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 8, padding: '2rem', textAlign: 'center', cursor: 'pointer',
              background: isDragging ? 'var(--bg-card-hover)' : 'var(--bg-card)',
              color: 'var(--fg-muted)', marginBottom: '1rem',
            }}
          >
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📔</div>
            <div>Drag <code>.md</code> files here or <span style={{ color: 'var(--accent)' }}>click to browse</span></div>
            <div style={{ fontSize: '0.8rem', marginTop: '0.3rem', color: 'var(--fg-dim)' }}>
              In Upnote: select notes → Export → Markdown
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".md"
            style={{ display: 'none' }}
            onChange={e => addFiles(e.target.files)}
          />

          {selectedFiles.length > 0 && (
            <div style={{ marginBottom: '1rem' }}>
              <p style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', marginBottom: '0.5rem' }}>
                {selectedFiles.length} note{selectedFiles.length !== 1 ? 's' : ''} selected
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {selectedFiles.map((f, i) => (
                  <span
                    key={i}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.2rem 0.6rem', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 999, fontSize: '0.8rem' }}
                  >
                    {f.name.slice(0, 40)}{f.name.length > 40 ? '…' : ''}
                    <button
                      onClick={e => { e.stopPropagation(); removeFile(i); }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-dim)', padding: 0, lineHeight: 1, fontSize: '0.9rem' }}
                    >×</button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {phase === 'loading' && (
        <div style={{ padding: '2rem 0', color: 'var(--fg-muted)' }}>
          ⏳ Saving {selectedFiles.length} note{selectedFiles.length !== 1 ? 's' : ''}…
        </div>
      )}

      {phase === 'done' && result && <SummaryCard result={result} />}

      <BottomNav
        phase={phase}
        hasInput={selectedFiles.length > 0}
        onIngest={handleIngest}
        onSkip={() => navigateNext(sessionId, connectors, connectorIdx, router)}
        onContinue={() => navigateNext(sessionId, connectors, connectorIdx, router)}
        onBack={() => router.push('/onboarding')}
      />
    </>
  );
}

// ── Dispatch map ──────────────────────────────────────────────────────────────

const CONNECTOR_COMPONENTS: Record<string, ComponentType<ConnectorProps>> = {
  'url': UrlConnector,
  'file-upload': FileConnector,
  'bookmarks': BookmarksConnector,
  'upnote': UpnoteConnector,
};

// ── Page shell ────────────────────────────────────────────────────────────────

export default function ConnectorPage() {
  const params = useParams<{ connector: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast, showToast } = useToast();

  const connector = params.connector;
  const urlSessionId = searchParams.get('session_id') ?? '';

  const [sessionId, setSessionId] = useState('');
  const [connectors, setConnectors] = useState<string[]>([]);
  const [connectorIdx, setConnectorIdx] = useState(0);

  useEffect(() => {
    const sid = sessionStorage.getItem('kompl_session_id') ?? urlSessionId;
    const conns = JSON.parse(sessionStorage.getItem('kompl_connectors') ?? '[]') as string[];
    const idx = parseInt(sessionStorage.getItem('kompl_connector_idx') ?? '0', 10);
    setSessionId(sid);
    setConnectors(conns);
    setConnectorIdx(idx);
  }, [urlSessionId]);

  const progressLabel =
    connectors.length > 0 && connectorIdx < connectors.length
      ? `Step ${connectorIdx + 1} of ${connectors.length}: ${CONNECTOR_LABELS[connector] ?? connector}`
      : null;

  const Component = CONNECTOR_COMPONENTS[connector];

  if (!Component) {
    return (
      <main style={{ maxWidth: 640, margin: '8rem auto', padding: '0 1.5rem', textAlign: 'center' }}>
        <p style={{ fontSize: '2rem', marginBottom: '1rem' }}>🚧</p>
        <h2 style={{ marginBottom: '0.5rem' }}>{CONNECTOR_LABELS[connector] ?? connector}</h2>
        <p style={{ color: 'var(--fg-muted)' }}>This connector is coming soon.</p>
        <button onClick={() => router.push('/onboarding')} style={{ marginTop: '2rem' }}>
          ← Back to connector selection
        </button>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '3.5rem 1.5rem 5rem' }}>
      {progressLabel && (
        <div style={{ marginBottom: '2rem' }}>
          <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem' }}>
            {connectors.map((_, i) => (
              <div
                key={i}
                style={{ height: 4, flex: 1, borderRadius: 2, background: i <= connectorIdx ? 'var(--accent)' : 'var(--border)' }}
              />
            ))}
          </div>
          <span style={{ fontSize: '0.85rem', color: 'var(--fg-muted)' }}>{progressLabel}</span>
        </div>
      )}

      <Component
        sessionId={sessionId}
        connectors={connectors}
        connectorIdx={connectorIdx}
        showToast={showToast}
      />

      {toast}
    </main>
  );
}
