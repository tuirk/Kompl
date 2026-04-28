export const dynamic = 'force-dynamic';

import JSZip from 'jszip';
import fs from 'fs/promises';
import path from 'path';
import { NextResponse } from 'next/server';

import {
  getAllActivityLog,
  getAllAliases,
  getAllChatMessages,
  getAllCompileProgress,
  getAllDrafts,
  getAllEntityMentions,
  getAllExtractions,
  getAllPageLinks,
  getAllPagePlans,
  getAllPages,
  getAllProvenance,
  getAllRelationshipMentions,
  getAllSources,
  getExportableSettings,
  getSchemaVersion,
  pagesFilePath,
  rawFilePath,
  DATA_ROOT,
  readPageMarkdown,
  setLastBackupAt,
} from '@/lib/db';
import { yamlDoubleQuote } from '@/lib/yaml-escape';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md;
  const end = md.indexOf('\n---', 3);
  return end !== -1 ? md.slice(end + 4).trimStart() : md;
}

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

  for (const page of pages) {
    const raw = readPageMarkdown(page.page_id);
    if (raw === null) {
      console.warn(`[export] missing content for page ${page.page_id}, skipping`);
      continue;
    }
    const body = stripFrontmatter(raw);
    const folder = page.page_type || 'other';
    const filename = `${slugifyFilename(page.title)}.md`;
    zip.file(`${folder}/${filename}`, body);
  }

  return zip.generateAsync({ type: 'nodebuffer' });
}

async function buildObsidianZip(): Promise<Buffer> {
  const zip = new JSZip();
  const pages = getAllPages();
  const provenance = getAllProvenance();
  const sources = getAllSources();

  // Build source_id → title map
  const sourceTitle = new Map<string, string>(sources.map((s) => [s.source_id, s.title]));

  // Build page_id → [source titles] map
  const pageSourceTitles = new Map<string, string[]>();
  for (const prov of provenance) {
    const title = sourceTitle.get(prov.source_id);
    if (!title) continue;
    if (!pageSourceTitles.has(prov.page_id)) pageSourceTitles.set(prov.page_id, []);
    pageSourceTitles.get(prov.page_id)!.push(title);
  }

  // Index table rows
  const indexRows: string[] = ['| Title | Type | Category | Updated |', '|-------|------|----------|---------|'];

  for (const page of pages) {
    const raw = readPageMarkdown(page.page_id);
    if (raw === null) {
      console.warn(`[export] missing content for page ${page.page_id}, skipping`);
      continue;
    }
    const body = stripFrontmatter(raw);

    // Build tags array
    const tags: string[] = [page.page_type];
    if (page.category) {
      tags.push(page.category.toLowerCase().replace(/\s+/g, '-'));
    }

    // Build sources list
    const pageSources = pageSourceTitles.get(page.page_id) ?? [];
    const sourcesYaml =
      pageSources.length > 0
        ? `[${pageSources.map((t) => yamlDoubleQuote(t)).join(', ')}]`
        : '[]';

    const dateUpdated = page.last_updated ? page.last_updated.split('T')[0] : '';

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
    const includeVectors = searchParams.get('include_vectors') === 'true';
    const zip = new JSZip();
    const sources = getAllSources();
    const pages = getAllPages();

    // Fetch vectors from nlp-service if requested (before building zip)
    let vectorCount = 0;
    if (includeVectors) {
      try {
        const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';
        const vRes = await fetch(`${NLP_SERVICE_URL}/vectors/export`, {
          signal: AbortSignal.timeout(60_000),
        });
        if (vRes.ok) {
          const vData = await vRes.json() as { count: number; items: unknown[] };
          vectorCount = vData.count;
          zip.file('vectors.json', JSON.stringify(vData, null, 2));
        } else {
          console.warn(`[export] vectors/export returned ${vRes.status}, skipping vectors`);
        }
      } catch (e) {
        console.warn('[export] could not fetch vectors:', e instanceof Error ? e.message : e);
      }
    }

    zip.file(
      'manifest.json',
      JSON.stringify(
        {
          format: 'kompl',
          version: 1,
          exported_at: new Date().toISOString(),
          schema_version: getSchemaVersion(),
          source_count: sources.length,
          page_count: pages.length,
          vector_count: vectorCount,
          app_version: '2.0.0',
        },
        null,
        2
      )
    );

    const dbFolder = zip.folder('db')!;
    dbFolder.file('sources.json', JSON.stringify(sources, null, 2));
    dbFolder.file('pages.json', JSON.stringify(pages, null, 2));
    dbFolder.file('provenance.json', JSON.stringify(getAllProvenance(), null, 2));
    dbFolder.file('aliases.json', JSON.stringify(getAllAliases(), null, 2));
    dbFolder.file('extractions.json', JSON.stringify(getAllExtractions(), null, 2));
    dbFolder.file('page_links.json', JSON.stringify(getAllPageLinks(), null, 2));
    dbFolder.file('entity_mentions.json', JSON.stringify(getAllEntityMentions(), null, 2));
    dbFolder.file('relationship_mentions.json', JSON.stringify(getAllRelationshipMentions(), null, 2));
    dbFolder.file('drafts.json', JSON.stringify(getAllDrafts(), null, 2));
    dbFolder.file('activity_log.json', JSON.stringify(getAllActivityLog(), null, 2));
    dbFolder.file('compile_progress.json', JSON.stringify(getAllCompileProgress(), null, 2));
    dbFolder.file('chat_messages.json', JSON.stringify(getAllChatMessages(), null, 2));
    dbFolder.file('page_plans.json', JSON.stringify(getAllPagePlans(), null, 2));
    dbFolder.file('settings.json', JSON.stringify(getExportableSettings(), null, 2));

    const rawFolder = zip.folder('raw')!;
    for (const s of sources) {
      try {
        rawFolder.file(`${s.source_id}.md.gz`, await fs.readFile(rawFilePath(s.source_id)));
      } catch { /* skip missing source file */ }
    }

    const pagesFolder = zip.folder('pages')!;
    for (const p of pages) {
      try {
        pagesFolder.file(`${p.page_id}.md.gz`, await fs.readFile(pagesFilePath(p.page_id)));
      } catch { /* skip missing page file */ }
    }

    try {
      zip.file('schema.md', await fs.readFile(path.join(DATA_ROOT, 'schema.md'), 'utf-8'));
    } catch { /* no schema.md yet */ }

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    setLastBackupAt(new Date().toISOString());
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="kompl-export.kompl.zip"',
      },
    });
  }

  return NextResponse.json({ error: 'Invalid format. Use: markdown, obsidian, json, kompl' }, { status: 400 });
}
