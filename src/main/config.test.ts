import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
}))

import { readFileSync } from 'fs'
import { getReconnectConfig } from './config'

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
