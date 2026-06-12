import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

export class NotGitRepoError extends Error {
  constructor(projectDir: string) {
    super(
      `No git repository at ${projectDir}. kompl update requires a git clone — re-install from README or run docker compose up --build -d manually after updating source.`
    )
    this.name = 'NotGitRepoError'
  }
}

export function assertGitRepo(projectDir: string): void {
  const gitDir = path.join(projectDir, '.git')
  if (!fs.existsSync(gitDir)) {
    throw new NotGitRepoError(projectDir)
  }
}

export function pullFfOnly(projectDir: string): void {
  execSync('git pull --ff-only', { cwd: projectDir, stdio: 'inherit' })
}
