/**
 * Tests for config.ts — readConfig / writeConfig / configExists
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

jest.mock('fs')

const mockFs = fs as jest.Mocked<typeof fs>
const CONFIG_FILE = path.join(os.homedir(), '.kompl', 'config.json')

afterEach(() => jest.resetAllMocks())

describe('configExists', () => {
  it('returns false when config file is absent', () => {
    mockFs.existsSync.mockReturnValue(false)
    const { configExists } = require('../config')
    expect(configExists()).toBe(false)
  })

  it('returns true when config file exists', () => {
    mockFs.existsSync.mockReturnValue(true)
    const { configExists } = require('../config')
    expect(configExists()).toBe(true)
  })
})

describe('readConfig', () => {
  beforeEach(() => jest.isolateModules(() => {}))

  it('throws when config file is missing', () => {
    jest.isolateModules(() => {
      mockFs.existsSync.mockReturnValue(false)
      const { readConfig } = require('../config')
      expect(() => readConfig()).toThrow('not configured')
    })
  })

  it('returns all fields from config file', () => {
    jest.isolateModules(() => {
      mockFs.existsSync.mockReturnValue(true)
      ;(mockFs.readFileSync as jest.Mock).mockReturnValue(
        JSON.stringify({ projectDir: '/my/dir', port: 4000 })
      )
      const { readConfig } = require('../config')
      const cfg = readConfig()
      expect(cfg.projectDir).toBe('/my/dir')
      expect(cfg.port).toBe(4000)
    })
  })
})

describe('writeConfig', () => {
  it('writes config as JSON to the config file', () => {
    mockFs.mkdirSync.mockImplementation(() => undefined)
    mockFs.writeFileSync.mockImplementation(() => undefined)

    jest.isolateModules(() => {
      const { writeConfig } = require('../config')
      writeConfig({ projectDir: '/x', port: 3000 })
    })

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      CONFIG_FILE,
      expect.stringContaining('"projectDir": "/x"'),
      'utf8'
    )
  })
})
