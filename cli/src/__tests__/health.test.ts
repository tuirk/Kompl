/**
 * Tests for health.ts — checkHealth / pollHealth
 */

import { checkHealth, pollHealth } from '../health'

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
})
