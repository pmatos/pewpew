import { describe, expect, it } from 'vitest'
import {
  createRemoteReconnectCoordinator,
  type RemoteReconnectDeps,
  type SessionLookup,
} from './remote-reconnect'
import type { Host, Session } from '../shared/types'
import type { HostConnectionState } from './host-connection'
import type { PreparedRemoteHostLease } from './remote-host-runtime'
import type { RemoteTmuxProbeResult } from './pty-manager'

// A tagged error mirrors what remote-host-runtime attaches before the runtime
// entry is wiped — the coordinator classifies auth-failed/unreachable from it.
function taggedError(
  state: HostConnectionState
): Error & { hostConnectionState: HostConnectionState } {
  return Object.assign(new Error(`ssh ${state}`), { hostConnectionState: state })
}

function remoteSession(overrides: Partial<Session>): Session {
  return {
    id: 'r1',
    hostId: 'h1',
    projectPath: '/remote/proj',
    projectName: 'proj',
    worktreeName: 'feat',
    worktreePath: '/remote/proj/.claude/worktrees/feat',
    branch: 'pewpew/feat',
    pid: 0,
    tmuxSession: 'pewpew-r1',
    status: 'idle',
    connectionState: 'pending',
    lastActivity: 1000,
    hookEvents: [],
    tool: 'claude',
    ...overrides,
  }
}

// Let the fire-and-forget sibling batch and its lease release settle.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

interface Harness {
  coord: ReturnType<typeof createRemoteReconnectCoordinator>
  store: Map<string, Session>
  get(id: string): Session
  probeCalls: string[]
  reattachCalls: string[]
  leaseReleases: number
  acquireCount: number
  toasts: { severity: string; title: string }[]
  cleanupCalls: string[]
}

interface HarnessOpts {
  sessions?: Session[]
  probe?: (id: string) => Promise<RemoteTmuxProbeResult>
  acquire?: () => Promise<PreparedRemoteHostLease>
  reattach?: (id: string) => Promise<void>
  runtimeState?: () => HostConnectionState | undefined
  host?: (hostId: string) => Host | undefined
  hasPty?: (id: string) => boolean
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const store = new Map<string, Session>()
  for (const s of opts.sessions ?? [remoteSession({})]) store.set(s.id, s)

  const state = {
    probeCalls: [] as string[],
    reattachCalls: [] as string[],
    leaseReleases: 0,
    acquireCount: 0,
    toasts: [] as { severity: string; title: string }[],
    cleanupCalls: [] as string[],
  }

  const sessions: SessionLookup = {
    get: (id) => store.get(id),
    values: () => store.values(),
    changed: () => {},
  }

  const deps: RemoteReconnectDeps = {
    sessions,
    host: {
      get: opts.host ?? ((hostId) => (hostId === 'h1' ? ({ label: 'Dev' } as Host) : undefined)),
      runtimeState: opts.runtimeState ?? (() => 'live'),
      acquireLease:
        opts.acquire ??
        (async () => {
          state.acquireCount++
          return { release: async () => void state.leaseReleases++ } as PreparedRemoteHostLease
        }),
    },
    terminal: {
      probe: async (id) => {
        state.probeCalls.push(id)
        return opts.probe ? opts.probe(id) : 'present'
      },
      reattach: async (id) => {
        state.reattachCalls.push(id)
        if (opts.reattach) await opts.reattach(id)
      },
      hasPty: opts.hasPty ?? (() => false),
    },
    feedback: {
      toast: (event) => state.toasts.push({ severity: event.severity, title: event.title }),
      promptCleanup: async (id) => {
        state.cleanupCalls.push(id)
      },
    },
    now: () => 5000,
  }

  const coord = createRemoteReconnectCoordinator(deps)
  return {
    coord,
    store,
    get: (id) => {
      const s = store.get(id)
      if (!s) throw new Error(`test: session ${id} missing`)
      return s
    },
    get probeCalls() {
      return state.probeCalls
    },
    get reattachCalls() {
      return state.reattachCalls
    },
    get leaseReleases() {
      return state.leaseReleases
    },
    get acquireCount() {
      return state.acquireCount
    },
    get toasts() {
      return state.toasts
    },
    get cleanupCalls() {
      return state.cleanupCalls
    },
  }
}

describe('createRemoteReconnectCoordinator — reconnectRemoteSession', () => {
  it('present → reattach and mark live, then release the lease after the batch', async () => {
    const h = makeHarness({ sessions: [remoteSession({ id: 'r1', status: 'idle' })] })

    await h.coord.reconnectRemoteSession('r1')
    await flush()

    expect(h.get('r1').connectionState).toBe('live')
    expect(h.get('r1').status).toBe('idle')
    expect(h.reattachCalls).toEqual(['r1'])
    expect(h.acquireCount).toBe(1)
    expect(h.leaseReleases).toBe(1)
  })

  it('absent → mark dead without reattaching', async () => {
    const h = makeHarness({
      sessions: [remoteSession({ id: 'r1', status: 'idle' })],
      probe: async () => 'absent',
    })

    await h.coord.reconnectRemoteSession('r1')
    await flush()

    expect(h.get('r1').status).toBe('dead')
    expect(h.get('r1').connectionState).toBe('offline')
    expect(h.reattachCalls).toEqual([])
  })

  it('is a no-op for a terminal (completed) session — never probes or acquires', async () => {
    const h = makeHarness({ sessions: [remoteSession({ id: 'r1', status: 'completed' })] })

    await h.coord.reconnectRemoteSession('r1')

    expect(h.get('r1').status).toBe('completed')
    expect(h.probeCalls).toEqual([])
    expect(h.acquireCount).toBe(0)
  })

  it('coalesces two concurrent reconnects of one id into a single SSH attempt', async () => {
    const h = makeHarness({ sessions: [remoteSession({ id: 'r1', status: 'idle' })] })

    await Promise.all([h.coord.reconnectRemoteSession('r1'), h.coord.reconnectRemoteSession('r1')])
    await flush()

    expect(h.acquireCount).toBe(1)
    expect(h.probeCalls).toEqual(['r1'])
  })

  // The SessionLookup live-mutation contract: get()/values() must hand back the
  // registry's own mutable Session, because the coordinator re-derives the probe
  // transition against session.status *after* the reattach await. A concurrent
  // session.end → Keep that resolves the session to terminal during that await
  // must survive — a copy-returning store would silently revert it.
  it('does not clobber a session that goes terminal during the reattach await', async () => {
    const store = [remoteSession({ id: 'r1', status: 'running' })]
    const h = makeHarness({
      sessions: store,
      reattach: async () => {
        // The Keep lands while parked on the reattach await.
        const live = h.get('r1')
        live.status = 'completed'
        live.connectionState = 'live'
      },
    })

    await h.coord.reconnectRemoteSession('r1')
    await flush()

    // Without the post-await re-derive, the cached 'running → idle' delta would
    // revert the user's Keep back to 'idle'.
    expect(h.get('r1').status).toBe('completed')
    expect(h.get('r1').connectionState).toBe('live')
    expect(h.reattachCalls).toEqual(['r1'])
  })

  it('auth-failed lease acquisition → connectionState auth-failed, no probe', async () => {
    const h = makeHarness({
      sessions: [remoteSession({ id: 'r1', status: 'idle' })],
      acquire: async () => {
        throw taggedError('auth-failed')
      },
    })

    await expect(h.coord.reconnectRemoteSession('r1')).rejects.toThrow(/auth-failed/)
    await flush()

    expect(h.get('r1').connectionState).toBe('auth-failed')
    expect(h.probeCalls).toEqual([])
  })
})

describe('createRemoteReconnectCoordinator — probePendingSessionsOnHost', () => {
  it('auth-failed hint short-circuits: every pending sibling inherits it, no probing', async () => {
    const h = makeHarness({
      sessions: [
        remoteSession({ id: 'a', hostId: 'h1', connectionState: 'pending' }),
        remoteSession({ id: 'b', hostId: 'h1', connectionState: 'pending' }),
      ],
    })

    await h.coord.probePendingSessionsOnHost('h1', 'auth-failed')

    expect(h.get('a').connectionState).toBe('auth-failed')
    expect(h.get('b').connectionState).toBe('auth-failed')
    expect(h.probeCalls).toEqual([])
  })

  it('a mid-batch SSH failure stops the cascade; later siblings stay pending', async () => {
    const h = makeHarness({
      sessions: [
        remoteSession({ id: 'a', hostId: 'h1', status: 'idle', connectionState: 'pending' }),
        remoteSession({ id: 'b', hostId: 'h1', status: 'idle', connectionState: 'pending' }),
        remoteSession({ id: 'c', hostId: 'h1', status: 'idle', connectionState: 'pending' }),
      ],
      runtimeState: () => 'live',
      probe: async (id) => {
        if (id === 'b') throw taggedError('unreachable')
        return 'present'
      },
    })

    await h.coord.probePendingSessionsOnHost('h1')

    expect(h.get('a').connectionState).toBe('live')
    expect(h.get('b').connectionState).toBe('unreachable')
    expect(h.get('c').connectionState).toBe('pending')
  })
})
