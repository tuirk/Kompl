import { stopCommand } from './stop.js'
import { startCommand } from './start.js'

export async function restartCommand(): Promise<void> {
  await stopCommand()
  await startCommand()
}
