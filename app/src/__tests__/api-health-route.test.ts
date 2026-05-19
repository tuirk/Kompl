import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '../app/api/health/route';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

describe('GET /api/health — additive fields for pre-stage health table', () => {
  let handle: TestDbHandle;

  beforeEach(() => {
    handle = setupTestDb();
  });

  afterEach(() => {
    handle.cleanup();
  });

  async function getBody(): Promise<Record<string, unknown>> {
    const res = await GET();
    return (await res.json()) as Record<string, unknown>;
  }

  it('returns selected_compile_model as a non-empty string', async () => {
    const body = await getBody();
    expect(typeof body.selected_compile_model).toBe('string');
    expect((body.selected_compile_model as string).length).toBeGreaterThan(0);
  });

  it('returns selected_compile_provider as gemini or deepseek', async () => {
    const body = await getBody();
    expect(['gemini', 'deepseek']).toContain(body.selected_compile_provider);
  });

  it('returns selected_compile_provider matching the model prefix', async () => {
    const body = await getBody();
    const model = body.selected_compile_model as string;
    const provider = body.selected_compile_provider as string;
    if (model.startsWith('deepseek-')) {
      expect(provider).toBe('deepseek');
    } else {
      expect(provider).toBe('gemini');
    }
  });

  it('returns integration_keys.firecrawl_present as a boolean', async () => {
    const body = await getBody();
    const integ = body.integration_keys as Record<string, unknown> | undefined;
    expect(integ).toBeDefined();
    expect(typeof integ!.firecrawl_present).toBe('boolean');
  });

  it('returns integration_keys.youtube_present as a boolean', async () => {
    const body = await getBody();
    const integ = body.integration_keys as Record<string, unknown> | undefined;
    expect(typeof integ!.youtube_present).toBe('boolean');
  });

  it('integration_keys.firecrawl_present reflects process.env.FIRECRAWL_API_KEY', async () => {
    const prev = process.env.FIRECRAWL_API_KEY;
    process.env.FIRECRAWL_API_KEY = 'test-key-for-presence-check';
    try {
      const body = await getBody();
      expect((body.integration_keys as Record<string, boolean>).firecrawl_present).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.FIRECRAWL_API_KEY;
      else process.env.FIRECRAWL_API_KEY = prev;
    }
  });

  it('integration_keys.youtube_present reflects process.env.YOUTUBE_API_KEY absence', async () => {
    const prev = process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    try {
      const body = await getBody();
      expect((body.integration_keys as Record<string, boolean>).youtube_present).toBe(false);
    } finally {
      if (prev !== undefined) process.env.YOUTUBE_API_KEY = prev;
    }
  });
});

describe('GET /api/health — regression: stage-1 grep targets preserved', () => {
  let handle: TestDbHandle;

  beforeEach(() => {
    handle = setupTestDb();
  });

  afterEach(() => {
    handle.cleanup();
  });

  it('preserves all field names asserted by scripts/integration-test.sh stage 1', async () => {
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    // grep -q '"status":...'
    expect(typeof body.status).toBe('string');
    expect(['ok', 'degraded']).toContain(body.status);
    // grep -q '"nlp_ok":...'
    expect(typeof body.nlp_ok).toBe('boolean');
    // grep -q '"db_writable":true'
    expect(typeof body.db_writable).toBe('boolean');
    // grep -q '"schema_version":...'
    expect(typeof body.schema_version).toBe('number');
    // grep -q '"table_count":...'
    expect(typeof body.table_count).toBe('number');
    // grep -q '"tables":[...,"ingest_failures",...]
    expect(Array.isArray(body.tables)).toBe(true);
    const tables = body.tables as string[];
    expect(tables).toContain('ingest_failures');
    expect(tables).toContain('vector_backfill_queue');
    expect(tables).toContain('entity_mentions');
    expect(tables).toContain('relationship_mentions');
    // provider_keys still present with both LLM fields (Phase 1 pre-existing)
    const pk = body.provider_keys as Record<string, unknown>;
    expect(typeof pk.gemini_present).toBe('boolean');
    expect(typeof pk.deepseek_present).toBe('boolean');
  });
});
