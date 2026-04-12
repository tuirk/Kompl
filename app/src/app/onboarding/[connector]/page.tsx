'use client';

/**
 * /onboarding/[connector] — Per-connector source collection screen.
 *
 * Reads session state from sessionStorage:
 *   kompl_session_id    — UUID for this onboarding run
 *   kompl_connectors    — JSON array of selected connector ids
 *   kompl_connector_idx — current index into kompl_connectors
 *
 * Active connectors: 'url', 'file-upload', 'bookmarks', 'twitter', 'upnote'
 * Unknown or coming-soon connectors show a holding screen.
 *
 * Navigation:
 *   "Ingest & continue" → calls collect API → next connector or /review
 *   "Skip for now"      → next connector or /review (no API call)
 */

import { type ComponentType, Suspense, useEffect, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';

import { useToast } from '../../../components/Toast';
import TwitterConnector from './twitter-connector';
import AppleNotesConnector from './apple-notes-connector';
import {
  type ConnectorProps,
  navigateNext,
  navigateBack,
  BTN_PRIMARY, BTN_PRIMARY_DISABLED, BTN_GHOST,
  BottomNav,
} from './_shared';

const CONNECTOR_LABELS: Record<string, string> = {
  url: 'URLs',
  'file-upload': 'Files',
  'google-drive': 'Google Drive',
  notion: 'Notion',
  bookmarks: 'Browser Bookmarks',
  twitter: 'Twitter / X Bookmarks',
  upnote: 'Upnote',
  'iphone-notes': 'iPhone Notes',
  'apple-notes': 'Apple Notes',
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
          {result.youtubeWarnings !== 1 ? 's' : ''} processed via fallback — no transcript available for this video.
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

// ── URL Connector ─────────────────────────────────────────────────────────────

function UrlConnector({ sessionId, connectors, connectorIdx, showToast, mode }: ConnectorProps) {
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
      {phase === 'done' && result && <SummaryCard result={result} />}

      {phase !== 'done' && (
        <>
          {phase === 'loading' ? (
            <div style={{
              padding: '2rem 0', fontFamily: 'var(--font-mono)', fontSize: 12,
              textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--fg-muted)',
            }}>
              Processing {urls.length} URL{urls.length !== 1 ? 's' : ''}…
            </div>
          ) : (
            <div style={{ position: 'relative', background: 'var(--bg-card)', padding: 32, isolation: 'isolate' }}>
              {/* Top-right ghost badge */}
              <span style={{
                position: 'absolute', top: 16, right: 16,
                fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '1.8px',
                textTransform: 'uppercase', color: 'rgba(137, 240, 203, 0.3)',
              }}>URL IMPORT</span>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Label row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 10,
                    letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--accent)',
                  }}>URLS</span>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '1px',
                    textTransform: 'uppercase', color: 'var(--fg-dim)', opacity: 0.5,
                  }}>
                    {urls.length > 0 ? `${urls.length} URL${urls.length !== 1 ? 's' : ''} detected` : 'one per line'}
                  </span>
                </div>

                {/* Textarea wrapper */}
                <div style={{ position: 'relative' }}>
                  <textarea
                    className="connector-textarea"
                    placeholder={`https://paulgraham.com/read.html\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ`}
                    value={urlInput}
                    onChange={e => setUrlInput(e.target.value)}
                    style={{ height: 192, padding: '16px 16px 116px', fontFamily: 'var(--font-mono)', fontSize: 14, width: '100%', boxSizing: 'border-box' }}
                  />
                  {/* Paste icon — decorative, bottom-right */}
                  <svg
                    width="32" height="32" viewBox="0 0 32 32" fill="none"
                    style={{ position: 'absolute', bottom: 16, right: 16, opacity: 0.2, pointerEvents: 'none' }}
                  >
                    <rect x="8" y="4" width="16" height="4" rx="1" stroke="white" strokeWidth="1.5"/>
                    <rect x="4" y="8" width="24" height="20" rx="2" stroke="white" strokeWidth="1.5"/>
                    <path d="M10 16H22M10 21H18" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </div>
              </div>
            </div>
          )}

          {/* Hint row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
            <div style={{ width: 8, height: 8, background: 'var(--accent)', borderRadius: '50%', flexShrink: 0 }} />
            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, color: 'var(--fg-dim)' }}>
              YouTube videos are supported — transcripts extracted automatically when available.
            </span>
          </div>
        </>
      )}

      <BottomNav
        phase={phase}
        hasInput={urls.length > 0}
        onIngest={handleIngest}
        onSkip={() => navigateNext(sessionId, connectors, connectorIdx, router, mode)}
        onContinue={() => navigateNext(sessionId, connectors, connectorIdx, router, mode)}
        onBack={() => navigateBack(sessionId, connectors, connectorIdx, router, mode)}
      />
    </>
  );
}

// ── File Upload Connector ─────────────────────────────────────────────────────

function FileConnector({ sessionId, connectors, connectorIdx, showToast, mode }: ConnectorProps) {
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
      {/* Hidden file input — must remain */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={FILE_ACCEPT}
        style={{ display: 'none' }}
        onChange={e => addFiles(e.target.files)}
      />

      {phase === 'done' && result ? (
        <>
          <SummaryCard result={result} />
          <BottomNav
            phase={phase}
            hasInput={selectedFiles.length > 0}
            onIngest={handleIngest}
            onSkip={() => navigateNext(sessionId, connectors, connectorIdx, router, mode)}
            onContinue={() => navigateNext(sessionId, connectors, connectorIdx, router, mode)}
            onBack={() => navigateBack(sessionId, connectors, connectorIdx, router, mode)}
          />
        </>
      ) : (
        <>
          {/* Two-column asymmetric layout */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 408px', gap: 32, alignItems: 'flex-start' }}>

            {/* LEFT COL — Drop zone */}
            <div>
              <div style={{ background: 'var(--bg-card)', padding: 4 }}>
                <div
                  onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={e => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}
                  onClick={() => phase !== 'loading' && fileInputRef.current?.click()}
                  style={{
                    background: '#000000',
                    border: `2px dashed ${isDragging ? 'var(--accent)' : '#47484A'}`,
                    padding: '88px 48px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 0,
                    position: 'relative',
                    isolation: 'isolate',
                    boxSizing: 'border-box',
                    minHeight: 400,
                    cursor: phase === 'loading' ? 'default' : 'pointer',
                  }}
                >
                  {/* Top-left decor */}
                  <span style={{
                    position: 'absolute', top: 12, left: 12,
                    fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.9px',
                    textTransform: 'uppercase', color: '#47484A',
                  }}>DROP.ZONE / v2</span>

                  {/* Bottom-right decor */}
                  <span style={{
                    position: 'absolute', bottom: 12, right: 12,
                    fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.9px',
                    textTransform: 'uppercase', color: '#47484A',
                  }}>MAX 50 MB / FILE</span>

                  {phase === 'loading' ? (
                    /* Loading state — drop zone shows processing text */
                    <p style={{
                      fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-dim)',
                      margin: 0, position: 'relative', zIndex: 1,
                    }}>
                      Processing {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''}…
                    </p>
                  ) : (
                    /* Idle state — drop zone content */
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32, position: 'relative', zIndex: 1 }}>
                      {/* Icon row */}
                      <div style={{ display: 'flex', gap: 16 }}>
                        {/* Document icon */}
                        <div style={{ width: 64, height: 64, background: 'var(--bg-card-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <svg width="19" height="24" viewBox="0 0 19 24" fill="none">
                            <path d="M11 1H3C1.9 1 1 1.9 1 3V21C1 22.1 1.9 23 3 23H16C17.1 23 18 22.1 18 21V8L11 1Z" stroke="white" strokeWidth="1.5"/>
                            <path d="M11 1V8H18" stroke="white" strokeWidth="1.5"/>
                          </svg>
                        </div>
                        {/* Image icon */}
                        <div style={{ width: 64, height: 64, background: 'var(--bg-card-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <svg width="24" height="19" viewBox="0 0 24 19" fill="none">
                            <rect x="1" y="1" width="22" height="17" rx="1" stroke="white" strokeWidth="1.5"/>
                            <circle cx="7" cy="7" r="2" stroke="white" strokeWidth="1.5"/>
                            <path d="M1 13L8 8L13 12L17 9L23 14" stroke="white" strokeWidth="1.5"/>
                          </svg>
                        </div>
                        {/* Audio/wave icon */}
                        <div style={{ width: 64, height: 64, background: 'var(--bg-card-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                            <path d="M11 3V19M7 6V16M3 9V13M15 6V16M19 9V13" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                          </svg>
                        </div>
                      </div>

                      {/* Heading */}
                      <h2 style={{
                        fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 20,
                        letterSpacing: '-0.5px', textTransform: 'uppercase',
                        color: 'var(--fg)', textAlign: 'center', margin: 0,
                      }}>Drop Files Here</h2>

                      {/* Subtitle */}
                      <p style={{
                        fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '0.6px',
                        textTransform: 'uppercase', color: 'var(--fg-dim)',
                        textAlign: 'center', margin: 0,
                      }}>PDF · Markdown · Word · Audio</p>

                      {/* Browse button */}
                      <button
                        onClick={e => { e.stopPropagation(); fileInputRef.current?.click(); }}
                        style={{
                          background: 'var(--accent)', color: 'var(--accent-text)',
                          padding: '12px 32px', border: 'none', cursor: 'pointer',
                          fontFamily: 'var(--font-heading)', fontWeight: 700,
                          fontSize: 12, letterSpacing: '1.2px', textTransform: 'uppercase',
                        }}
                      >Browse Files</button>
                    </div>
                  )}
                </div>
              </div>

              {/* File count below drop zone */}
              {selectedFiles.length > 0 && (
                <p style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '1px',
                  textTransform: 'uppercase', color: 'var(--accent)', marginTop: 8,
                }}>
                  {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''} selected{selectedFiles.length >= 20 ? ' (max 20)' : ''}
                </p>
              )}
            </div>

            {/* RIGHT COL — Queue panel */}
            <div style={{
              background: 'var(--bg-card-hover)', padding: 24,
              display: 'flex', flexDirection: 'column', gap: 0,
              justifyContent: 'space-between', height: '100%',
            }}>
              {/* Header row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '2px',
                  textTransform: 'uppercase', color: 'var(--accent)',
                }}>INGESTION QUEUE</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: '#757578' }}>
                  {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''}
                </span>
              </div>

              {/* File list */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
                {selectedFiles.map((f, i) => {
                  const ext = f.name.includes('.') ? f.name.split('.').pop()?.toUpperCase() ?? '' : '';
                  const displayName = f.name.length > 20 ? f.name.slice(0, 20) + '…' : f.name;
                  return (
                    <div key={i} style={{
                      background: 'var(--bg-card)', borderLeft: '2px solid var(--accent)',
                      padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                        <div style={{ width: 18, height: 18, background: 'var(--accent)', flexShrink: 0 }} />
                        <div>
                          <div style={{
                            fontFamily: 'var(--font-heading)', fontWeight: 500, fontSize: 14,
                            letterSpacing: '-0.35px', color: 'var(--fg)',
                          }}>{displayName}</div>
                          <div style={{
                            fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase',
                            color: '#757578',
                          }}>{ext}</div>
                        </div>
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); removeFile(i); }}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: '#757578', fontSize: 13, padding: 0, lineHeight: 1,
                        }}
                      >×</button>
                    </div>
                  );
                })}

                {/* Empty slot rows to fill space when fewer than 3 files */}
                {Array.from({ length: Math.max(0, 3 - selectedFiles.length) }).map((_, i) => (
                  <div key={`empty-${i}`} style={{
                    background: '#000000', opacity: 0.3,
                    border: '1px solid rgba(71,72,74,0.1)',
                    padding: 16, display: 'flex', alignItems: 'center',
                    justifyContent: 'center', height: 64, boxSizing: 'border-box',
                  }}>
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '1px',
                      textTransform: 'uppercase', color: '#757578',
                    }}>WAITING FOR FILES</span>
                  </div>
                ))}
              </div>

              {/* Hint box */}
              <div style={{ marginTop: 32, background: 'rgba(74,178,144,0.1)', border: '1px solid rgba(137,240,203,0.2)', padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{
                    width: 11, height: 11, background: 'var(--accent)',
                    borderRadius: '50%', flexShrink: 0, marginTop: 2,
                  }} />
                  <span style={{
                    fontFamily: 'var(--font-body)', fontSize: 11, letterSpacing: '0.275px',
                    textTransform: 'uppercase', color: '#7BE2BD',
                  }}>
                    Max 50 MB per file · PDF, DOCX, PPTX, XLSX, TXT, MD, HTML, CSV, images, audio supported
                  </span>
                </div>
              </div>
            </div>
          </div>

          <BottomNav
            phase={phase}
            hasInput={selectedFiles.length > 0}
            onIngest={handleIngest}
            onSkip={() => navigateNext(sessionId, connectors, connectorIdx, router, mode)}
            onContinue={() => navigateNext(sessionId, connectors, connectorIdx, router, mode)}
            onBack={() => navigateBack(sessionId, connectors, connectorIdx, router, mode)}
          />
        </>
      )}
    </>
  );
}

// ── Bookmarks Connector ───────────────────────────────────────────────────────

function BookmarksConnector({ sessionId, connectors, connectorIdx, showToast, mode }: ConnectorProps) {
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
        onSkip={() => navigateNext(sessionId, connectors, connectorIdx, router, mode)}
        onContinue={() => navigateNext(sessionId, connectors, connectorIdx, router, mode)}
        onBack={() => navigateBack(sessionId, connectors, connectorIdx, router, mode)}
      />
    </>
  );
}

// ── Upnote Connector ──────────────────────────────────────────────────────────

function UpnoteConnector({ sessionId, connectors, connectorIdx, showToast, mode }: ConnectorProps) {
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
        onSkip={() => navigateNext(sessionId, connectors, connectorIdx, router, mode)}
        onContinue={() => navigateNext(sessionId, connectors, connectorIdx, router, mode)}
        onBack={() => navigateBack(sessionId, connectors, connectorIdx, router, mode)}
      />
    </>
  );
}

// ── Connector metadata (title + subtitle rendered by the page shell) ──────────

const CONNECTOR_META: Record<string, { title: string; subtitle: string }> = {
  url:           { title: 'Add URLs',          subtitle: 'Paste web pages, articles, or YouTube links — one per line.' },
  'file-upload': { title: 'Upload Files',      subtitle: 'PDF, Markdown, Word, Excel, audio — all formats supported.' },
  bookmarks:     { title: 'Browser Bookmarks', subtitle: 'Export your bookmarks from Chrome, Firefox, or Safari.' },
  twitter:       { title: 'Twitter / X',       subtitle: 'Upload your exported Twitter bookmarks file.' },
  upnote:        { title: 'Upnote',            subtitle: 'Export your notes from Upnote and upload as Markdown.' },
  'apple-notes': { title: 'Apple Notes',       subtitle: 'Export and upload your Apple Notes as files.' },
};

// ── Dispatch map ──────────────────────────────────────────────────────────────

const CONNECTOR_COMPONENTS: Record<string, ComponentType<ConnectorProps>> = {
  'url': UrlConnector,
  'file-upload': FileConnector,
  'bookmarks': BookmarksConnector,
  'twitter': TwitterConnector,
  'upnote': UpnoteConnector,
  'apple-notes': AppleNotesConnector,
};

// ── Page shell ────────────────────────────────────────────────────────────────

function ConnectorPageInner() {
  const params = useParams<{ connector: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast, showToast } = useToast();

  const connector = params.connector;
  const urlSessionId = searchParams.get('session_id') ?? '';
  const mode = searchParams.get('mode') ?? '';

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

  const Component = CONNECTOR_COMPONENTS[connector];
  const meta = CONNECTOR_META[connector];
  const hasProgress = connectors.length > 0 && connectorIdx < connectors.length;

  if (!Component) {
    return (
      <main style={{ maxWidth: 1040, margin: '0 auto', padding: '1.5rem 40px 2.5rem' }}>
        <h2 style={{ fontFamily: 'var(--font-heading)', color: 'var(--fg-dim)', marginBottom: '0.5rem' }}>
          {CONNECTOR_LABELS[connector] ?? connector}
        </h2>
        <p style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-body)', fontSize: 13 }}>This connector is coming soon.</p>
        <button
          onClick={() => router.push(`/onboarding${mode === 'add' ? '?mode=add' : ''}`)}
          style={{ marginTop: '2rem', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--fg-dim)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          ← Back
        </button>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '1.5rem 40px 2.5rem' }}>

      {/* Progress tracker */}
      {hasProgress && (
        <div style={{ paddingBottom: 48 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px',
              letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--accent)',
            }}>
              {CONNECTOR_LABELS[connector] ?? connector}
            </span>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px',
              letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--fg-dim)',
            }}>
              Step {connectorIdx + 1} of {connectors.length}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}>
            {connectors.map((_, i) => (
              <div key={i} style={{
                flex: 1, height: 4,
                background: i <= connectorIdx ? 'var(--accent)' : '#242629',
              }} />
            ))}
          </div>
        </div>
      )}

      {/* Connector header — left accent border + title + subtitle */}
      {meta && (
        <div style={{ borderLeft: '2px solid var(--accent)', paddingLeft: 24, marginBottom: 32 }}>
          <h1 style={{
            fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 48,
            lineHeight: '48px', letterSpacing: '-2.4px', color: 'var(--fg)', margin: 0,
          }}>
            {meta.title}
          </h1>
          <p style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: '15px',
            letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--fg-dim)',
            margin: '8px 0 0',
          }}>
            {meta.subtitle}
          </p>
        </div>
      )}

      <Component
        sessionId={sessionId}
        connectors={connectors}
        connectorIdx={connectorIdx}
        showToast={showToast}
        mode={mode}
      />

      {toast}
    </main>
  );
}

export default function ConnectorPage() {
  return <Suspense><ConnectorPageInner /></Suspense>;
}
