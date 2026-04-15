import fs from 'fs'
import path from 'path'
import pc from 'picocolors'
import { readConfig } from '../config.js'
import { dockerRunning, upAll } from '../compose.js'
import { pollHealth } from '../health.js'
import type { HealthResponse } from '../health.js'
import { runStartupTasks } from '../startup-tasks.js'

export async function startCommand(): Promise<void> {
  const config = readConfig()

  const envPath = path.join(config.projectDir, '.env')
  const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  if (!envContent.includes('KOMPL_TIMEZONE=')) {
    console.log(pc.yellow(`⚠ KOMPL_TIMEZONE not set — n8n schedules will run in UTC. Run ${pc.bold('kompl init')} to fix.`))
  }

  console.log(pc.dim('Checking Docker...'))
  const docker = dockerRunning()
  if (!docker.ok) {
    if (docker.reason === 'permission-denied') {
      console.error(pc.red('✗ Docker permission denied.'))
      console.error(pc.dim('  Add your user to the docker group and re-login:'))
      console.error(pc.dim('    sudo usermod -aG docker $USER'))
    } else {
      console.error(pc.red('✗ Docker is not running. Start Docker and try again.'))
    }
    process.exit(1)
  }

  console.log(pc.dim('Starting Kompl stack...'))
  try {
    await upAll(config.projectDir)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(pc.red(`✗ Failed to start: ${msg}`))
    process.exit(1)
  }

  process.stdout.write(pc.dim('Waiting for app to be ready'))
  const timer = setInterval(() => process.stdout.write('.'), 1000)
  let health: HealthResponse | null = null
  try {
    health = await pollHealth(config.port, 60_000)
  } finally {
    clearInterval(timer)
    process.stdout.write('\n')
  }

  if (!health) {
    console.log(pc.yellow(`⚠ Stack started but health check timed out.`))
    console.log(pc.dim(`  Run ${pc.bold('kompl logs')} to investigate.`))
    process.exit(1)
  }

  console.log(pc.green(`✓ Kompl is running at ${pc.bold(`http://localhost:${config.port}`)}`))
  console.log(pc.dim(`  DB: schema v${health.schema_version}, ${health.page_count} pages`))

  // Fire-and-forget — does not block the prompt returning.
  runStartupTasks(config).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(pc.dim(`\n  [startup] unexpected error: ${msg}`))
  })
}
