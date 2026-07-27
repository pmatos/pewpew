import { describe, expect, it } from 'vitest'
import type { SessionStatus } from '../shared/types'
import { classifyAutoReconnectResult } from './reconnect-outcome'

// Seam under test: the pure `classifyAutoReconnectResult` decision core extracted
// from `attemptAutoReconnect`. Given the session state observed *after* a probe
// reconnect returns, it maps that state to a scheduler outcome plus the single
// side effect the caller must realize. Expected values are the documented
// behaviour of the original inline branches (the spec) read top-to-bottom, not a
// recomputation of the new implementation — the branch precedence is the point.

describe('classifyAutoReconnectResult — no live/dead/auth signal', () => {
  it('retries when the connection is merely unreachable and the session is not terminal', () => {
    // The fall-through: no 'live', not terminal, not 'dead', not 'auth-failed' —
    // the remote may still be up, so the scheduler backs off and retries.
    expect(classifyAutoReconnectResult({ status: 'idle', connectionState: 'unreachable' })).toEqual(
      {
        outcome: 'retry',
        effect: 'none',
      }
    )
  })
})

describe('classifyAutoReconnectResult — resolved signals', () => {
  it('recovers with a "Reconnected" toast when the connection went live', () => {
    for (const status of ['running', 'idle', 'needs_input'] as SessionStatus[]) {
      expect(classifyAutoReconnectResult({ status, connectionState: 'live' })).toEqual({
        outcome: 'recovered',
        effect: 'toast-reconnected',
      })
    }
  })

  it('gives up and prompts cleanup when the remote confirmed the session dead', () => {
    // A probe that flipped the session to 'dead' means the agent ended: prompt the
    // same "Clean up worktree?" dialog a local session gets on exit.
    expect(classifyAutoReconnectResult({ status: 'dead', connectionState: 'offline' })).toEqual({
      outcome: 'gave-up',
      effect: 'prompt-cleanup',
    })
  })

  it('gives up with an auth-failed toast when SSH authentication failed', () => {
    expect(classifyAutoReconnectResult({ status: 'idle', connectionState: 'auth-failed' })).toEqual(
      {
        outcome: 'gave-up',
        effect: 'toast-auth-failed',
      }
    )
  })

  it('gives up silently for a session that already resolved to terminal', () => {
    // Resolved to completed/error while the probe was in flight (e.g. a late
    // session.end → Keep): don't toast "Reconnected" or re-drive cleanup.
    for (const status of ['completed', 'error'] as SessionStatus[]) {
      expect(classifyAutoReconnectResult({ status, connectionState: 'unreachable' })).toEqual({
        outcome: 'gave-up',
        effect: 'none',
      })
    }
  })
})

describe('classifyAutoReconnectResult — branch precedence (source order)', () => {
  // These pin the top-to-bottom precedence of the original inline branches. An
  // inversion here is exactly the bug that reverts a kept worktree or clobbers a
  // recovery, so they are the load-bearing rows.

  it('lets a terminal status win over a live connection', () => {
    expect(classifyAutoReconnectResult({ status: 'completed', connectionState: 'live' })).toEqual({
      outcome: 'gave-up',
      effect: 'none',
    })
  })

  it('lets a live connection win over a dead status', () => {
    expect(classifyAutoReconnectResult({ status: 'dead', connectionState: 'live' })).toEqual({
      outcome: 'recovered',
      effect: 'toast-reconnected',
    })
  })

  it('lets a dead status win over an auth-failed connection', () => {
    expect(classifyAutoReconnectResult({ status: 'dead', connectionState: 'auth-failed' })).toEqual(
      {
        outcome: 'gave-up',
        effect: 'prompt-cleanup',
      }
    )
  })
})
