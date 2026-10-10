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
const mockBuildMcpServer = jest.fn()
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
jest.mock('../mcp-build.js', () => ({
  buildMcpServer: (...args: unknown[]) => mockBuildMcpServer(...args),
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
  mockBuildMcpServer.mockReturnValue(true)
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

it('happy path: git pull, relink CLI, build MCP server, pull images, rebuild, health poll', async () => {
  await runUpdate()

  expect(mockAssertGitRepo).toHaveBeenCalledWith('/tmp/kompl')
  expect(mockPullFfOnly).toHaveBeenCalledWith('/tmp/kompl')
  expect(mockRelinkCli).toHaveBeenCalledWith('/tmp/kompl')
  expect(mockBuildMcpServer).toHaveBeenCalledWith('/tmp/kompl')
  expect(mockRelinkCli.mock.invocationCallOrder[0]).toBeLessThan(
    mockBuildMcpServer.mock.invocationCallOrder[0],
  )
  expect(mockBuildMcpServer.mock.invocationCallOrder[0]).toBeLessThan(
    mockPull.mock.invocationCallOrder[0],
  )
  expect(mockPull).toHaveBeenCalledWith('/tmp/kompl')
  expect(mockUpAllBuild).toHaveBeenCalledWith('/tmp/kompl')
  expect(mockPollHealth).toHaveBeenCalledWith(3000, 60_000)
  expect(exitSpy).not.toHaveBeenCalled()
  const printed = (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n')
  expect(printed).toContain('Restart your AI agent')
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

it('keeps updating when the MCP server build fails, with a retry hint', async () => {
  mockBuildMcpServer.mockReturnValue(false)
  const log = jest.spyOn(console, 'log').mockImplementation(() => {})
  await runUpdate()

  expect(mockUpAllBuild).toHaveBeenCalledWith('/tmp/kompl')
  expect(exitSpy).not.toHaveBeenCalled()
  const printed = log.mock.calls.map((c) => String(c[0])).join('\n')
  expect(printed).toContain('MCP server build failed')
  expect(printed).not.toContain('Restart your AI agent')
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
