import pc from 'picocolors'
import { readConfig } from '../config.js'
import { dockerRunning, pull, upAllBuild } from '../compose.js'
import { assertGitRepo, NotGitRepoError, pullFfOnly } from '../git.js'
import { pollHealth } from '../health.js'
import type { HealthResponse } from '../health.js'
import { relinkCli } from '../relink-cli.js'

export async function updateCommand(): Promise<void> {
  const config = readConfig()

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

  try {
    assertGitRepo(config.projectDir)
  } catch (err: unknown) {
    if (err instanceof NotGitRepoError) {
      console.error(pc.red(`✗ ${err.message}`))
      process.exit(1)
    }
    throw err
  }

  console.log(pc.dim('Pulling latest source...'))
  try {
    pullFfOnly(config.projectDir)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(pc.red(`✗ git pull failed: ${msg}`))
    process.exit(1)
  }

  console.log(pc.dim('Refreshing kompl CLI...'))
  try {
    relinkCli(config.projectDir)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(pc.red(`✗ CLI refresh failed: ${msg}`))
    process.exit(1)
  }

  console.log(pc.dim('Pulling registry images...'))
  try {
    await pull(config.projectDir)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(pc.red(`✗ Pull failed: ${msg}`))
    process.exit(1)
  }

  console.log(pc.dim('Rebuilding and restarting stack (may take 5–10 min)...'))
  try {
    await upAllBuild(config.projectDir)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(pc.red(`✗ Rebuild failed: ${msg}`))
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
    console.log(pc.yellow('⚠ Update applied but health check timed out.'))
    console.log(pc.dim(`  Run ${pc.bold('kompl logs')} to investigate.`))
    process.exit(1)
  }

  console.log(pc.green(`✓ Kompl updated and running at ${pc.bold(`http://localhost:${config.port}`)}`))
  if (health.status === 'degraded') {
    console.log(pc.yellow('  Note: NLP still warming — compile may retry until models load.'))
  }
}
