import fs from 'fs'
import path from 'path'
import pc from 'picocolors'
import prompts from 'prompts'
import { writeConfig } from '../config.js'

export async function initCommand(): Promise<void> {
  console.log(pc.bold('\nKompl — first-time setup\n'))

  const { projectDir } = await prompts({
    type: 'text',
    name: 'projectDir',
    message: 'Path to your KomplCore directory:',
    initial: process.cwd(),
    validate: (v: string) => {
      const composePath = path.join(v, 'docker-compose.yml')
      if (!fs.existsSync(composePath)) {
        return `No docker-compose.yml found at ${v}`
      }
      return true
    },
  })

  if (!projectDir) {
    console.log(pc.yellow('Aborted.'))
    process.exit(0)
  }

  const { port } = await prompts({
    type: 'number',
    name: 'port',
    message: 'App port (default 3000):',
    initial: 3000,
  })

  const { deploymentMode } = await prompts({
    type: 'select',
    name: 'deploymentMode',
    message: 'How is this Kompl instance running?',
    choices: [
      { title: 'Personal device  (laptop/desktop — may be off)', value: 'personal-device' },
      { title: 'Always-on server (VPS, Railway, Raspberry Pi)', value: 'always-on' },
    ],
    initial: 0,
  })

  if (deploymentMode === undefined) {
    console.log(pc.yellow('Aborted.'))
    process.exit(0)
  }

  const resolvedDir = path.resolve(projectDir)
  writeConfig({ projectDir: resolvedDir, port: port ?? 3000, deploymentMode })

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const envPath = path.join(resolvedDir, '.env')
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  if (existing.includes('KOMPL_TIMEZONE=')) {
    fs.writeFileSync(envPath, existing.replace(/^KOMPL_TIMEZONE=.*/m, `KOMPL_TIMEZONE=${timezone}`), 'utf8')
  } else {
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
    fs.appendFileSync(envPath, `${prefix}KOMPL_TIMEZONE=${timezone}\n`, 'utf8')
  }

  const modeLabel = deploymentMode === 'always-on' ? 'Always-on server' : 'Personal device'
  console.log(pc.green(`\n✓ Config saved. Timezone: ${pc.bold(timezone)}. Mode: ${pc.bold(modeLabel)}. Run ${pc.bold('kompl start')} to launch Kompl.\n`))
}
