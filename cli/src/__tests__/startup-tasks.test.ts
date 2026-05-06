/**
 * Regression tests for startup-tasks.ts
 *
 * Key regression: Fix 1 — lint endpoint returning non-ok HTTP status must NOT
 * show a false "done" success message. Before the fix, missing r.ok check meant
 * a 500 response with JSON body `{"error":"..."}` would produce `● done (undefinedms)`.
 */

import { runStartupTasks } from '../startup-tasks'

type MockResponse = Partial<Response> & { ok: boolean; status?: number; json?: () => Promise<unknown> }

function makeSettings(overrides: {
  last_lint_at?: string | null
  last_backup_at?: string | null
} = {}): MockResponse {
  return {
    ok: true,
    json: async () => ({
      last_lint_at: null,
      last_backup_at: new Date().toISOString(), // not overdue
      ...overrides,
    }),
  }
}

const baseConfig = { port: 3000, projectDir: '/tmp/kompl' }

let fetchMock: jest.Mock
let stdoutSpy: jest.SpyInstance

beforeEach(() => {
  fetchMock = jest.fn()
  global.fetch = fetchMock as unknown as typeof fetch
  stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(() => {
  jest.restoreAllMocks()
})

// ── regression: Fix 1 ────────────────────────────────────────────────────────

it('shows failed when lint endpoint returns non-ok status (regression Fix 1)', async () => {
  fetchMock
    .mockResolvedValueOnce(makeSettings({ last_lint_at: null }))   // settings: lint overdue
    .mockResolvedValueOnce({ ok: false, status: 500 } as MockResponse) // lint: 500

  await runStartupTasks(baseConfig)

  const output = stdoutSpy.mock.calls.map(([s]) => String(s)).join('')
  expect(output).toContain('failed (500)')
  expect(output).not.toContain('done (')
})

it('does NOT show false success when lint returns JSON error body (regression Fix 1)', async () => {
  // A JSON error body like {"error":"db locked"} — before fix this parsed as
  // {skipped:undefined, run_duration_ms:undefined} → "done (undefinedms)"
  fetchMock
    .mockResolvedValueOnce(makeSettings({ last_lint_at: null }))
    .mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: 'service unavailable' }),
    } as MockResponse)

  await runStartupTasks(baseConfig)

  const output = stdoutSpy.mock.calls.map(([s]) => String(s)).join('')
  expect(output).not.toMatch(/done \(\d*ms\)/)
  expect(output).not.toContain('undefinedms')
})

// ── no-gate regression ───────────────────────────────────────────────────────

it('runs lint and backup even when settings response has no deployment_mode key (regression: do not re-introduce the gate)', async () => {
  // The deployment_mode toggle was removed in 2026-05-06 (chore/strip-deployment-mode).
  // This test guards against accidentally re-adding an early-return gate that branches
  // on the absent key — runStartupTasks must always proceed to the 36h overdue checks.
  fetchMock
    .mockResolvedValueOnce(makeSettings({ last_lint_at: null, last_backup_at: null }))
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ skipped: false, run_duration_ms: 42 }),
    } as MockResponse)
    .mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as MockResponse)

  await runStartupTasks(baseConfig)

  // Settings fetch + lint POST + export GET = three calls. If a gate were re-added,
  // we'd see exactly one call (settings only).
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

it('skips lint and backup when settings fetch fails', async () => {
  fetchMock.mockRejectedValueOnce(new Error('connection refused'))

  await runStartupTasks(baseConfig)

  expect(fetchMock).toHaveBeenCalledTimes(1)
  const output = stdoutSpy.mock.calls.map(([s]) => String(s)).join('')
  expect(output).toBe('')
})

// ── overdue logic (via observable effects) ────────────────────────────────────

it('skips lint when last_lint_at is within 36 hours', async () => {
  const recentLint = new Date(Date.now() - 1000).toISOString() // 1 second ago
  fetchMock.mockResolvedValueOnce(makeSettings({ last_lint_at: recentLint }))

  await runStartupTasks(baseConfig)

  // Only settings fetch fired — no lint call
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('runs lint when last_lint_at is null (never run)', async () => {
  fetchMock
    .mockResolvedValueOnce(makeSettings({ last_lint_at: null }))
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ skipped: false, run_duration_ms: 42 }),
    } as MockResponse)

  await runStartupTasks(baseConfig)

  expect(fetchMock).toHaveBeenCalledTimes(2)
  const output = stdoutSpy.mock.calls.map(([s]) => String(s)).join('')
  expect(output).toContain('done (42ms)')
})

it('runs lint when last_lint_at is more than 36 hours ago', async () => {
  const stale = new Date(Date.now() - 37 * 3600 * 1000).toISOString()
  fetchMock
    .mockResolvedValueOnce(makeSettings({ last_lint_at: stale }))
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ skipped: true }),
    } as MockResponse)

  await runStartupTasks(baseConfig)

  expect(fetchMock).toHaveBeenCalledTimes(2)
  const output = stdoutSpy.mock.calls.map(([s]) => String(s)).join('')
  expect(output).toContain('skipped')
})
