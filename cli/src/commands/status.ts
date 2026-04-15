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
      running: health?.status === 'ok' || health?.status === 'degraded',
      status: health?.status ?? 'stopped',
      app: { status: health ? 'running' : 'stopped', port: config.port },
      db: health ? {
        writable: health.db_writable,
        schema_version: health.schema_version,
        page_count: health.page_count,
      } : null,
      nlp_ok: health?.nlp_ok ?? null,
      vector_backlog: health?.vector_backlog ?? null,
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

  if (health.nlp_ok !== undefined) {
    const nlpDot = health.nlp_ok ? pc.green('●') : pc.yellow('●')
    console.log(`  NLP service  ${nlpDot} ${health.nlp_ok ? 'reachable' : 'unreachable'}`)
  }

  if (health.vector_backlog !== undefined && health.vector_backlog > 0) {
    console.log(`  Vectors      ${pc.yellow('●')} ${health.vector_backlog} pages pending re-index  (run backfill-vectors to fix)`)
  } else if (health.vector_backlog !== undefined) {
    console.log(`  Vectors      ${pc.green('●')} fully indexed`)
  }

  console.log(pc.dim(line + '\n'))
}
