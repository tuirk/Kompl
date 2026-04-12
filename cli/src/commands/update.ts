import pc from 'picocolors'
import { readConfig } from '../config.js'
import { pull, upAll } from '../compose.js'
import { pollHealth } from '../health.js'

export async function updateCommand(): Promise<void> {
  const config = readConfig()

  console.log(pc.dim('Pulling latest images...'))
  try {
    await pull(config.projectDir)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(pc.red(`✗ Pull failed: ${msg}`))
    process.exit(1)
  }

  console.log(pc.dim('Restarting stack with new images...'))
  try {
    await upAll(config.projectDir)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(pc.red(`✗ Restart failed: ${msg}`))
    process.exit(1)
  }

  process.stdout.write(pc.dim('Waiting for app to be ready'))
  const timer = setInterval(() => process.stdout.write('.'), 1000)
  const health = await pollHealth(config.port, 60_000)
  clearInterval(timer)
  process.stdout.write('\n')

  if (!health) {
    console.log(pc.yellow('⚠ Update applied but health check timed out.'))
    console.log(pc.dim(`  Run ${pc.bold('kompl logs')} to investigate.`))
    process.exit(1)
  }

  console.log(pc.green(`✓ Kompl updated and running at ${pc.bold(`http://localhost:${config.port}`)}`))
}
