import { describe, expect, it } from 'vitest'
import type { Session, SessionStatus } from '../shared/types'
import { applyProbeTransition, computeProbeTransition } from './probe-transition'

// Seam under test: the pure `computeProbeTransition` decision core extracted from
// the two remote-probe sites (`doReconnectRemoteSession` and the pending-batch
// `doProbePendingSessionsOnHost`). Expected values are the documented behaviour of
// the original inline present/absent/unreachable branches (the spec), not a
// recomputation of the new implementation. `applyProbeTransition` is the mutation
// step that writes the sparse delta back onto a session.

const NOW = 1_700_000_000_000

describe('computeProbeTransition — tmux session present', () => {
  it('reattaches and goes live, flipping a running session to idle', () => {
    expect(computeProbeTransition('running', 'present', NOW)).toEqual({
      connectionState: 'live',
      status: 'idle',
      lastActivity: NOW,
      reattach: true,
    })
  })

  it('goes live without touching status for a non-running session', () => {
    // Only `running` collapses to `idle`; idle/needs_input keep their status so a
    // reattach never rewrites a session that was already waiting on the user.
    for (const status of ['idle', 'needs_input'] as SessionStatus[]) {
      const transition = computeProbeTransition(status, 'present', NOW)
      expect(transition).toEqual({
        connectionState: 'live',
        lastActivity: NOW,
        reattach: true,
      })
      expect(transition).not.toHaveProperty('status')
    }
  })
})

describe('computeProbeTransition — tmux session absent', () => {
  it('marks the session offline + dead and stamps activity', () => {
    for (const status of ['running', 'idle', 'needs_input'] as SessionStatus[]) {
      expect(computeProbeTransition(status, 'absent', NOW)).toEqual({
        connectionState: 'offline',
        status: 'dead',
        lastActivity: NOW,
      })
    }
  })

  it('does not request a reattach', () => {
    expect(computeProbeTransition('running', 'absent', NOW)).not.toHaveProperty('reattach')
  })
})

describe('computeProbeTransition — probe unreachable', () => {
  it('marks unreachable only, leaving status and activity untouched', () => {
    // An SSH-level failure must not touch status/lastActivity: the remote agent may
    // still be running, so the caller keeps the session recoverable.
    const transition = computeProbeTransition('running', 'unreachable', NOW)
    expect(transition).toEqual({ connectionState: 'unreachable' })
    expect(transition).not.toHaveProperty('status')
    expect(transition).not.toHaveProperty('lastActivity')
    expect(transition).not.toHaveProperty('reattach')
  })
})

describe('computeProbeTransition — terminal sessions are skipped', () => {
  it('returns null for completed/error regardless of the probe result', () => {
    // A session that resolved to terminal while the probe was in flight (e.g. a
    // late session.end → Keep) must be left untouched so a stale probe can't revert
    // a kept session to dead.
    for (const status of ['completed', 'error'] as SessionStatus[]) {
      for (const probe of ['present', 'absent', 'unreachable'] as const) {
        expect(computeProbeTransition(status, probe, NOW)).toBeNull()
      }
    }
  })
})

describe('applyProbeTransition', () => {
  const session = (over: Partial<Session> = {}): Session => ({
    id: 's1',
    hostId: 'host-1',
    projectPath: '/repo',
    projectName: 'repo',
    worktreeName: 'wt',
    worktreePath: '/repo/.claude/worktrees/wt',
    branch: 'wt',
    pid: 0,
    tmuxSession: 'pewpew-s1',
    status: 'running',
    connectionState: 'connecting',
    lastActivity: 1,
    hookEvents: [],
    tool: 'claude',
    ...over,
  })

  it('writes every field present on a live transition', () => {
    const s = session({ status: 'running', connectionState: 'connecting', lastActivity: 1 })
    applyProbeTransition(s, {
      connectionState: 'live',
      status: 'idle',
      lastActivity: NOW,
      reattach: true,
    })
    expect(s.connectionState).toBe('live')
    expect(s.status).toBe('idle')
    expect(s.lastActivity).toBe(NOW)
  })

  it('leaves status and lastActivity untouched for an unreachable delta', () => {
    const s = session({ status: 'running', connectionState: 'connecting', lastActivity: 1 })
    applyProbeTransition(s, { connectionState: 'unreachable' })
    expect(s.connectionState).toBe('unreachable')
    expect(s.status).toBe('running')
    expect(s.lastActivity).toBe(1)
  })

  it('preserves the status of a non-running session going live', () => {
    const s = session({ status: 'needs_input', connectionState: 'connecting', lastActivity: 1 })
    applyProbeTransition(s, { connectionState: 'live', lastActivity: NOW, reattach: true })
    expect(s.connectionState).toBe('live')
    expect(s.status).toBe('needs_input')
    expect(s.lastActivity).toBe(NOW)
  })
})
