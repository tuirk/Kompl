import pc from 'picocolors'
import { readConfig } from '../config.js'
import { down } from '../compose.js'

export async function stopCommand(): Promise<void> {
  const config = readConfig()

  console.log(pc.dim('Stopping Kompl stack...'))
  try {
    await down(config.projectDir)
    console.log(pc.green('✓ Kompl stopped.'))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(pc.red(`✗ Failed to stop: ${msg}`))
    process.exit(1)
  }
}
