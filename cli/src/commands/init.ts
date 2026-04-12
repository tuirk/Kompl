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

  writeConfig({ projectDir: path.resolve(projectDir), port: port ?? 3000 })

  console.log(pc.green(`\n✓ Config saved. Run ${pc.bold('kompl start')} to launch Kompl.\n`))
}
