import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

/**
 * Build the MCP server (mcp-server/) so AI agents run the code that matches
 * this checkout. Agents launch mcp-server/dist/index.js directly, and dist/ is
 * not in git, so without this step an update leaves them on whatever was built
 * at install time. Mirrors setup.js step 4b.
 *
 * Packages are (re)installed only when node_modules doesn't match the lockfile.
 * `npm ci` installs exactly what the lockfile says and never rewrites it, so the
 * checkout stays clean for the next `git pull --ff-only`. It empties
 * node_modules first, so a failed run can leave the server unable to start
 * until a retry succeeds — callers say so.
 *
 * Returns false instead of throwing: the MCP server is optional, so a failed
 * build must not stop the update.
 */
export function buildMcpServer(projectDir: string): boolean {
  const dir = path.join(projectDir, 'mcp-server')
  try {
    if (!fs.existsSync(path.join(dir, 'package.json'))) return false
    if (packagesOutdated(dir)) {
      execSync('npm ci --no-audit --no-fund', { cwd: dir, stdio: 'inherit' })
    }
    execSync('npm run build', { cwd: dir, stdio: 'inherit' })
    return true
  } catch {
    return false
  }
}

/** Files whose changes require a rebuild, relative to mcp-server/. */
const SOURCE_FILES = ['index.ts', 'package-lock.json', 'tsconfig.json']

/**
 * True when the MCP server needs building: dist/index.js is missing or older
 * than the server's source (after a `git pull`, or an update run by a CLI from
 * before `kompl update` rebuilt it), or its packages don't match the lockfile
 * (e.g. an interrupted `npm ci`). Never throws: a failed check means "leave it".
 */
export function mcpServerIsStale(projectDir: string): boolean {
  const dir = path.join(projectDir, 'mcp-server')
  try {
    if (!fs.existsSync(path.join(dir, 'package.json'))) return false
    const built = path.join(dir, 'dist', 'index.js')
    if (!fs.existsSync(built) || packagesOutdated(dir)) return true
    const builtAt = fs.statSync(built).mtimeMs

    const srcDir = path.join(dir, 'src')
    const sources = SOURCE_FILES.map((f) => path.join(dir, f))
    if (fs.existsSync(srcDir)) {
      for (const entry of fs.readdirSync(srcDir, { recursive: true })) {
        if (String(entry).endsWith('.ts')) sources.push(path.join(srcDir, String(entry)))
      }
    }
    return sources.some((file) => fs.existsSync(file) && fs.statSync(file).mtimeMs > builtAt)
  } catch {
    return false
  }
}

/**
 * npm records what it installed in node_modules/.package-lock.json. Missing or
 * older than package-lock.json means node_modules doesn't match the lockfile.
 */
function packagesOutdated(dir: string): boolean {
  const installed = path.join(dir, 'node_modules', '.package-lock.json')
  const lock = path.join(dir, 'package-lock.json')
  if (!fs.existsSync(installed)) return true
  return fs.existsSync(lock) && fs.statSync(lock).mtimeMs > fs.statSync(installed).mtimeMs
}

export const MCP_RETRY_HINT = 'Retry with: cd mcp-server && npm ci && npm run build'
