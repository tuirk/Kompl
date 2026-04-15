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
  deployment_mode: 'personal-device' | 'always-on'
  last_lint_at: string | null
  last_backup_at: string | null
}

/**
 * Runs after `kompl start` health check succeeds — personal-device mode only.
 * Fires lint and local backup if either hasn't run in the last 36 hours.
 * Non-blocking: called fire-and-forget from start.ts.
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

  // DB value takes precedence over config.json; fall back to config.json default.
  const mode = settings.deployment_mode ?? config.deploymentMode ?? 'personal-device'
  if (mode !== 'personal-device') return

  // ── Lint ──────────────────────────────────────────────────────────────────
  if (isOverdue(settings.last_lint_at)) {
    process.stdout.write(pc.dim('  Scheduled lint      ') + pc.yellow('●') + pc.dim(' running...'))
    try {
      const r = await fetch(`http://localhost:${config.port}/api/wiki/lint-pass`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(120_000),
      })
      if (!r.ok) {
        process.stdout.write('\r' + pc.dim('  Scheduled lint      ') + pc.red(`● failed (${r.status})\n`))
      } else {
        const result = await r.json() as { skipped?: boolean; run_duration_ms?: number }
        if (result.skipped) {
          process.stdout.write('\r' + pc.dim('  Scheduled lint      ') + pc.dim('● skipped (lint disabled)\n'))
        } else {
          process.stdout.write('\r' + pc.dim('  Scheduled lint      ') + pc.green('●') + pc.dim(` done (${result.run_duration_ms}ms)\n`))
        }
      }
    } catch {
      process.stdout.write('\r' + pc.dim('  Scheduled lint      ') + pc.yellow('● timed out — will retry next start\n'))
    }
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
