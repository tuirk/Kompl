import pc from 'picocolors'
import { readConfig } from '../config.js'
import { streamLogs } from '../compose.js'

const VALID_SERVICES = ['app', 'nlp-service', 'n8n']

export function logsCommand(service?: string): void {
  const config = readConfig()

  if (service && !VALID_SERVICES.includes(service)) {
    console.error(pc.red(`✗ Unknown service "${service}". Valid: ${VALID_SERVICES.join(', ')}`))
    process.exit(1)
  }

  console.log(pc.dim(`Streaming logs${service ? ` for ${service}` : ' (all services)'}... Ctrl+C to stop.\n`))
  streamLogs(config.projectDir, service)
}
