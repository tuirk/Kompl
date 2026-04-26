import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import pc from 'picocolors'
import { readConfig } from '../config.js'
import { checkHealth } from '../health.js'

interface BackupOptions {
  output?: string
  schedule?: boolean
}

const DEFAULT_BACKUP_DIR = path.join(os.homedir(), '.kompl', 'backups')
const DEFAULT_BACKUP_FILE = path.join(DEFAULT_BACKUP_DIR, 'kompl-backup.kompl.zip')

export async function backupCommand(opts: BackupOptions = {}): Promise<void> {
  const config = readConfig()

  if (opts.schedule) {
    registerScheduledTask()
    return
  }

  const outPath = opts.output ?? DEFAULT_BACKUP_FILE

  const health = await checkHealth(config.port)
  if (!health) {
    console.error(`  ${pc.red('●')} App is not running. Run ${pc.bold('kompl start')} first.`)
    process.exit(1)
  }

  const line = '─'.repeat(44)
  console.log(pc.bold('\nKompl backup'))
  console.log(pc.dim(line))
  console.log(`  Backup       ${pc.yellow('●')} downloading...`)

  let res: Response
  try {
    res = await fetch(`http://localhost:${config.port}/api/export?format=kompl`, {
      signal: AbortSignal.timeout(120_000),
    })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      console.error(`  Backup       ${pc.red('●')} export timed out after 120s — is the app responsive?`)
    } else {
      console.error(`  Backup       ${pc.red('●')} request failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    process.exit(1)
  }

  if (!res.ok) {
    console.error(`  Backup       ${pc.red('●')} export failed (${res.status} ${res.statusText})`)
    process.exit(1)
  }

  const buffer = Buffer.from(await res.arrayBuffer())

  const dir = path.dirname(outPath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(outPath, buffer)

  const sizeKB = (buffer.byteLength / 1024).toFixed(1)
  console.log(`  Backup       ${pc.green('●')} saved → ${outPath}  (${sizeKB} KB)`)
  console.log(pc.dim(line + '\n'))
}

function registerScheduledTask(): void {
  if (process.platform === 'linux' || process.platform === 'darwin') {
    registerLinuxCron()
  } else if (process.platform === 'win32') {
    registerWindowsScheduledTask()
  } else {
    console.error(`  Schedule     ${pc.red('●')} unsupported platform: ${process.platform}`)
    process.exit(1)
  }
}

function registerWindowsScheduledTask(): void {
  const line = '─'.repeat(44)
  console.log(pc.bold('\nKompl backup scheduler'))
  console.log(pc.dim(line))

  const script = [
    `$shim = (Get-Command kompl -ErrorAction Stop).Source`,
    `$trigger  = New-ScheduledTaskTrigger -Weekly -At "11:30" -DaysOfWeek Monday`,
    `$action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c \`"$shim\`" backup"`,
    `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable`,
    `Register-ScheduledTask -TaskName '\\Kompl\\WeeklyBackup' -Trigger $trigger -Action $action -Settings $settings -Force`,
  ].join('\n')

  const tmp = path.join(os.tmpdir(), 'kompl-schedule.ps1')
  fs.writeFileSync(tmp, script, 'utf8')

  // spawnSync populates result.error for spawn failures (e.g. ENOENT) — it does not throw
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp,
  ], { encoding: 'utf8', stdio: 'pipe' })
  try { fs.unlinkSync(tmp) } catch { /* temp cleanup is best-effort */ }

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      console.error(`  Schedule     ${pc.red('●')} powershell.exe not found — cannot register scheduled task`)
    } else {
      console.error(`  Schedule     ${pc.red('●')} failed to launch PowerShell: ${result.error.message}`)
    }
    process.exit(1)
  }

  if (result.status !== 0) {
    const stderr = result.stderr ?? ''
    const lower = stderr.toLowerCase()
    if (lower.includes('elevation') || lower.includes('access is denied') || lower.includes('access denied')) {
      console.error(`  Schedule     ${pc.red('●')} Run ${pc.bold('kompl backup --schedule')} as Administrator to register the scheduled task`)
    } else if (lower.includes('commandnotfoundexception') || lower.includes('is not recognized')) {
      console.error(`  Schedule     ${pc.red('●')} kompl not found in PATH — ensure it is installed globally: ${pc.bold('npm install -g kompl')}`)
    } else {
      console.error(`  Schedule     ${pc.red('●')} registration failed: ${stderr.trim()}`)
    }
    process.exit(1)
  }

  console.log(`  Schedule     ${pc.green('●')} registered — kompl backup will run every Monday at 11:30`)
  console.log(pc.dim(`  Task name    \\Kompl\\WeeklyBackup`))
  console.log(pc.dim(`  Note         runs on next login if laptop was off at scheduled time`))
  console.log(pc.dim(line + '\n'))
}

function registerLinuxCron(): void {
  const line = '─'.repeat(44)
  console.log(pc.bold('\nKompl backup scheduler'))
  console.log(pc.dim(line))

  const CRON_ENTRY = '30 11 * * 1 kompl backup'
  const CRON_MARKER = '# kompl-weekly-backup'
  const FULL_LINE = `${CRON_ENTRY} ${CRON_MARKER}`

  // exit code 1 + empty stdout = "no crontab for this user" — that is NOT an error
  const existing = spawnSync('crontab', ['-l'], { encoding: 'utf8', stdio: 'pipe' })

  if (existing.error) {
    const code = (existing.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      console.error(`  Schedule     ${pc.red('●')} crontab not found — install cron (e.g. apt install cron)`)
    } else {
      console.error(`  Schedule     ${pc.red('●')} failed to read crontab: ${existing.error.message}`)
    }
    process.exit(1)
  }

  const currentCrontab = existing.stdout ?? ''

  // Idempotency — bail if already registered
  if (currentCrontab.includes(CRON_MARKER)) {
    console.log(`  Schedule     ${pc.green('●')} already registered — no changes made`)
    console.log(pc.dim(`  Cron entry   ${CRON_ENTRY}`))
    console.log(pc.dim(line + '\n'))
    return
  }

  // Append without disturbing existing lines
  const separator = (currentCrontab === '' || currentCrontab.endsWith('\n')) ? '' : '\n'
  const newCrontab = currentCrontab + separator + FULL_LINE + '\n'

  const write = spawnSync('crontab', ['-'], { input: newCrontab, encoding: 'utf8', stdio: 'pipe' })

  if (write.error) {
    console.error(`  Schedule     ${pc.red('●')} failed to write crontab: ${write.error.message}`)
    process.exit(1)
  }
  if (write.status !== 0) {
    console.error(`  Schedule     ${pc.red('●')} crontab write failed: ${(write.stderr ?? '').trim()}`)
    process.exit(1)
  }

  console.log(`  Schedule     ${pc.green('●')} registered — kompl backup will run every Monday at 11:30`)
  console.log(pc.dim(`  Cron entry   ${CRON_ENTRY}`))
  console.log(pc.dim(`  Note         cron does not catch up if machine was off at scheduled time`))
  console.log(pc.dim(line + '\n'))
}
