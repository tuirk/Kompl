'use client';

/**
 * Kompl v2 — onboarding screen (commit 3).
 *
 * "Where's your knowledge scattered?" — grid of 7 source cards. URL paste
 * and file upload are real; the other 5 are coming-soon placeholders that
 * pop a toast.
 *
 * Contracts: see docs/contracts.md. This page calls:
 *   POST /api/ingest/url     with {urls: string[]}
 *   POST /api/ingest/upload  with FormData (key: "files")
 * Both return {accepted: number, source_ids: string[]} on 2xx, or
 * {error: string} on failure.
 */

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { SourceCard } from '../components/SourceCard';
import { useToast } from '../components/Toast';

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

export default function HomePage() {
  const router = useRouter();
  const { toast, showToast } = useToast();

  const [urlInput, setUrlInput] = useState('');
  const [submittingUrls, setSubmittingUrls] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [submittingFiles, setSubmittingFiles] = useState(false);

  async function handleUrlSubmit() {
    if (submittingUrls) return;
    const { urls, invalid } = parseUrls(urlInput);
    if (urls.length === 0) {
      showToast('Paste at least one http(s) URL.', 'error');
      return;
    }
    if (invalid.length > 0) {
      showToast(`Skipping ${invalid.length} invalid line(s).`);
    }
    setSubmittingUrls(true);
    try {
      const res = await fetch('/api/ingest/url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
      const body = (await res.json()) as { accepted?: number; source_ids?: string[]; error?: string };
      if (!res.ok) {
        showToast(body.error ?? `Ingest failed (${res.status})`, 'error');
        return;
      }
      showToast(`Accepted ${body.accepted ?? urls.length} URL(s). Redirecting…`);
      router.push('/feed');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Network error', 'error');
    } finally {
      setSubmittingUrls(false);
    }
  }

  async function handleFileSubmit() {
    if (submittingFiles) return;
    const files = fileInputRef.current?.files;
    if (!files || files.length === 0) {
      showToast('Pick one or more files first.', 'error');
      return;
    }
    setSubmittingFiles(true);
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append('files', f);
      const res = await fetch('/api/ingest/upload', { method: 'POST', body: fd });
      const body = (await res.json()) as { accepted?: number; source_ids?: string[]; error?: string };
      if (!res.ok) {
        showToast(body.error ?? `Upload failed (${res.status})`, 'error');
        return;
      }
      showToast(`Accepted ${body.accepted ?? files.length} file(s). Redirecting…`);
      router.push('/feed');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Network error', 'error');
    } finally {
      setSubmittingFiles(false);
    }
  }

  return (
    <main
      style={{
        maxWidth: 1040,
        margin: '0 auto',
        padding: '3.5rem 1.5rem 5rem',
      }}
    >
      <header style={{ marginBottom: '2.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '2.2rem', lineHeight: 1.15 }}>
          Where&apos;s your knowledge scattered?
        </h1>
        <p
          style={{
            color: 'var(--fg-muted)',
            fontSize: '1.05rem',
            marginTop: '0.75rem',
            maxWidth: 640,
          }}
        >
          Drop your sources. Kompl will build you a wiki.
        </p>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: '1.1rem',
        }}
      >
        <SourceCard
          icon="🔗"
          title="Paste a URL"
          description="One URL per line. Articles, docs, blog posts."
          status="active"
        >
          <textarea
            rows={5}
            placeholder={'https://en.wikipedia.org/wiki/Bitcoin\nhttps://en.wikipedia.org/wiki/Ethereum'}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            disabled={submittingUrls}
            style={{ resize: 'vertical', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13 }}
          />
          <button
            onClick={handleUrlSubmit}
            disabled={submittingUrls}
            style={{ marginTop: '0.6rem' }}
          >
            {submittingUrls ? 'Ingesting…' : 'Ingest'}
          </button>
        </SourceCard>

        <SourceCard
          icon="📄"
          title="Upload a file"
          description="PDF, DOCX, PPTX, XLSX, HTML, CSV, images, audio."
          status="active"
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={FILE_ACCEPT}
            disabled={submittingFiles}
          />
          <button
            onClick={handleFileSubmit}
            disabled={submittingFiles}
            style={{ marginTop: '0.6rem' }}
          >
            {submittingFiles ? 'Uploading…' : 'Upload'}
          </button>
        </SourceCard>

        <SourceCard
          icon="🗂️"
          title="Google Drive"
          description="Sync your Drive documents automatically."
          status="coming-soon"
          onClick={() => showToast('Coming soon — Drive OAuth lands in commit 14.')}
        />
        <SourceCard
          icon="☁️"
          title="OneDrive"
          description="Same, but for Microsoft 365."
          status="coming-soon"
          onClick={() => showToast('Coming soon — same timeline as Drive.')}
        />
        <SourceCard
          icon="🔖"
          title="Browser bookmarks"
          description="Export your bookmarks HTML/JSON and drop it in."
          status="coming-soon"
          onClick={() => showToast('Coming soon — export support lands in commit 9.')}
        />
        <SourceCard
          icon="𝕏"
          title="Twitter / X bookmarks"
          description="The good posts you already starred."
          status="coming-soon"
          onClick={() => showToast('Coming soon — bookmark JSON support lands in commit 9.')}
        />
        <SourceCard
          icon="▶"
          title="YouTube"
          description="Transcripts, not videos. Paste a link."
          status="coming-soon"
          onClick={() => showToast('Coming soon — transcript ingest lands in commit 8.')}
        />
      </div>

      <footer style={{ marginTop: '3rem', color: 'var(--fg-muted)', fontSize: '0.9rem' }}>
        <a href="/feed">→ Processing feed</a>
      </footer>

      {toast}
    </main>
  );
}
