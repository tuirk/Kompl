/**
 * Tests for update.ts — kompl update orchestration
 */

import { updateCommand } from '../commands/update'
import { NotGitRepoError } from '../git'

const mockReadConfig = jest.fn(() => ({ projectDir: '/tmp/kompl', port: 3000 }))
const mockDockerRunning = jest.fn()
const mockPull = jest.fn()
const mockUpAllBuild = jest.fn()
const mockAssertGitRepo = jest.fn()
const mockPullFfOnly = jest.fn()
const mockRelinkCli = jest.fn()
const mockPollHealth = jest.fn()

jest.mock('../config.js', () => ({
  readConfig: () => mockReadConfig(),
}))
jest.mock('../compose.js', () => ({
  dockerRunning: (...args: unknown[]) => mockDockerRunning(...args),
  pull: (...args: unknown[]) => mockPull(...args),
  upAllBuild: (...args: unknown[]) => mockUpAllBuild(...args),
}))
jest.mock('../git.js', () => {
  const actual = jest.requireActual('../git.js')
  return {
    ...actual,
    assertGitRepo: (...args: unknown[]) => mockAssertGitRepo(...args),
    pullFfOnly: (...args: unknown[]) => mockPullFfOnly(...args),
  }
})
jest.mock('../relink-cli.js', () => ({
  relinkCli: (...args: unknown[]) => mockRelinkCli(...args),
}))
jest.mock('../health.js', () => ({
  pollHealth: (...args: unknown[]) => mockPollHealth(...args),
}))

let exitSpy: jest.SpyInstance

beforeEach(() => {
  jest.clearAllMocks()
  mockReadConfig.mockReturnValue({ projectDir: '/tmp/kompl', port: 3000 })
  mockDockerRunning.mockReturnValue({ ok: true })
  mockPull.mockResolvedValue(undefined)
  mockUpAllBuild.mockResolvedValue(undefined)
  mockPollHealth.mockResolvedValue({ schema_version: 25, page_count: 0 })
  mockAssertGitRepo.mockImplementation(() => undefined)
  mockPullFfOnly.mockImplementation(() => undefined)
  mockRelinkCli.mockImplementation(() => undefined)
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code: number) => {
    throw new Error(`process.exit(${code})`)
  }) as never)
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => jest.restoreAllMocks())

function runUpdate(): Promise<void> {
  return updateCommand()
}

it('happy path: git pull, relink CLI, pull images, rebuild, health poll', async () => {
  await runUpdate()

  expect(mockAssertGitRepo).toHaveBeenCalledWith('/tmp/kompl')
  expect(mockPullFfOnly).toHaveBeenCalledWith('/tmp/kompl')
  expect(mockRelinkCli).toHaveBeenCalledWith('/tmp/kompl')
  expect(mockPull).toHaveBeenCalledWith('/tmp/kompl')
  expect(mockUpAllBuild).toHaveBeenCalledWith('/tmp/kompl')
  expect(mockPollHealth).toHaveBeenCalledWith(3000, 60_000)
  expect(exitSpy).not.toHaveBeenCalled()
})

it('exits when Docker is not running', async () => {
  mockDockerRunning.mockReturnValue({ ok: false, reason: 'not-running' })
  await expect(runUpdate()).rejects.toThrow('process.exit(1)')
  expect(mockPullFfOnly).not.toHaveBeenCalled()
})

it('exits when not a git repo', async () => {
  mockAssertGitRepo.mockImplementation(() => {
    throw new NotGitRepoError('/tmp/kompl')
  })
  await expect(runUpdate()).rejects.toThrow('process.exit(1)')
  expect(mockPullFfOnly).not.toHaveBeenCalled()
})

it('exits when git pull fails', async () => {
  mockPullFfOnly.mockImplementation(() => {
    throw new Error('merge conflict')
  })
  await expect(runUpdate()).rejects.toThrow('process.exit(1)')
  expect(mockRelinkCli).not.toHaveBeenCalled()
})

it('exits when docker compose pull fails', async () => {
  mockPull.mockRejectedValue(new Error('registry down'))
  await expect(runUpdate()).rejects.toThrow('process.exit(1)')
  expect(mockUpAllBuild).not.toHaveBeenCalled()
})

it('exits when health check times out', async () => {
  mockPollHealth.mockResolvedValue(null)
  await expect(runUpdate()).rejects.toThrow('process.exit(1)')
})
