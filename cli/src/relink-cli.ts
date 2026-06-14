import path from 'path'
import { execSync } from 'child_process'

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'inherit', shell: true })
}

/**
 * Rebuild and globally link the kompl CLI after source updates.
 * Mirrors setup.js step 4 (npm install + npm link).
 */
export function relinkCli(projectDir: string): void {
  const cliDir = path.join(projectDir, 'cli')
  run('npm install', cliDir)
  try {
    run('npm run build', cliDir)
    run('npm link', cliDir)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('EACCES') || msg.includes('permission denied')) {
      console.error('\n  Error: npm link failed — permission denied.')
      console.error('  Your npm global prefix requires elevated access. Fix with:')
      console.error('    mkdir -p ~/.npm-global')
      console.error('    npm config set prefix ~/.npm-global')
      console.error('    echo \'export PATH="$HOME/.npm-global/bin:$PATH"\' >> ~/.bashrc  # or ~/.zshrc')
      console.error('    source ~/.bashrc')
      console.error('  Then re-run: kompl update\n')
    }
    throw err
  }
}
