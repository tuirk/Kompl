/**
 * GET /api/compile/progress/items?session_id=X&step=Y
 *
 * Per-step item aggregator for the progress-page expand-to-reveal UI.
 * Returns a uniform `{ items: [{id, label, status, error?}, …] }` shape by
 * branching on `step` and reading from the appropriate existing table:
 *
 *   ingest_files / ingest_urls / ingest_texts → collect_staging
 *   extract                                    → sources ⨝ extractions
 *   plan / draft / crossref                    → page_plans
 *   commit                                     → pages
 *   resolve / match / schema / health_check    → atomic step → []
 *
 * No new state table — everything we render already exists in v22+ schema.
 * UI shows the activity_log tail (via /events) for atomic steps that have
 * no per-item data.
 */

import { NextResponse } from 'next/server';
import { COMPILE_STEP_KEYS, type CompileStepKey } from '../../../../../lib/compile-steps';
import {
  getStagingBySession,
  getSourcesForSessionWithExtractStatus,
  getAllPagePlansBySession,
  getPagesForSession,
} from '../../../../../lib/db';

interface Item {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  error?: string;
}

const FILE_CONNECTORS = new Set(['file-upload']);
const URL_CONNECTORS = new Set(['url', 'saved-link', 'twitter']);
const TEXT_CONNECTORS = new Set(['text', 'paste']);

function mapStagingStatus(s: string): Item['status'] {
  if (s === 'pending') return 'pending';
  if (s === 'ingesting') return 'running';
  if (s === 'ingested') return 'done';
  if (s === 'failed') return 'failed';
  return 'pending';
}

function mapDraftStatus(s: string, step: 'plan' | 'draft' | 'crossref'): Item['status'] {
  if (s === 'failed') return 'failed';
  if (step === 'plan') {
    // any plan row exists ⇒ planned (= done for the plan step)
    return 'done';
  }
  if (step === 'draft') {
    if (['drafted', 'crossreffed', 'committed', 'pending_approval'].includes(s)) return 'done';
    if (s === 'draft_too_thin') return 'failed';
    return 'pending';
  }
  // crossref
  if (['crossreffed', 'committed'].includes(s)) return 'done';
  return 'pending';
}

// `payload` is pre-parsed by parseStagingRow in db.ts (Record<string, unknown>).
// Per-connector schemas vary; defensively accept missing/wrong-type fields.

function fileLabel(p: Record<string, unknown>): string {
  const filePath = p['file_path'];
  if (typeof filePath === 'string') {
    const parts = filePath.split(/[/\\]/);
    return parts[parts.length - 1] || 'unnamed file';
  }
  if (typeof p['title_hint'] === 'string') return p['title_hint'];
  if (typeof p['filename'] === 'string') return p['filename'];
  return 'unnamed file';
}

function urlLabel(p: Record<string, unknown>): string {
  if (typeof p['title'] === 'string') return p['title'];
  if (typeof p['url'] === 'string') return p['url'];
  return 'unnamed URL';
}

function textLabel(p: Record<string, unknown>): string {
  if (typeof p['title'] === 'string') return p['title'];
  if (typeof p['title_hint'] === 'string') return p['title_hint'];
  return 'untitled note';
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const session_id = url.searchParams.get('session_id');
  const stepRaw = url.searchParams.get('step');

  if (!session_id) {
    return NextResponse.json({ error: 'session_id_required' }, { status: 400 });
  }
  if (!stepRaw || !(COMPILE_STEP_KEYS as readonly string[]).includes(stepRaw)) {
    return NextResponse.json({ error: 'invalid_step' }, { status: 400 });
  }
  const step = stepRaw as CompileStepKey;

  let items: Item[] = [];

  switch (step) {
    case 'ingest_files': {
      items = getStagingBySession(session_id)
        .filter((r) => FILE_CONNECTORS.has(r.connector))
        .map((r) => ({
          id: r.stage_id,
          label: fileLabel(r.payload),
          status: mapStagingStatus(r.status),
          error: r.error_message ?? undefined,
        }));
      break;
    }
    case 'ingest_urls': {
      items = getStagingBySession(session_id)
        .filter((r) => URL_CONNECTORS.has(r.connector))
        .map((r) => ({
          id: r.stage_id,
          label: urlLabel(r.payload),
          status: mapStagingStatus(r.status),
          error: r.error_message ?? undefined,
        }));
      break;
    }
    case 'ingest_texts': {
      items = getStagingBySession(session_id)
        .filter((r) => TEXT_CONNECTORS.has(r.connector))
        .map((r) => ({
          id: r.stage_id,
          label: textLabel(r.payload),
          status: mapStagingStatus(r.status),
          error: r.error_message ?? undefined,
        }));
      break;
    }
    case 'extract': {
      items = getSourcesForSessionWithExtractStatus(session_id).map((s) => ({
        id: s.source_id,
        label: s.title,
        status: s.extracted ? 'done' : 'pending',
      }));
      break;
    }
    case 'plan':
    case 'draft':
    case 'crossref': {
      items = getAllPagePlansBySession(session_id).map((p) => ({
        id: p.plan_id,
        label: p.title,
        status: mapDraftStatus(p.draft_status, step),
        // page_plans.draft_error is populated by updatePlanFailed (schema v24).
        // Surface it on the draft step so the UI's expand-to-reveal panel
        // shows WHY a plan failed (was silent before; users had to grep app logs).
        ...(step === 'draft' && p.draft_error ? { error: p.draft_error } : {}),
      }));
      break;
    }
    case 'commit': {
      items = getPagesForSession(session_id).map((p) => ({
        id: p.page_id,
        label: p.title,
        status: 'done',
      }));
      break;
    }
    case 'health_check':
    case 'resolve':
    case 'match':
    case 'schema':
    default: {
      // Atomic step — no per-item state table. UI shows /events tail instead.
      items = [];
      break;
    }
  }

  return NextResponse.json({ session_id, step, items });
}
