import { execSync, spawn } from 'child_process'
import path from 'path'

// docker-compose npm package — Node.js wrapper for docker compose v2
import * as compose from 'docker-compose'

export function composeOpts(projectDir: string): compose.IDockerComposeOptions {
  return { cwd: projectDir, log: false }
}

export type DockerStatus =
  | { ok: true }
  | { ok: false; reason: 'not-running' | 'permission-denied' | 'unknown' }

export function dockerRunning(): DockerStatus {
  try {
    execSync('docker info', { stdio: 'pipe' })
    return { ok: true }
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ''
    if (stderr.includes('permission denied')) {
      return { ok: false, reason: 'permission-denied' }
    }
    return { ok: false, reason: 'not-running' }
  }
}

export async function upAll(projectDir: string): Promise<void> {
  await compose.upAll({ ...composeOpts(projectDir), commandOptions: ['-d'] })
}

export async function down(projectDir: string): Promise<void> {
  await compose.down(composeOpts(projectDir))
}

export async function pull(projectDir: string): Promise<void> {
  await compose.pullAll(composeOpts(projectDir))
}

// Streams logs live — must be killed by the caller (Ctrl+C)
export function streamLogs(projectDir: string, service?: string): void {
  const composeFile = path.join(projectDir, 'docker-compose.yml')

  // Detect v2 plugin (`docker compose`) vs v1 standalone (`docker-compose`)
  let command: string
  let args: string[]
  try {
    execSync('docker compose version', { stdio: 'ignore' })
    command = 'docker'
    args = ['compose', '-f', composeFile, 'logs', '--follow', ...(service ? [service] : [])]
  } catch {
    command = 'docker-compose'
    args = ['-f', composeFile, 'logs', '--follow', ...(service ? [service] : [])]
  }

  const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  child.on('error', (err) => {
    console.error('Failed to stream logs:', err.message)
    process.exit(1)
  })
  // Propagate Ctrl+C cleanly
  process.on('SIGINT', () => child.kill('SIGINT'))
}

export function psServices(projectDir: string): ReturnType<typeof compose.ps> {
  return compose.ps(composeOpts(projectDir))
}
