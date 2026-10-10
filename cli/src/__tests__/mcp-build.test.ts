/**
 * Tests for mcp-build.ts — rebuilding mcp-server/ during setup, update and start
 */

import path from 'path'
import { buildMcpServer, mcpServerIsStale } from '../mcp-build'

const mockExecSync = jest.fn()
const mockExistsSync = jest.fn()
const mockStatSync = jest.fn()
const mockReaddirSync = jest.fn()

jest.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}))
jest.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
}))

const MCP_DIR = path.join('/tmp/kompl', 'mcp-server')
const INSTALLED = path.join('node_modules', '.package-lock.json')

/** Fake mcp-server/ tree: relative path → mtimeMs. Paths not listed don't exist. */
function fakeTree(files: Record<string, number>, srcEntries: string[] = []) {
  const tree = new Map(Object.entries(files).map(([rel, mtime]) => [path.join(MCP_DIR, rel), mtime]))
  mockExistsSync.mockImplementation((p: string) => tree.has(p) || p === path.join(MCP_DIR, 'src'))
  mockStatSync.mockImplementation((p: string) => {
    if (!tree.has(p)) throw new Error(`ENOENT: ${p}`)
    return { mtimeMs: tree.get(p) }
  })
  mockReaddirSync.mockReturnValue(srcEntries)
}

function commands(): string[] {
  return mockExecSync.mock.calls.map((c) => {
    expect((c[1] as { cwd: string }).cwd).toBe(MCP_DIR)
    return c[0] as string
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockExecSync.mockImplementation(() => undefined)
})

describe('buildMcpServer', () => {
  it('installs from the lockfile, then builds, when packages are missing', () => {
    fakeTree({ 'package.json': 1, 'package-lock.json': 1 })
    expect(buildMcpServer('/tmp/kompl')).toBe(true)
    expect(commands()).toEqual(['npm ci --no-audit --no-fund', 'npm run build'])
  })

  it('only builds when installed packages match the lockfile', () => {
    fakeTree({ 'package.json': 1, 'package-lock.json': 1, [INSTALLED]: 2 })
    expect(buildMcpServer('/tmp/kompl')).toBe(true)
    expect(commands()).toEqual(['npm run build'])
  })

  it('reinstalls when the lockfile changed after the last install', () => {
    fakeTree({ 'package.json': 1, 'package-lock.json': 3, [INSTALLED]: 2 })
    buildMcpServer('/tmp/kompl')
    expect(commands()).toEqual(['npm ci --no-audit --no-fund', 'npm run build'])
  })

  it('returns false instead of throwing when a step fails', () => {
    fakeTree({ 'package.json': 1, 'package-lock.json': 1 })
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('network down')
    })
    expect(buildMcpServer('/tmp/kompl')).toBe(false)
    expect(mockExecSync).toHaveBeenCalledTimes(1)
  })

  it('skips checkouts without an mcp-server package', () => {
    fakeTree({})
    expect(buildMcpServer('/tmp/kompl')).toBe(false)
    expect(mockExecSync).not.toHaveBeenCalled()
  })
})

describe('mcpServerIsStale', () => {
  const FRESH = { 'package.json': 1, 'index.ts': 1, 'package-lock.json': 1, [INSTALLED]: 2, 'dist/index.js': 5 }

  it('is stale when the server was never built', () => {
    fakeTree({ 'package.json': 1, 'index.ts': 1, [INSTALLED]: 2 })
    expect(mcpServerIsStale('/tmp/kompl')).toBe(true)
  })

  it('is fresh when the build is newer than every source file', () => {
    fakeTree({ ...FRESH, 'src/server.ts': 2 }, ['server.ts'])
    expect(mcpServerIsStale('/tmp/kompl')).toBe(false)
  })

  it('is stale when a pulled source file is newer than the build', () => {
    const nested = path.join('tools', 'read-page.ts')
    fakeTree({ ...FRESH, [path.join('src', nested)]: 9 }, [nested])
    expect(mcpServerIsStale('/tmp/kompl')).toBe(true)
  })

  it('is stale when the lockfile changed after the build', () => {
    fakeTree({ ...FRESH, 'package-lock.json': 9 })
    expect(mcpServerIsStale('/tmp/kompl')).toBe(true)
  })

  it('is stale when an interrupted install emptied node_modules', () => {
    const { [INSTALLED]: _gone, ...rest } = FRESH
    fakeTree(rest)
    expect(mcpServerIsStale('/tmp/kompl')).toBe(true)
  })

  it('never asks for a build without an mcp-server package', () => {
    fakeTree({})
    expect(mcpServerIsStale('/tmp/kompl')).toBe(false)
  })

  it('treats a file-system error as "leave it" instead of throwing', () => {
    fakeTree(FRESH)
    mockStatSync.mockImplementation(() => {
      throw new Error('EPERM')
    })
    expect(mcpServerIsStale('/tmp/kompl')).toBe(false)
  })
})
