/**
 * startup-tasks.ts: what `kompl start` does once the app is healthy.
 *
 * It saves a local backup when the last one is more than 36 hours old. It
 * never runs a wiki health check: those call the LLM, so they run only when
 * the user asks (Settings → Wiki health).
 *
 * os.homedir() points at a temporary folder, so these tests never touch the
 * real ~/.kompl/backups.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
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
const OVERDUE = () => new Date(Date.now() - 37 * 3600 * 1000).toISOString()

let fetchMock: jest.Mock
let stdoutSpy: jest.SpyInstance
let home: string

beforeEach(() => {
  fetchMock = jest.fn()
  global.fetch = fetchMock as unknown as typeof fetch
  stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kompl-startup-'))
  jest.spyOn(os, 'homedir').mockReturnValue(home)
})

afterEach(() => {
  jest.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

const output = () => stdoutSpy.mock.calls.map(([s]) => String(s)).join('')
const calledUrls = () => fetchMock.mock.calls.map(([url]) => String(url))
const backupFile = () => path.join(home, '.kompl', 'backups', 'kompl-backup.kompl.zip')

// ── wiki health checks ───────────────────────────────────────────────────────

it('never runs a wiki health check, even when the last one is long overdue', async () => {
  fetchMock.mockResolvedValueOnce(makeSettings({ last_lint_at: null }))

  await runStartupTasks(baseConfig)

  expect(calledUrls().some((url) => url.includes('/api/wiki/lint-pass'))).toBe(false)
  // Settings only: the backup is recent.
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

// ── backup ───────────────────────────────────────────────────────────────────

it('saves a backup when the last one is more than 36 hours old', async () => {
  const bytes = new TextEncoder().encode('zip-bytes')
  fetchMock
    .mockResolvedValueOnce(makeSettings({ last_backup_at: OVERDUE() }))
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => bytes.buffer } as unknown as MockResponse)

  await runStartupTasks(baseConfig)

  expect(calledUrls()[1]).toContain('/api/export?format=kompl')
  expect(fs.readFileSync(backupFile(), 'utf-8')).toBe('zip-bytes')
  expect(output()).toContain('saved')
})

it('skips the backup when the last one is within 36 hours', async () => {
  fetchMock.mockResolvedValueOnce(makeSettings({ last_backup_at: new Date(Date.now() - 1000).toISOString() }))

  await runStartupTasks(baseConfig)

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fs.existsSync(backupFile())).toBe(false)
})

it('reports a failed export without claiming success or writing a file', async () => {
  fetchMock
    .mockResolvedValueOnce(makeSettings({ last_backup_at: null }))
    .mockResolvedValueOnce({ ok: false, status: 500 } as MockResponse)

  await runStartupTasks(baseConfig)

  expect(output()).toContain('export failed (500)')
  expect(output()).not.toContain('saved')
  expect(fs.existsSync(backupFile())).toBe(false)
})

// ── no-gate regression ───────────────────────────────────────────────────────

it('runs the backup even when the settings response has no deployment_mode key (regression: do not re-introduce the gate)', async () => {
  // The deployment_mode toggle was removed in 2026-05-06 (chore/strip-deployment-mode).
  // This test guards against accidentally re-adding an early-return gate that branches
  // on the absent key — runStartupTasks must always proceed to the 36h overdue check.
  fetchMock
    .mockResolvedValueOnce(makeSettings({ last_backup_at: null }))
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as MockResponse)

  await runStartupTasks(baseConfig)

  // Settings fetch + export GET = two calls. If a gate were re-added, we'd see one.
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('does nothing when the settings fetch fails', async () => {
  fetchMock.mockRejectedValueOnce(new Error('connection refused'))

  await runStartupTasks(baseConfig)

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(output()).toBe('')
})
