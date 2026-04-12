import pc from 'picocolors'
import { readConfig } from '../config.js'
import { checkHealth } from '../health.js'

interface StatusOptions {
  json?: boolean
}

export async function statusCommand(opts: StatusOptions = {}): Promise<void> {
  const config = readConfig()
  const health = await checkHealth(config.port)

  if (opts.json) {
    console.log(JSON.stringify({
      running: health?.status === 'ok',
      app: { status: health ? 'running' : 'stopped', port: config.port },
      db: health ? {
        writable: health.db_writable,
        schema_version: health.schema_version,
        page_count: health.page_count,
      } : null,
    }))
    return
  }

  const line = '─'.repeat(44)
  console.log(pc.bold('\nKompl status'))
  console.log(pc.dim(line))

  if (!health) {
    console.log(`  App          ${pc.red('● stopped')}`)
    console.log(pc.dim(line))
    console.log(pc.dim(`  Run ${pc.bold('kompl start')} to launch.\n`))
    return
  }

  const dot = health.status === 'ok' ? pc.green('●') : pc.yellow('●')
  console.log(`  App          ${dot} running   localhost:${config.port}`)
  console.log(`  DB           ${health.db_writable ? pc.green('●') : pc.red('●')} ${health.db_writable ? 'writable' : 'read-only'}  schema v${health.schema_version}, ${health.page_count} pages`)
  console.log(pc.dim(line + '\n'))
}
