export const dynamic = 'force-dynamic';

import JSZip from 'jszip';
import { NextResponse } from 'next/server';

import {
  getAllPages,
  getAllProvenance,
  getAllSources,
  readPageMarkdown,
  setLastBackupAt,
} from '@/lib/db';
import { yamlDoubleQuote } from '@/lib/yaml-escape';
import { buildKomplBackup } from '@/lib/kompl-backup';
import { exportPageBody } from '@/lib/page-export';
import { getSourceTitleSet } from '@/lib/page-sources';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugifyFilename(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'page'
  );
}

// ---------------------------------------------------------------------------
// Format handlers
// ---------------------------------------------------------------------------

async function buildMarkdownZip(): Promise<Buffer> {
  const zip = new JSZip();
  const pages = getAllPages();
  const sourceTitles = getSourceTitleSet();
  const isKnownTitle = (t: string) => sourceTitles.has(t.toLowerCase());

  for (const page of pages) {
    const raw = readPageMarkdown(page.page_id);
    if (raw === null) {
      console.warn(`[export] missing content for page ${page.page_id}, skipping`);
      continue;
    }
    const { body } = exportPageBody(page.page_id, raw, isKnownTitle);
    const folder = page.page_type || 'other';
    const filename = `${slugifyFilename(page.title)}.md`;
    zip.file(`${folder}/${filename}`, body);
  }

  return zip.generateAsync({ type: 'nodebuffer' });
}

async function buildObsidianZip(): Promise<Buffer> {
  const zip = new JSZip();
  const pages = getAllPages();
  const knownSourceTitles = getSourceTitleSet();
  const isKnownTitle = (t: string) => knownSourceTitles.has(t.toLowerCase());

  // Index table rows
  const indexRows: string[] = ['| Title | Type | Category | Updated |', '|-------|------|----------|---------|'];

  for (const page of pages) {
    const raw = readPageMarkdown(page.page_id);
    if (raw === null) {
      console.warn(`[export] missing content for page ${page.page_id}, skipping`);
      continue;
    }
    // Numbered footnotes with definitions; sources listed once each, cited first.
    const { body, sourceTitles: pageSources } = exportPageBody(page.page_id, raw, isKnownTitle);

    // Build tags array
    const tags: string[] = [page.page_type];
    if (page.category) {
      tags.push(page.category.toLowerCase().replace(/\s+/g, '-'));
    }

    const sourcesYaml =
      pageSources.length > 0
        ? `[${pageSources.map((t) => yamlDoubleQuote(t)).join(', ')}]`
        : '[]';

    // SQLite timestamps are "YYYY-MM-DD HH:MM:SS"; ISO strings use "T".
    const dateUpdated = page.last_updated ? page.last_updated.split(/[T ]/)[0] : '';

    const frontmatter =
      `---\n` +
      `title: ${yamlDoubleQuote(page.title)}\n` +
      `tags: [${tags.join(', ')}]\n` +
      `sources: ${sourcesYaml}\n` +
      `date_updated: ${dateUpdated}\n` +
      `---\n\n`;

    zip.file(`${page.title}.md`, frontmatter + body);

    indexRows.push(
      `| [[${page.title}]] | ${page.page_type} | ${page.category ?? ''} | ${dateUpdated} |`
    );
  }

  zip.file('_index.md', `# Wiki Index\n\n${indexRows.join('\n')}\n`);

  return zip.generateAsync({ type: 'nodebuffer' });
}

function buildJsonExport(): string {
  const pages = getAllPages();
  const sources = getAllSources();
  const provenance = getAllProvenance();

  // Build page_id → [source_id] map
  const pageSourceIds = new Map<string, string[]>();
  for (const prov of provenance) {
    if (!pageSourceIds.has(prov.page_id)) pageSourceIds.set(prov.page_id, []);
    pageSourceIds.get(prov.page_id)!.push(prov.source_id);
  }

  const pageExports = [];
  for (const page of pages) {
    const content = readPageMarkdown(page.page_id);
    if (content === null) {
      console.warn(`[export] missing content for page ${page.page_id}, skipping`);
      continue;
    }
    pageExports.push({
      page_id: page.page_id,
      title: page.title,
      page_type: page.page_type,
      category: page.category ?? null,
      summary: page.summary ?? null,
      content,
      sources: pageSourceIds.get(page.page_id) ?? [],
      last_updated: page.last_updated,
    });
  }

  const data = {
    exported_at: new Date().toISOString(),
    page_count: pageExports.length,
    source_count: sources.length,
    pages: pageExports,
    sources: sources.map((s) => ({
      source_id: s.source_id,
      title: s.title,
      source_type: s.source_type,
      source_url: s.source_url ?? null,
      date_ingested: s.date_ingested,
    })),
    provenance: provenance.map((p) => ({
      source_id: p.source_id,
      page_id: p.page_id,
      contribution_type: p.contribution_type,
      date_compiled: p.date_compiled,
    })),
  };

  return JSON.stringify(data, null, 2);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const format = searchParams.get('format');

  if (format === 'markdown') {
    const buffer = await buildMarkdownZip();
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="kompl-wiki-markdown.zip"',
      },
    });
  }

  if (format === 'obsidian') {
    const buffer = await buildObsidianZip();
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="kompl-wiki-obsidian.zip"',
      },
    });
  }

  if (format === 'json') {
    const json = buildJsonExport();
    return new NextResponse(json, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="kompl-wiki-export.json"',
      },
    });
  }

  if (format === 'kompl') {
    const buffer = await buildKomplBackup({ includeVectors: searchParams.get('include_vectors') === 'true' });
    setLastBackupAt(new Date().toISOString());
    // A view of the zip, not a copy: a large wiki's backup is held once.
    return new NextResponse(new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="kompl-export.kompl.zip"',
      },
    });
  }

  return NextResponse.json({ error: 'Invalid format. Use: markdown, obsidian, json, kompl' }, { status: 400 });
}
