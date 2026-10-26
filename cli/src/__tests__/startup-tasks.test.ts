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
  const bytes = new TextEncoder().encode('PK\x03\x04zip-bytes')
  fetchMock
    .mockResolvedValueOnce(makeSettings({ last_backup_at: OVERDUE() }))
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => bytes.buffer } as unknown as MockResponse)

  await runStartupTasks(baseConfig)

  expect(calledUrls()[1]).toContain('/api/export?format=kompl')
  expect(fs.readFileSync(backupFile(), 'utf-8')).toBe('PK\x03\x04zip-bytes')
  expect(output()).toContain('saved')
  expect(fs.readdirSync(path.dirname(backupFile()))).toEqual(['kompl-backup.kompl.zip'])
})

/** A good backup from an earlier start. */
function seedBackup(): void {
  fs.mkdirSync(path.dirname(backupFile()), { recursive: true })
  fs.writeFileSync(backupFile(), 'PK\x03\x04the good one')
}

it('keeps the last backup when the download is empty or not a zip', async () => {
  seedBackup()
  fetchMock
    .mockResolvedValueOnce(makeSettings({ last_backup_at: OVERDUE() }))
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as MockResponse)

  await runStartupTasks(baseConfig)

  expect(fs.readFileSync(backupFile(), 'utf-8')).toBe('PK\x03\x04the good one')
  expect(output()).not.toContain('saved')
  expect(output()).toContain('the last backup was kept')
})

it('keeps the last backup when writing the new one fails halfway', async () => {
  seedBackup()
  const realWrite = fs.writeFileSync
  // The disk fills after a few bytes of the new backup.
  jest.spyOn(fs, 'writeFileSync').mockImplementation((file, data) => {
    realWrite(file, (data as Buffer).subarray(0, 5))
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
  })
  fetchMock
    .mockResolvedValueOnce(makeSettings({ last_backup_at: OVERDUE() }))
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new TextEncoder().encode('PK\x03\x04a newer backup').buffer } as unknown as MockResponse)

  await runStartupTasks(baseConfig)

  expect(fs.readFileSync(backupFile(), 'utf-8')).toBe('PK\x03\x04the good one')
  expect(fs.readdirSync(path.dirname(backupFile()))).toEqual(['kompl-backup.kompl.zip'])
  expect(output()).toContain('the last backup was kept')
})

it('gives the export minutes, not two, since a backup carries the whole wiki', async () => {
  const timeout = jest.spyOn(AbortSignal, 'timeout')
  fetchMock
    .mockResolvedValueOnce(makeSettings({ last_backup_at: OVERDUE() }))
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new TextEncoder().encode('PK\x03\x04zip').buffer } as unknown as MockResponse)

  await runStartupTasks(baseConfig)

  expect(Math.max(...timeout.mock.calls.map(([ms]) => ms))).toBeGreaterThanOrEqual(10 * 60_000)
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
