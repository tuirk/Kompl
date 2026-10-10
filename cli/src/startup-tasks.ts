import fs from 'fs'
import os from 'os'
import path from 'path'
import pc from 'picocolors'
import type { KomplConfig } from './config.js'

const THRESHOLD_MS = 36 * 60 * 60 * 1000 // 36 hours

function isOverdue(lastAt: string | null): boolean {
  if (!lastAt) return true
  return Date.now() - new Date(lastAt).getTime() > THRESHOLD_MS
}

interface StartupSettings {
  last_backup_at: string | null
}

/**
 * Runs after `kompl start` health check succeeds. Saves a local backup if the
 * last one is more than 36 hours old. Non-blocking: called fire-and-forget
 * from start.ts.
 *
 * Wiki health checks do not run here: they call the LLM, so they run only when
 * the user asks (Settings → Wiki health). The app also ignores requests that
 * don't come from that button, so older CLIs that still call it change nothing.
 */
export async function runStartupTasks(config: KomplConfig): Promise<void> {
  // Fetch current settings from DB — authoritative source of truth once app is up.
  let settings: StartupSettings
  try {
    const res = await fetch(`http://localhost:${config.port}/api/settings`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return
    settings = await res.json() as StartupSettings
  } catch {
    return
  }

  // ── Backup ────────────────────────────────────────────────────────────────
  if (isOverdue(settings.last_backup_at)) {
    process.stdout.write(pc.dim('  Scheduled backup    ') + pc.yellow('●') + pc.dim(' downloading...'))
    try {
      const r = await fetch(`http://localhost:${config.port}/api/export?format=kompl`, {
        signal: AbortSignal.timeout(120_000),
      })
      if (!r.ok) {
        process.stdout.write('\r' + pc.dim('  Scheduled backup    ') + pc.red(`● export failed (${r.status})\n`))
        return
      }
      const buf = Buffer.from(await r.arrayBuffer())
      const dir = path.join(os.homedir(), '.kompl', 'backups')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'kompl-backup.kompl.zip'), buf)
      const sizeKB = (buf.byteLength / 1024).toFixed(1)
      process.stdout.write('\r' + pc.dim('  Scheduled backup    ') + pc.green('●') + pc.dim(` saved (${sizeKB} KB)\n`))
    } catch {
      process.stdout.write('\r' + pc.dim('  Scheduled backup    ') + pc.yellow('● timed out — will retry next start\n'))
    }
  }
}
