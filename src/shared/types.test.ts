import { describe, it, expect } from 'vitest'
import { isRestartable, type SessionStatus } from './types'

const local = (status: SessionStatus) => ({ status, hostId: null })
const remote = (status: SessionStatus) => ({ status, hostId: 'h1' })

describe('isRestartable', () => {
  it('restarts dead sessions, local or remote', () => {
    expect(isRestartable(local('dead'))).toBe(true)
    expect(isRestartable(remote('dead'))).toBe(true)
  })

  it('restarts local completed/error sessions', () => {
    expect(isRestartable(local('completed'))).toBe(true)
    expect(isRestartable(local('error'))).toBe(true)
  })

  it('leaves remote completed/error terminal and never restarts live sessions', () => {
    expect(isRestartable(remote('completed'))).toBe(false)
    expect(isRestartable(remote('error'))).toBe(false)
    for (const status of ['running', 'idle', 'needs_input'] as const) {
      expect(isRestartable(local(status))).toBe(false)
    }
  })
})
