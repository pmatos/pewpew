import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
}))

import { readFileSync } from 'fs'
import { getReconnectConfig, getSandboxConfig } from './config'

describe('getReconnectConfig', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fills default tunables when the persisted reconnect object is partial', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ reconnect: { enabled: false } }))
    expect(getReconnectConfig()).toEqual({
      enabled: false,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
    })
  })

  it('returns the full default when no reconnect key is persisted', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ scanDirs: ['~/x'] }))
    expect(getReconnectConfig()).toEqual({
      enabled: true,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
    })
  })
})

describe('getSandboxConfig', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fills default extraWritablePaths when the persisted sandbox object is partial', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ sandbox: { enabled: false } }))
    expect(getSandboxConfig()).toEqual({ enabled: false, extraWritablePaths: [] })
  })

  it('returns the full default when no sandbox key is persisted', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ scanDirs: ['~/x'] }))
    expect(getSandboxConfig()).toEqual({ enabled: true, extraWritablePaths: [] })
  })

  it('preserves a persisted extraWritablePaths list', () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ sandbox: { extraWritablePaths: ['~/scratch', '/tmp/build'] } })
    )
    expect(getSandboxConfig()).toEqual({
      enabled: true,
      extraWritablePaths: ['~/scratch', '/tmp/build'],
    })
  })
})
