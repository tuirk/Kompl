import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { assertGitRepo, NotGitRepoError, pullFfOnly } from '../git'

jest.mock('fs')
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execSync: jest.fn(),
}))

const mockFs = fs as jest.Mocked<typeof fs>
const mockExecSync = execSync as jest.Mock

afterEach(() => jest.resetAllMocks())

describe('assertGitRepo', () => {
  it('passes when .git exists', () => {
    mockFs.existsSync.mockReturnValue(true)
    expect(() => assertGitRepo('/tmp/kompl')).not.toThrow()
    expect(mockFs.existsSync).toHaveBeenCalledWith(path.join('/tmp/kompl', '.git'))
  })

  it('throws NotGitRepoError when .git is missing', () => {
    mockFs.existsSync.mockReturnValue(false)
    expect(() => assertGitRepo('/tmp/kompl')).toThrow(NotGitRepoError)
  })
})

describe('pullFfOnly', () => {
  it('runs git pull --ff-only in projectDir', () => {
    mockExecSync.mockReturnValue(Buffer.from(''))
    pullFfOnly('/tmp/kompl')
    expect(mockExecSync).toHaveBeenCalledWith('git pull --ff-only', {
      cwd: '/tmp/kompl',
      stdio: 'inherit',
    })
  })
})
