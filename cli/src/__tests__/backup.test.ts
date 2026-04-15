/**
 * Tests for backup.ts — backupCommand + schedule registration
 *
 * Key regression: Fix 4 — fs.unlinkSync throwing (Windows AV lock) must not
 * crash the process after a successful PowerShell registration.
 */

import fs from 'fs'
import { spawnSync } from 'child_process'

jest.mock('fs')
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawnSync: jest.fn(),
}))
jest.mock('../health', () => ({
  checkHealth: jest.fn(),
}))
jest.mock('../config', () => ({
  readConfig: jest.fn(() => ({ port: 3000, projectDir: '/tmp/kompl', deploymentMode: 'personal-device' })),
}))

const mockFs = fs as jest.Mocked<typeof fs>
const mockSpawnSync = spawnSync as jest.Mock
const mockCheckHealth = require('../health').checkHealth as jest.Mock

let fetchMock: jest.Mock
let exitSpy: jest.SpyInstance
let consoleSpy: jest.SpyInstance

beforeEach(() => {
  fetchMock = jest.fn()
  global.fetch = fetchMock as unknown as typeof fetch
  // Throw on process.exit so code stops executing — prevents bleeding into subsequent statements
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code: number) => {
    throw new Error(`process.exit(${code})`)
  }) as never)
  consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  mockFs.mkdirSync.mockImplementation(() => undefined)
  mockFs.writeFileSync.mockImplementation(() => undefined)
  mockFs.existsSync.mockReturnValue(true)
})

afterEach(() => jest.restoreAllMocks())

// ── regression: Fix 4 ────────────────────────────────────────────────────────

it('does not throw when fs.unlinkSync throws EPERM after successful PowerShell run (regression Fix 4)', async () => {
  // spawnSync returns success (status 0, no error)
  mockSpawnSync.mockReturnValue({ status: 0, error: null, stderr: '', stdout: '' })
  // unlinkSync throws EPERM (Windows AV lock scenario)
  mockFs.unlinkSync.mockImplementation(() => {
    const err = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    throw err
  })

  jest.isolateModules(() => {
    const { backupCommand } = require('../commands/backup')
    // Should NOT throw — unlinkSync failure is swallowed as best-effort cleanup
    return expect(backupCommand({ schedule: true })).resolves.not.toThrow()
  })
})

it('does not throw when fs.unlinkSync throws EBUSY after successful PowerShell run', async () => {
  mockSpawnSync.mockReturnValue({ status: 0, error: null, stderr: '', stdout: '' })
  mockFs.unlinkSync.mockImplementation(() => {
    const err = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    throw err
  })

  jest.isolateModules(() => {
    const { backupCommand } = require('../commands/backup')
    return expect(backupCommand({ schedule: true })).resolves.not.toThrow()
  })
})

// ── backupCommand error paths ─────────────────────────────────────────────────

it('calls process.exit(1) when app is not running', async () => {
  mockCheckHealth.mockResolvedValue(null)
  const { backupCommand } = require('../commands/backup')
  await expect(backupCommand({})).rejects.toThrow('process.exit(1)')
})

it('calls process.exit(1) when export endpoint returns non-ok', async () => {
  mockCheckHealth.mockResolvedValue({ status: 'ok' })
  fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' })
  const { backupCommand } = require('../commands/backup')
  await expect(backupCommand({})).rejects.toThrow('process.exit(1)')
})

it('writes backup file on success', async () => {
  mockCheckHealth.mockResolvedValue({ status: 'ok' })
  const fakeZip = Buffer.from('PK\x03\x04fake-zip')
  fetchMock.mockResolvedValue({
    ok: true,
    arrayBuffer: async () => fakeZip.buffer,
  })

  const { backupCommand } = require('../commands/backup')
  await backupCommand({ output: '/tmp/test-backup.kompl.zip' })

  expect(mockFs.writeFileSync).toHaveBeenCalledWith(
    '/tmp/test-backup.kompl.zip',
    expect.any(Buffer)
  )
  expect(exitSpy).not.toHaveBeenCalled()
})
