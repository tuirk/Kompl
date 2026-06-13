/**
 * Tests for health.ts — checkHealth / pollHealth
 */

import { checkHealth, pollHealth, isAppReady } from '../health'

let fetchMock: jest.Mock

beforeEach(() => {
  fetchMock = jest.fn()
  global.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => jest.restoreAllMocks())

// ── checkHealth ───────────────────────────────────────────────────────────────

describe('checkHealth', () => {
  it('returns null when fetch throws (connection refused)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await checkHealth(3000)).toBeNull()
  })

  it('returns null when response is not ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 })
    expect(await checkHealth(3000)).toBeNull()
  })

  it('returns the parsed health object on success', async () => {
    const health = { status: 'ok', db_writable: true, schema_version: 14, table_count: 15, page_count: 42 }
    fetchMock.mockResolvedValue({ ok: true, json: async () => health })
    expect(await checkHealth(3000)).toEqual(health)
  })
})

// ── pollHealth ────────────────────────────────────────────────────────────────

describe('pollHealth', () => {
  it('returns health immediately when first check succeeds', async () => {
    const health = { status: 'ok', db_writable: true, schema_version: 14, table_count: 15, page_count: 0 }
    fetchMock.mockResolvedValue({ ok: true, json: async () => health })

    const result = await pollHealth(3000, 5000, 10)
    expect(result).toEqual(health)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns null when app never becomes healthy within timeout', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 })
    // Short timeout so test finishes quickly
    const result = await pollHealth(3000, 50, 10)
    expect(result).toBeNull()
  }, 2000)

  it('retries until healthy on third attempt', async () => {
    const health = { status: 'ok', db_writable: true, schema_version: 14, table_count: 15, page_count: 5 }
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, json: async () => health })

    // Long enough timeout, short interval so retries are fast
    const result = await pollHealth(3000, 5000, 10)
    expect(result).toEqual(health)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  }, 2000)

  it('accepts degraded when db is writable and schema is ready', async () => {
    const health = {
      status: 'degraded',
      db_writable: true,
      schema_version: 25,
      table_count: 20,
      page_count: 3,
      nlp_ok: false,
    }
    fetchMock.mockResolvedValue({ ok: true, json: async () => health })

    const result = await pollHealth(3000, 5000, 10)
    expect(result).toEqual(health)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects degraded when db is not writable', async () => {
    const health = {
      status: 'degraded',
      db_writable: false,
      schema_version: 25,
      table_count: 20,
      page_count: 0,
    }
    fetchMock.mockResolvedValue({ ok: true, json: async () => health })

    const result = await pollHealth(3000, 50, 10)
    expect(result).toBeNull()
  }, 2000)
})

describe('isAppReady', () => {
  it('returns true for ok', () => {
    expect(
      isAppReady({ status: 'ok', db_writable: true, schema_version: 25, table_count: 1, page_count: 0 })
    ).toBe(true)
  })

  it('returns true for degraded with db ready', () => {
    expect(
      isAppReady({ status: 'degraded', db_writable: true, schema_version: 25, table_count: 1, page_count: 0 })
    ).toBe(true)
  })

  it('returns false for degraded without schema', () => {
    expect(
      isAppReady({ status: 'degraded', db_writable: true, schema_version: 0, table_count: 0, page_count: 0 })
    ).toBe(false)
  })
})
