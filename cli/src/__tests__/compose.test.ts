/**
 * Tests for compose.ts — dockerRunning
 *
 * Key regression: Fix 3 — dockerRunning must be synchronous (no async/await).
 * A Promise<DockerStatus> return would indicate the fix was reverted.
 */

import { execSync } from 'child_process'
import { dockerRunning } from '../compose'

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execSync: jest.fn(),
  spawn: jest.fn(() => ({
    on: jest.fn(),
  })),
}))

const mockExecSync = execSync as jest.Mock

afterEach(() => jest.resetAllMocks())

// ── regression: Fix 3 ────────────────────────────────────────────────────────

it('dockerRunning returns DockerStatus directly, not a Promise (regression Fix 3)', () => {
  mockExecSync.mockReturnValue(Buffer.from(''))
  const result = dockerRunning()
  // If dockerRunning were still async, result would be a Promise, not a plain object
  expect(result).not.toBeInstanceOf(Promise)
  expect(typeof result).toBe('object')
  expect(result).toHaveProperty('ok')
})

// ── status detection ──────────────────────────────────────────────────────────

it('returns ok:true when docker info succeeds', () => {
  mockExecSync.mockReturnValue(Buffer.from('Server: Docker Engine'))
  expect(dockerRunning()).toEqual({ ok: true })
})

it('returns permission-denied when stderr contains "permission denied"', () => {
  const err = Object.assign(new Error('Command failed'), {
    stderr: Buffer.from('Got permission denied while trying to connect to the Docker daemon socket'),
  })
  mockExecSync.mockImplementation(() => { throw err })
  expect(dockerRunning()).toEqual({ ok: false, reason: 'permission-denied' })
})

it('returns not-running when docker info fails without permission error', () => {
  const err = Object.assign(new Error('Command failed'), {
    stderr: Buffer.from('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'),
  })
  mockExecSync.mockImplementation(() => { throw err })
  expect(dockerRunning()).toEqual({ ok: false, reason: 'not-running' })
})

it('returns not-running when error has no stderr property', () => {
  mockExecSync.mockImplementation(() => { throw new Error('unexpected error') })
  expect(dockerRunning()).toEqual({ ok: false, reason: 'not-running' })
})
