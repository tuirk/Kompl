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

  it('defaults deploymentMode to personal-device when absent from JSON', () => {
    jest.isolateModules(() => {
      mockFs.existsSync.mockReturnValue(true)
      ;(mockFs.readFileSync as jest.Mock).mockReturnValue(
        JSON.stringify({ projectDir: '/some/dir', port: 3000 })
      )
      const { readConfig } = require('../config')
      const cfg = readConfig()
      expect(cfg.deploymentMode).toBe('personal-device')
    })
  })

  it('respects explicit deploymentMode from JSON (spread order is correct)', () => {
    jest.isolateModules(() => {
      mockFs.existsSync.mockReturnValue(true)
      ;(mockFs.readFileSync as jest.Mock).mockReturnValue(
        JSON.stringify({ projectDir: '/some/dir', port: 3000, deploymentMode: 'always-on' })
      )
      const { readConfig } = require('../config')
      const cfg = readConfig()
      // If spread order were wrong ({ deploymentMode:'personal-device', ...raw } with default AFTER spread),
      // this would incorrectly return 'personal-device'.
      expect(cfg.deploymentMode).toBe('always-on')
    })
  })

  it('returns all fields from config file', () => {
    jest.isolateModules(() => {
      mockFs.existsSync.mockReturnValue(true)
      ;(mockFs.readFileSync as jest.Mock).mockReturnValue(
        JSON.stringify({ projectDir: '/my/dir', port: 4000, deploymentMode: 'personal-device' })
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
      writeConfig({ projectDir: '/x', port: 3000, deploymentMode: 'personal-device' })
    })

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      CONFIG_FILE,
      expect.stringContaining('"projectDir": "/x"'),
      'utf8'
    )
  })
})
