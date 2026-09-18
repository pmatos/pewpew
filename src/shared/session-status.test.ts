import { describe, it, expect } from 'vitest'
import { isRestartable, isRestartableFinished, isTerminalStatus } from './session-status'
import type { SessionStatus } from './types'

const local = (status: SessionStatus) => ({ status, hostId: null })
const remote = (status: SessionStatus) => ({ status, hostId: 'h1' })

describe('isTerminalStatus', () => {
  it('is true only for completed and error', () => {
    expect(isTerminalStatus('completed')).toBe(true)
    expect(isTerminalStatus('error')).toBe(true)
    for (const status of ['running', 'idle', 'needs_input', 'dead'] as const) {
      expect(isTerminalStatus(status)).toBe(false)
    }
  })
})

describe('isRestartableFinished', () => {
  it('covers local completed/error only', () => {
    expect(isRestartableFinished(local('completed'))).toBe(true)
    expect(isRestartableFinished(local('error'))).toBe(true)
    expect(isRestartableFinished(remote('completed'))).toBe(false)
    expect(isRestartableFinished(local('dead'))).toBe(false)
  })
})

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
