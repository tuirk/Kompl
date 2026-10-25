/**
 * The disagreements record (lib/disagreements.ts) as the page panel and MCP
 * read_page show it. Plain functions over rows already read; no writes.
 * Both show one finding per disagreement (lib/disagreement-duplicates.ts).
 */

import { hiddenDuplicates } from './disagreement-duplicates';
import type { Disagreement, DisagreementFinder, DisagreementKind, DisagreementStatus } from './disagreements';
import { topicKey, type PageDispute } from './page-disputes';

export interface PanelDisagreement {
  /** Stable React key. */
  key: string;
  /** null for a section the record has not synced yet (it gets no verdict buttons). */
  disagreement_id: string | null;
  kind: DisagreementKind;
  found_by: DisagreementFinder;
  status: DisagreementStatus;
  topic: string;
  /** Page text: the section's anchor in the page view. */
  anchor: string | null;
  source_ids: string[];
  /** A check's finding: the source it flagged (side b). */
  source_id: string | null;
  reason: string | null;
  found_at: string | null;
}

function sameSources(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

/**
 * The panel's rows: the disputes the shown page text records (their anchors
 * come from the page view), each with its finding's id and status, then the
 * checks' findings, duplicates left out. Matched like the commit's sync:
 * same topic or same sources.
 */
export function panelDisagreements(disputes: readonly PageDispute[], records: readonly Disagreement[]): PanelDisagreement[] {
  const textRecords = records.filter((r) => r.found_by === 'page_text');
  const used = new Set<string>();
  const rows: PanelDisagreement[] = disputes.map((d, i) => {
    const topic = topicKey(d.topic);
    const record = textRecords.find(
      (r) => !used.has(r.disagreement_id) && (topicKey(r.topic) === topic || sameSources(r.source_ids, d.sourceIds)),
    );
    if (record) used.add(record.disagreement_id);
    return {
      key: record?.disagreement_id ?? `text-${d.anchor}-${i}`,
      disagreement_id: record?.disagreement_id ?? null,
      kind: d.kind,
      found_by: 'page_text',
      status: record?.status ?? 'possible',
      topic: d.topic,
      anchor: d.anchor,
      source_ids: d.sourceIds,
      source_id: null,
      reason: null,
      found_at: record?.created_at ?? null,
    };
  });
  const hidden = hiddenDuplicates(records);
  for (const r of records) {
    if (r.found_by === 'page_text' || hidden.has(r.disagreement_id)) continue;
    rows.push({
      key: r.disagreement_id,
      disagreement_id: r.disagreement_id,
      kind: r.kind,
      found_by: r.found_by,
      status: r.status,
      topic: r.topic,
      anchor: null,
      source_ids: r.source_ids,
      source_id: r.source_b ?? r.source_ids[r.source_ids.length - 1] ?? null,
      reason: r.reason,
      found_at: r.created_at,
    });
  }
  return rows;
}

/** One finding as MCP read_page lists it (GET /api/wiki/[page_id]/data). */
export interface PageDisagreementOut {
  kind: DisagreementKind;
  status: 'possible' | 'confirmed';
  found_by: DisagreementFinder;
  topic: string;
  reason: string | null;
  /** Each source involved; n matches the page's [n] markers, null when the page does not list it. */
  sources: Array<{ n: number | null; source_id: string; title: string | null }>;
  quote_a: string | null;
  quote_b: string | null;
  found_at: string;
}

/** The findings an agent should know about: duplicates and the owner's dismissals are left out. */
export function pageDisagreementsOut(
  records: readonly Disagreement[],
  numbered: ReadonlyArray<{ n: number; source_id: string; title: string | null }>,
  titleOf: (sourceId: string) => string | null,
): PageDisagreementOut[] {
  const byId = new Map(numbered.map((s) => [s.source_id.toLowerCase(), s]));
  // Duplicates first: a twin the owner dismissed hides the undecided ones too.
  const hidden = hiddenDuplicates(records);
  return records
    .filter((r) => !hidden.has(r.disagreement_id))
    .filter((r): r is Disagreement & { status: 'possible' | 'confirmed' } => r.status !== 'dismissed')
    .map((r) => ({
      kind: r.kind,
      status: r.status,
      found_by: r.found_by,
      topic: r.topic,
      reason: r.reason,
      sources: r.source_ids.map((id) => {
        const listed = byId.get(id.toLowerCase());
        return { n: listed?.n ?? null, source_id: id, title: listed?.title ?? titleOf(id) };
      }),
      quote_a: r.quote_a,
      quote_b: r.quote_b,
      found_at: r.created_at,
    }));
}
