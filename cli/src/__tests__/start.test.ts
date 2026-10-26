/**
 * Tests for start.ts — the MCP server rebuild step of `kompl start`
 */

import { startCommand } from '../commands/start'

const mockDockerRunning = jest.fn()
const mockUpAll = jest.fn()
const mockPollHealth = jest.fn()
const mockRunStartupTasks = jest.fn()
const mockIsStale = jest.fn()
const mockBuild = jest.fn()

jest.mock('../config.js', () => ({
  readConfig: () => ({ projectDir: '/tmp/kompl', port: 3000 }),
}))
jest.mock('../compose.js', () => ({
  dockerRunning: (...args: unknown[]) => mockDockerRunning(...args),
  upAll: (...args: unknown[]) => mockUpAll(...args),
}))
jest.mock('../health.js', () => ({
  pollHealth: (...args: unknown[]) => mockPollHealth(...args),
}))
jest.mock('../startup-tasks.js', () => ({
  runStartupTasks: (...args: unknown[]) => mockRunStartupTasks(...args),
}))
jest.mock('../mcp-build.js', () => ({
  MCP_RETRY_HINT: 'Retry with: cd mcp-server && npm ci && npm run build',
  mcpServerIsStale: (...args: unknown[]) => mockIsStale(...args),
  buildMcpServer: (...args: unknown[]) => mockBuild(...args),
}))

let exitSpy: jest.SpyInstance
let logSpy: jest.SpyInstance

beforeEach(() => {
  jest.clearAllMocks()
  mockDockerRunning.mockReturnValue({ ok: true })
  mockUpAll.mockResolvedValue(undefined)
  mockPollHealth.mockResolvedValue({ status: 'ok', schema_version: 27, page_count: 3 })
  mockRunStartupTasks.mockResolvedValue(undefined)
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code: number) => {
    throw new Error(`process.exit(${code})`)
  }) as never)
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(() => jest.restoreAllMocks())

const printed = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n')

it('leaves a fresh MCP build alone', async () => {
  mockIsStale.mockReturnValue(false)
  await startCommand()
  expect(mockBuild).not.toHaveBeenCalled()
  expect(mockRunStartupTasks).toHaveBeenCalled()
})

it('rebuilds a stale MCP server and asks for an agent restart', async () => {
  mockIsStale.mockReturnValue(true)
  mockBuild.mockReturnValue(true)
  await startCommand()
  expect(mockBuild).toHaveBeenCalledWith('/tmp/kompl')
  expect(printed()).toContain('Restart your AI agent')
  expect(mockRunStartupTasks).toHaveBeenCalled()
})

it('keeps starting when the MCP build fails', async () => {
  mockIsStale.mockReturnValue(true)
  mockBuild.mockReturnValue(false)
  await startCommand()
  expect(exitSpy).not.toHaveBeenCalled()
  expect(printed()).toContain('MCP server build failed')
  expect(printed()).toContain('Retry with')
  expect(mockRunStartupTasks).toHaveBeenCalled()
})
