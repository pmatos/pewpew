import { describe, expect, it } from 'vitest'
import type { SessionStatus } from '../shared/types'
import { deriveRestoredState, type RestoreEnv } from './restore-planner'

// Seam under test: the pure `deriveRestoredState` decision function extracted
// from `restoreSessions`. Expected values are the documented behaviour of the
// original inline decision tree (the spec), not a recomputation of the new
// implementation.

const LOCAL = { hostId: null }
const REMOTE = { hostId: 'host-1' }

const env = (over: Partial<RestoreEnv> = {}): RestoreEnv => ({
  hasLiveTmux: false,
  worktreeExists: true,
  tmuxAvailable: true,
  ...over,
})

describe('deriveRestoredState — remote sessions', () => {
  // Remote sessions are restored lazily: they materialize as `pending` (no
  // network I/O) until the user opens the host connection. Environment facts
  // about local tmux/worktree are irrelevant to remote sessions.
  it('maps a persisted running remote session to idle + pending', () => {
    expect(deriveRestoredState({ ...REMOTE, status: 'running' }, env())).toEqual({
      status: 'idle',
      connectionState: 'pending',
      outcome: 'remote-pending',
    })
  })

  it('keeps a non-running, non-dead remote status but marks it pending', () => {
    for (const status of ['idle', 'needs_input', 'completed', 'error'] as SessionStatus[]) {
      expect(deriveRestoredState({ ...REMOTE, status }, env())).toEqual({
        status,
        connectionState: 'pending',
        outcome: 'remote-pending',
      })
    }
  })

  it('leaves a dead remote session dead, preserving its persisted connectionState', () => {
    // A remote session confirmed gone is persisted as dead + 'offline'
    // (session-manager reconnect probe). Restore must not wipe that to
    // undefined — there is nothing to reconnect to, so it stays as persisted.
    const result = deriveRestoredState(
      { ...REMOTE, status: 'dead', connectionState: 'offline' },
      env()
    )
    expect(result).toEqual({
      status: 'dead',
      connectionState: 'offline',
      outcome: 'remote-dead',
    })
  })

  it('leaves a dead remote session with no persisted connectionState undefined', () => {
    const result = deriveRestoredState({ ...REMOTE, status: 'dead' }, env())
    expect(result.status).toBe('dead')
    expect(result.connectionState).toBeUndefined()
    expect(result.outcome).toBe('remote-dead')
  })

  it('ignores local environment facts for remote sessions', () => {
    const allFalse = env({ hasLiveTmux: false, worktreeExists: false, tmuxAvailable: false })
    const allTrue = env({ hasLiveTmux: true, worktreeExists: true, tmuxAvailable: true })
    expect(deriveRestoredState({ ...REMOTE, status: 'running' }, allFalse)).toEqual(
      deriveRestoredState({ ...REMOTE, status: 'running' }, allTrue)
    )
  })
})

describe('deriveRestoredState — local active sessions (running/idle/needs_input)', () => {
  it('reattaches when a live tmux session exists, normalizing running to idle', () => {
    expect(
      deriveRestoredState({ ...LOCAL, status: 'running' }, env({ hasLiveTmux: true }))
    ).toEqual({ status: 'idle', connectionState: undefined, outcome: 'reattach' })
  })

  it('preserves needs_input across a reattach so attention signals survive restart', () => {
    expect(
      deriveRestoredState({ ...LOCAL, status: 'needs_input' }, env({ hasLiveTmux: true }))
    ).toEqual({ status: 'needs_input', connectionState: undefined, outcome: 'reattach' })
  })

  it('reattaches an idle session with live tmux', () => {
    expect(deriveRestoredState({ ...LOCAL, status: 'idle' }, env({ hasLiveTmux: true }))).toEqual({
      status: 'idle',
      connectionState: undefined,
      outcome: 'reattach',
    })
  })

  it('marks the session dead when the worktree is gone', () => {
    const result = deriveRestoredState(
      { ...LOCAL, status: 'running' },
      env({ hasLiveTmux: false, worktreeExists: false })
    )
    expect(result).toEqual({
      status: 'dead',
      connectionState: undefined,
      outcome: 'dead-no-worktree',
    })
  })

  it('prefers dead-no-worktree over dead-no-tmux when both apply', () => {
    const result = deriveRestoredState(
      { ...LOCAL, status: 'running' },
      env({ hasLiveTmux: false, worktreeExists: false, tmuxAvailable: false })
    )
    expect(result.outcome).toBe('dead-no-worktree')
  })

  it('marks the session dead when tmux is unavailable', () => {
    const result = deriveRestoredState(
      { ...LOCAL, status: 'running' },
      env({ hasLiveTmux: false, worktreeExists: true, tmuxAvailable: false })
    )
    expect(result).toEqual({ status: 'dead', connectionState: undefined, outcome: 'dead-no-tmux' })
  })

  it('defers to lazy restore (pending) when the worktree exists and tmux is available', () => {
    expect(
      deriveRestoredState(
        { ...LOCAL, status: 'running' },
        env({ hasLiveTmux: false, worktreeExists: true, tmuxAvailable: true })
      )
    ).toEqual({ status: 'idle', connectionState: 'pending', outcome: 'defer' })
  })

  it('preserves needs_input when deferring', () => {
    expect(
      deriveRestoredState(
        { ...LOCAL, status: 'needs_input' },
        env({ hasLiveTmux: false, worktreeExists: true, tmuxAvailable: true })
      )
    ).toEqual({ status: 'needs_input', connectionState: 'pending', outcome: 'defer' })
  })
})

describe('deriveRestoredState — local terminal sessions (completed/error)', () => {
  it('marks a terminal session dead when its tmux is gone', () => {
    for (const status of ['completed', 'error'] as SessionStatus[]) {
      const result = deriveRestoredState({ ...LOCAL, status }, env({ hasLiveTmux: false }))
      expect(result).toEqual({
        status: 'dead',
        connectionState: undefined,
        outcome: 'terminal-dead',
      })
    }
  })

  it('keeps a terminal session as-is when tmux is still alive', () => {
    for (const status of ['completed', 'error'] as SessionStatus[]) {
      const result = deriveRestoredState({ ...LOCAL, status }, env({ hasLiveTmux: true }))
      expect(result).toEqual({ status, connectionState: undefined, outcome: 'terminal-alive' })
    }
  })

  it('only consults live tmux for terminal sessions, not worktree/tmux availability', () => {
    const a = deriveRestoredState(
      { ...LOCAL, status: 'completed' },
      env({ hasLiveTmux: true, worktreeExists: false, tmuxAvailable: false })
    )
    expect(a).toEqual({
      status: 'completed',
      connectionState: undefined,
      outcome: 'terminal-alive',
    })
  })
})

describe('deriveRestoredState — local dead sessions', () => {
  it('leaves an already-dead local session untouched', () => {
    const result = deriveRestoredState({ ...LOCAL, status: 'dead' }, env({ hasLiveTmux: true }))
    expect(result).toEqual({ status: 'dead', connectionState: undefined, outcome: 'inactive' })
  })
})
