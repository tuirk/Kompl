/**
 * POST /api/compile/backfill-vectors
 *
 * Idempotent endpoint that upserts any wiki pages not yet in the Chroma
 * vector store. Safe to call anytime — already-indexed pages are skipped.
 *
 * Use this when:
 *   - NLP service was down when pages were committed (fire-and-forget missed)
 *   - Pages existed before commit 7 was deployed (no vector store yet)
 *   - Manual re-index is needed after vector store corruption
 *
 * Response: { total, upserted, already_indexed, errors }
 */

import { NextResponse } from 'next/server';
import { getAllPages } from '@/lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

export async function POST() {
  try {
    const allPages = getAllPages();

    if (allPages.length === 0) {
      return NextResponse.json({
        total: 0,
        upserted: 0,
        already_indexed: 0,
        errors: 0,
      });
    }

    const pageIds = allPages.map((p) => p.page_id);
    const metadataMap: Record<
      string,
      { title: string; page_type: string; category: string; source_count: number }
    > = {};
    for (const p of allPages) {
      metadataMap[p.page_id] = {
        title: p.title,
        page_type: p.page_type,
        category: p.category ?? '',
        source_count: p.source_count ?? 0,
      };
    }

    const res = await fetch(`${NLP_SERVICE_URL}/vectors/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_ids: pageIds, metadata_map: metadataMap }),
      signal: AbortSignal.timeout(300_000), // 5 min — large wikis may take a while
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'unknown');
      return NextResponse.json(
        { error: `backfill_failed: ${errText}` },
        { status: 502 },
      );
    }

    const result = (await res.json()) as {
      total: number;
      upserted: number;
      already_indexed: number;
      errors: number;
    };

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
