import fs from 'fs'
import os from 'os'
import path from 'path'

export interface KomplConfig {
  projectDir: string
  port: number
  deploymentMode: 'personal-device' | 'always-on'
}

const CONFIG_DIR = path.join(os.homedir(), '.kompl')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

export function configExists(): boolean {
  return fs.existsSync(CONFIG_FILE)
}

export function readConfig(): KomplConfig {
  if (!configExists()) {
    throw new Error(
      'Kompl is not configured. Run `kompl init` first.'
    )
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  return { deploymentMode: 'personal-device', ...raw } as KomplConfig
}

export function writeConfig(config: KomplConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
}
