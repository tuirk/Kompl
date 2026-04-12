#!/usr/bin/env node
/**
 * Kompl one-command setup
 * Usage: node setup.js
 *
 * Does everything:
 *   1. Checks Docker Desktop is running
 *   2. Creates .env from .env.example (if not already present)
 *   3. Prompts for Gemini + Firecrawl API keys and writes them to .env
 *   4. Installs and globally links the kompl CLI (npm link)
 *   5. Writes ~/.kompl/config.json so `kompl` commands work immediately
 *   6. Runs `docker compose up --build -d` to start the full stack
 *
 * Requires: Docker Desktop running, Node >= 18
 */

'use strict'

const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')

const ROOT = __dirname
const green  = (s) => `\x1b[32m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const bold   = (s) => `\x1b[1m${s}\x1b[0m`
const dim    = (s) => `\x1b[2m${s}\x1b[0m`

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve))
}

function run(cmd, cwd = ROOT) {
  execSync(cmd, { cwd, stdio: 'inherit', shell: true })
}

async function main() {
  console.log(bold('\n  Kompl — setup\n'))

  // ── 1. Check Docker ────────────────────────────────────────────────────────
  process.stdout.write('  Checking Docker... ')
  try {
    execSync('docker info', { stdio: 'ignore' })
    console.log(green('running'))
  } catch {
    console.log('')
    console.error('  Error: Docker Desktop is not running.')
    console.error('  Start Docker Desktop and run this script again.\n')
    process.exit(1)
  }

  // ── 2. Create .env ─────────────────────────────────────────────────────────
  const envSrc  = path.join(ROOT, '.env.example')
  const envDest = path.join(ROOT, '.env')
  if (!fs.existsSync(envDest)) {
    fs.copyFileSync(envSrc, envDest)
    console.log('  Created .env from .env.example')
  } else {
    console.log('  .env already exists — keeping it')
  }

  // ── 3. Prompt for API keys ─────────────────────────────────────────────────
  let env = fs.readFileSync(envDest, 'utf8')

  const alreadyHasGemini     = /^GEMINI_API_KEY=.+$/m.test(env)
  const alreadyHasFirecrawl  = /^FIRECRAWL_API_KEY=.+$/m.test(env)

  if (alreadyHasGemini && alreadyHasFirecrawl) {
    console.log('  API keys already set in .env — skipping prompts')
  } else {
    console.log('\n  You need two API keys (both have free tiers):')
    console.log(dim('    Gemini:    https://aistudio.google.com/apikey   (1500 req/day free)'))
    console.log(dim('    Firecrawl: https://firecrawl.dev                (500 scrapes/month free)\n'))

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

    if (!alreadyHasGemini) {
      const key = (await ask(rl, '  Gemini API key: ')).trim()
      if (!key) { console.error('  Error: Gemini API key is required.'); rl.close(); process.exit(1) }
      env = env.replace(/^GEMINI_API_KEY=.*$/m, `GEMINI_API_KEY=${key}`)
    }

    if (!alreadyHasFirecrawl) {
      const key = (await ask(rl, '  Firecrawl API key: ')).trim()
      if (!key) { console.error('  Error: Firecrawl API key is required.'); rl.close(); process.exit(1) }
      env = env.replace(/^FIRECRAWL_API_KEY=.*$/m, `FIRECRAWL_API_KEY=${key}`)
    }

    rl.close()
    fs.writeFileSync(envDest, env, 'utf8')
    console.log(green('\n  API keys saved to .env'))
  }

  // ── 4. Install + link CLI ──────────────────────────────────────────────────
  console.log('\n  Installing kompl CLI...')
  const cliDir = path.join(ROOT, 'cli')
  run('npm install', cliDir)
  run('npm link', cliDir)
  console.log(green('  kompl CLI installed'))

  // ── 5. Write ~/.kompl/config.json ──────────────────────────────────────────
  const configDir  = path.join(os.homedir(), '.kompl')
  const configFile = path.join(configDir, 'config.json')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(configFile, JSON.stringify({ projectDir: ROOT, port: 3000 }, null, 2), 'utf8')
  console.log('  CLI configured → ' + dim(configFile))

  // ── 6. Start stack ─────────────────────────────────────────────────────────
  console.log('\n  Starting Kompl stack...')
  console.log(dim('  (First run builds Docker images and downloads the Ollama model — ~5–10 min)'))
  console.log(dim('  Subsequent starts take ~15 seconds.\n'))
  run('docker compose up --build -d')

  console.log(bold(green('\n  Kompl is starting!')))
  console.log('\n  Check when it\'s ready:    ' + bold('kompl status'))
  console.log('  Open in browser:           ' + bold('kompl open'))
  console.log('  Stream logs:               ' + bold('kompl logs'))
  console.log('  Stop:                      ' + bold('kompl stop') + '\n')
  console.log(dim('  App will be available at http://localhost:3000\n'))
}

main().catch(err => {
  console.error('\n  Setup failed:', err.message)
  process.exit(1)
})
