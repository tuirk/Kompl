import pc from 'picocolors'
import { readConfig } from '../config.js'
import { checkHealth } from '../health.js'

export async function openCommand(): Promise<void> {
  const config = readConfig()
  const url = `http://localhost:${config.port}`

  const health = await checkHealth(config.port)
  if (!health) {
    console.log(pc.yellow(`⚠ Kompl does not appear to be running at ${url}`))
    console.log(pc.dim(`  Run ${pc.bold('kompl start')} first, or open ${url} manually.`))
  }

  // Dynamic import required — open@9 is CJS-compatible but we use dynamic import for safety
  const { default: open } = await import('open')
  try {
    await open(url)
    console.log(pc.green(`✓ Opened ${url}`))
  } catch {
    // xdg-open fails on headless Linux servers (no DISPLAY) — just print the URL
    console.log(pc.green(`✓ ${url}`))
  }
}
