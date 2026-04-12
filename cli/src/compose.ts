import { execSync, spawn } from 'child_process'
import path from 'path'

// docker-compose npm package — Node.js wrapper for docker compose v2
import * as compose from 'docker-compose'

export function composeOpts(projectDir: string): compose.IDockerComposeOptions {
  return { cwd: projectDir, log: false }
}

export async function dockerRunning(): Promise<boolean> {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch {
    return false
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
  const args = [
    'compose',
    '-f', composeFile,
    'logs', '--follow',
    ...(service ? [service] : []),
  ]
  const child = spawn('docker', args, { stdio: 'inherit', shell: process.platform === 'win32' })
  child.on('error', (err) => {
    console.error('Failed to stream logs:', err.message)
    process.exit(1)
  })
  // Propagate Ctrl+C cleanly
  process.on('SIGINT', () => child.kill('SIGINT'))
}

export async function psServices(projectDir: string): Promise<compose.DockerComposePsResult> {
  return compose.ps(composeOpts(projectDir))
}
