import { Command } from 'commander'
import { initCommand } from './commands/init.js'
import { startCommand } from './commands/start.js'
import { stopCommand } from './commands/stop.js'
import { restartCommand } from './commands/restart.js'
import { statusCommand } from './commands/status.js'
import { openCommand } from './commands/open.js'
import { logsCommand } from './commands/logs.js'
import { updateCommand } from './commands/update.js'
import { backupCommand } from './commands/backup.js'

const program = new Command()

program
  .name('kompl')
  .description('Manage the Kompl knowledge compiler stack')
  .version('1.0.0')

program
  .command('init')
  .description('First-time setup — configure the path to your KomplCore directory')
  .action(() => initCommand().catch(die))

program
  .command('start')
  .description('Start the Kompl stack (docker compose up -d + health check)')
  .action(() => startCommand().catch(die))

program
  .command('stop')
  .description('Stop the Kompl stack (docker compose down)')
  .action(() => stopCommand().catch(die))

program
  .command('restart')
  .description('Restart the Kompl stack')
  .action(() => restartCommand().catch(die))

program
  .command('status')
  .description('Show stack status and DB health')
  .option('--json', 'Output raw JSON (for scripts / tray app)')
  .action((opts) => statusCommand(opts).catch(die))

program
  .command('open')
  .description('Open Kompl in the default browser')
  .action(() => openCommand().catch(die))

program
  .command('logs [service]')
  .description('Stream container logs (app | nlp-service | n8n)')
  .action((service?: string) => { logsCommand(service) })

program
  .command('update')
  .description('Pull latest images and restart the stack')
  .action(() => updateCommand().catch(die))

program
  .command('backup')
  .description('Download a full Kompl export to the host filesystem')
  .option('--output <path>', 'Save path (default: ~/.kompl/backups/kompl-backup.kompl.zip)')
  .option('--schedule', 'Register a weekly backup schedule (Windows: Task Scheduler, requires admin; Linux: crontab entry, Monday 11:30)')
  .action((opts) => backupCommand(opts).catch(die))

program.parse()

function die(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`Error: ${msg}`)
  process.exit(1)
}
