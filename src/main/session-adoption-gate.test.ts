import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../shared/types'
import { createSessionAdoptionGate } from './session-adoption-gate'

function makeSession(overrides: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    hostId: null,
    projectPath: '/proj',
    projectName: 'proj',
    worktreeName: 'wt',
    worktreePath: '/worktrees/wt',
    branch: 'main',
    pid: 0,
    tmuxSession: 'pewpew-wt',
    status: 'idle',
    lastActivity: 0,
    hookEvents: [],
    tool: 'claude',
    ...overrides,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('Session adoption gate', () => {
  it('reuses a compatible Session through the canonical local identity', async () => {
    const existing = makeSession({
      id: 'existing',
      hostId: 'remote-host',
      worktreePath: '/canonical/wt',
    })
    const start = vi.fn(async () => makeSession({ id: 'new' }))
    const gate = createSessionAdoptionGate({
      sessions: () => [existing],
      canonicalizePath: (path) => (path === '/alias/wt' ? '/canonical/wt' : path),
    })

    const result = await gate.adopt(
      { placement: 'local', worktreePath: '/alias/wt' },
      'claude',
      start
    )

    expect(result).toBe(existing)
    expect(start).not.toHaveBeenCalled()
  })

  it('rejects an incompatible existing Session without starting adoption', async () => {
    const existing = makeSession({ id: 'existing', tool: 'codex' })
    const start = vi.fn(async () => makeSession({ id: 'new' }))
    const gate = createSessionAdoptionGate({
      sessions: () => [existing],
      canonicalizePath: (path) => path,
    })

    await expect(
      gate.adopt({ placement: 'local', worktreePath: existing.worktreePath }, 'claude', start)
    ).rejects.toThrow(
      'Worktree already has a codex session; mixed tools per worktree are not supported'
    )
    expect(start).not.toHaveBeenCalled()
  })

  it('coalesces concurrent same-tool adoption for one remote Placement', async () => {
    const attempt = deferred<Session>()
    const adopted = makeSession({ id: 'adopted', hostId: 'h1', worktreePath: '/remote/wt' })
    const start = vi.fn(() => attempt.promise)
    const gate = createSessionAdoptionGate({
      sessions: () => [],
      canonicalizePath: (path) => path,
    })
    const target = { placement: 'remote' as const, hostId: 'h1', worktreePath: '/remote/wt' }

    const first = gate.adopt(target, 'claude', start)
    const second = gate.adopt(target, 'claude', start)
    attempt.resolve(adopted)

    await expect(first).resolves.toBe(adopted)
    await expect(second).resolves.toBe(adopted)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('rejects a different tool while adoption is in flight', async () => {
    const attempt = deferred<Session>()
    const gate = createSessionAdoptionGate({
      sessions: () => [],
      canonicalizePath: (path) => path,
    })
    const target = { placement: 'remote' as const, hostId: 'h1', worktreePath: '/remote/wt' }

    const first = gate.adopt(target, 'codex', () => attempt.promise)
    await expect(
      gate.adopt(target, 'claude', async () => makeSession({ id: 'wrong' }))
    ).rejects.toThrow(
      'Worktree already has a codex session in-flight; mixed tools per worktree are not supported'
    )

    attempt.resolve(makeSession({ id: 'adopted', hostId: 'h1', worktreePath: '/remote/wt' }))
    await first
  })

  it('keeps identical remote paths independent across Hosts', async () => {
    const existing = makeSession({ id: 'h1-session', hostId: 'h1', worktreePath: '/remote/wt' })
    const adopted = makeSession({ id: 'h2-session', hostId: 'h2', worktreePath: '/remote/wt' })
    const start = vi.fn(async () => adopted)
    const gate = createSessionAdoptionGate({
      sessions: () => [existing],
      canonicalizePath: (path) => path,
    })

    await expect(
      gate.adopt({ placement: 'remote', hostId: 'h2', worktreePath: '/remote/wt' }, 'claude', start)
    ).resolves.toBe(adopted)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('allows retry after a failed adoption', async () => {
    const failure = new Error('spawn failed')
    const adopted = makeSession({ id: 'retry' })
    const start = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(adopted)
    const gate = createSessionAdoptionGate({
      sessions: () => [],
      canonicalizePath: (path) => path,
    })
    const target = { placement: 'local' as const, worktreePath: '/worktrees/wt' }

    await expect(gate.adopt(target, 'claude', start)).rejects.toBe(failure)
    await expect(gate.adopt(target, 'claude', start)).resolves.toBe(adopted)
    expect(start).toHaveBeenCalledTimes(2)
  })
})
