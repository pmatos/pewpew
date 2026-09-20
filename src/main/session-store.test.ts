import { describe, it, expect } from 'vitest'
import type { Session } from '../shared/types'
import {
  createSessionStore,
  LAST_KNOWN_STATE_MAX_BYTES,
  LAST_KNOWN_STATE_MIN_INTERVAL_MS,
  type SessionStore,
} from './session-store'

// Epoch-scale, because the rate limiter's "never written" sentinel is `?? 0`
// rather than an explicit absence check: a `now` smaller than the 10s window
// reads as "written at time 0, within the window" and is suppressed. Real
// callers always pass Date.now(), so this is unreachable in production — it is
// pinned explicitly below rather than designed around.
const T0 = 1_700_000_000_000

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'a',
    hostId: null,
    projectPath: '/proj',
    projectName: 'proj',
    worktreeName: 'feat',
    worktreePath: '/proj/.claude/worktrees/feat',
    branch: 'pewpew/feat',
    pid: 0,
    tmuxSession: 'pewpew-a',
    status: 'idle',
    lastActivity: 1000,
    hookEvents: [],
    tool: 'claude',
    ...overrides,
  }
}

interface Harness {
  store: SessionStore
  saved: Session[][]
  published: Session[][]
  trayed: Session[][]
  order: string[]
  persistThrows: { on: boolean }
  broadcastThrows: { on: boolean }
}

// The whole harness: three recorders and no vi.mock. The store imports nothing
// but the Session types, so there is no fs, no electron and no clock to stub.
function harness(...seed: Session[]): Harness {
  const h = {
    saved: [] as Session[][],
    published: [] as Session[][],
    trayed: [] as Session[][],
    order: [] as string[],
    persistThrows: { on: false },
    broadcastThrows: { on: false },
  }
  const store = createSessionStore({
    persist: {
      save: (s) => {
        h.order.push('persist')
        if (h.persistThrows.on) throw new Error('ENOSPC')
        h.saved.push(s)
      },
    },
    broadcast: {
      publish: (s) => {
        h.order.push('broadcast')
        if (h.broadcastThrows.on) throw new Error('renderer gone')
        h.published.push(s)
      },
    },
    tray: {
      update: (s) => {
        h.order.push('tray')
        h.trayed.push(s)
      },
    },
  })
  for (const s of seed) store.insert(s)
  return { ...h, store }
}

describe('reads hand back live references', () => {
  it('get returns the stored object itself, not a copy', () => {
    const s = session()
    const h = harness(s)
    expect(h.store.get('a')).toBe(s)
  })

  it('a field written through get is visible via values, all and the sinks', () => {
    const h = harness(session())
    const live = h.store.get('a')
    expect(live).toBeDefined()
    if (!live) return
    live.connectionState = 'connecting'

    expect([...h.store.values()][0]).toBe(live)
    expect(h.store.all()[0]).toBe(live)

    h.store.changed()
    const saved = h.saved[0]
    expect(saved).toBeDefined()
    if (!saved) return
    expect(saved[0]).toBe(live)
  })

  it('all returns a fresh array but the store’s own elements', () => {
    const h = harness(session())
    expect(h.store.all()).not.toBe(h.store.all())
    expect(h.store.all()[0]).toBe(h.store.get('a'))
  })

  it('values is lazy: an entry deleted mid-iteration is skipped, and nothing else is', () => {
    const h = harness(session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c' }))
    const seen: string[] = []
    for (const s of h.store.values()) {
      seen.push(s.id)
      if (s.id === 'a') h.store.delete('b')
    }
    expect(seen).toEqual(['a', 'c'])
  })

  it('values tolerates deleting the current entry mid-iteration: nothing is skipped or repeated', () => {
    const h = harness(session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c' }))
    const seen: string[] = []
    for (const s of h.store.values()) {
      seen.push(s.id)
      if (s.id !== 'b') h.store.delete(s.id)
    }
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(h.store.all().map((s) => s.id)).toEqual(['b'])
  })
})

describe('changed() is the only thing that reaches a sink', () => {
  it('fans out persist → broadcast → tray, in that order', () => {
    const h = harness(session())
    h.store.changed()
    expect(h.order).toEqual(['persist', 'broadcast', 'tray'])
  })

  it('hands all three sinks the same array instance', () => {
    const h = harness(session())
    h.store.changed()
    expect(h.published[0]).toBe(h.saved[0])
    expect(h.trayed[0]).toBe(h.saved[0])
  })

  it('builds a fresh snapshot per flush', () => {
    const h = harness(session())
    h.store.changed()
    h.store.changed()
    expect(h.saved[1]).not.toBe(h.saved[0])
  })

  it('a throwing persist aborts before the renderer is told', () => {
    const h = harness(session())
    h.persistThrows.on = true
    expect(() => h.store.changed()).toThrow('ENOSPC')
    expect(h.order).toEqual(['persist'])
  })

  it('a throwing broadcast aborts before the tray, but persist already landed', () => {
    const h = harness(session())
    h.broadcastThrows.on = true
    expect(() => h.store.changed()).toThrow('renderer gone')
    expect(h.order).toEqual(['persist', 'broadcast'])
    expect(h.saved).toHaveLength(1)
    expect(h.trayed).toEqual([])
  })

  it('no mutator notifies on its own', () => {
    const h = harness(session())
    h.store.insert(session({ id: 'b' }))
    h.store.replace('b', session({ id: 'b', status: 'dead' }))
    h.store.setStatus('a', 'running', T0)
    h.store.recordLastKnownState('a', 'text', T0)
    h.store.delete('b')
    expect(h.order).toEqual([])
  })
})

describe('membership', () => {
  it('insert adds in order; replace preserves position', () => {
    const h = harness(session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c' }))
    expect(h.store.replace('b', session({ id: 'b', status: 'dead' }))).toBe(true)
    expect(h.store.all().map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(h.store.get('b')?.status).toBe('dead')
  })

  it('insert on an existing id replaces the entry: last write wins, no duplicate', () => {
    const first = session({ id: 'a', status: 'idle' })
    const second = session({ id: 'a', status: 'dead' })
    const h = harness(first)
    h.store.insert(second)
    expect(h.store.get('a')).toBe(second)
    expect(h.store.all()).toEqual([second])
  })

  it('replace is a no-op for an unknown id or the object already stored', () => {
    const stored = session({ id: 'a' })
    const h = harness(stored)
    expect(h.store.replace('nope', session({ id: 'nope' }))).toBe(false)
    expect(h.store.replace('a', stored)).toBe(false)
  })

  it('replace swaps object identity, so a reference held across it goes stale', () => {
    const before = session({ id: 'a', status: 'idle' })
    const h = harness(before)
    h.store.replace('a', session({ id: 'a', status: 'dead' }))
    expect(h.store.get('a')).not.toBe(before)
    before.status = 'running'
    expect(h.store.get('a')?.status).toBe('dead')
  })

  it('delete reports whether the entry was present', () => {
    const h = harness(session())
    expect(h.store.delete('a')).toBe(true)
    expect(h.store.delete('a')).toBe(false)
    expect(h.store.get('a')).toBeUndefined()
  })
})

describe('setStatus', () => {
  it('sets the status and stamps lastActivity from the supplied clock', () => {
    const h = harness(session({ status: 'idle', lastActivity: 1 }))
    expect(h.store.setStatus('a', 'running', 9999)).toBe(true)
    expect(h.store.get('a')?.status).toBe('running')
    expect(h.store.get('a')?.lastActivity).toBe(9999)
  })

  it('reports true even when the status is unchanged — lastActivity still moves', () => {
    const h = harness(session({ status: 'idle', lastActivity: 1 }))
    expect(h.store.setStatus('a', 'idle', 9999)).toBe(true)
    expect(h.store.get('a')?.lastActivity).toBe(9999)
  })

  it('reports false for an unknown id', () => {
    const h = harness(session())
    expect(h.store.setStatus('nope', 'dead', T0)).toBe(false)
  })

  it('mutates in place, preserving object identity', () => {
    const h = harness(session())
    const live = h.store.get('a')
    h.store.setStatus('a', 'dead', T0)
    expect(h.store.get('a')).toBe(live)
  })
})

describe('recordLastKnownState', () => {
  it('records text and timestamp on the first write', () => {
    const h = harness(session())
    expect(h.store.recordLastKnownState('a', 'hello', T0)).toBe(true)
    expect(h.store.get('a')?.lastKnownState).toEqual({ text: 'hello', timestamp: T0 })
  })

  it('caps the recorded text at 3 KiB, keeping the tail', () => {
    const h = harness(session())
    h.store.recordLastKnownState('a', 'x'.repeat(5 * 1024) + 'TAIL', T0)
    const text = h.store.get('a')?.lastKnownState?.text
    expect(text?.length).toBe(LAST_KNOWN_STATE_MAX_BYTES)
    expect(text?.endsWith('TAIL')).toBe(true)
  })

  it('rate-limits to one write per session per 10s — the boundary exactly', () => {
    const h = harness(session())
    expect(h.store.recordLastKnownState('a', 'first', T0)).toBe(true)
    // 1ms inside the window: suppressed.
    expect(
      h.store.recordLastKnownState('a', 'second', T0 + LAST_KNOWN_STATE_MIN_INTERVAL_MS - 1)
    ).toBe(false)
    expect(h.store.get('a')?.lastKnownState?.text).toBe('first')
    // Exactly on the boundary: allowed.
    expect(h.store.recordLastKnownState('a', 'third', T0 + LAST_KNOWN_STATE_MIN_INTERVAL_MS)).toBe(
      true
    )
    expect(h.store.get('a')?.lastKnownState?.text).toBe('third')
  })

  it('suppresses an unchanged text even once the window has elapsed', () => {
    const h = harness(session())
    h.store.recordLastKnownState('a', 'idle prompt $', T0)
    expect(h.store.recordLastKnownState('a', 'idle prompt $', T0 + 60_000)).toBe(false)
    // A real change still goes through.
    expect(h.store.recordLastKnownState('a', 'idle prompt $ ls', T0 + 60_000)).toBe(true)
  })

  it('compares the capped text, so two over-long texts with one tail are one no-op', () => {
    const h = harness(session())
    const tail = 'y'.repeat(LAST_KNOWN_STATE_MAX_BYTES)
    h.store.recordLastKnownState('a', 'AAAA' + tail, T0)
    expect(h.store.recordLastKnownState('a', 'BBBB' + tail, T0 + 60_000)).toBe(false)
  })

  it('reports false for an unknown id', () => {
    const h = harness(session())
    expect(h.store.recordLastKnownState('nope', 'x', T0)).toBe(false)
  })

  it('rate-limits per session, not globally', () => {
    const h = harness(session({ id: 'a' }), session({ id: 'b' }))
    expect(h.store.recordLastKnownState('a', 'aa', T0)).toBe(true)
    expect(h.store.recordLastKnownState('b', 'bb', T0)).toBe(true)
  })

  it('treats a never-written session as written at time 0 (the `?? 0` sentinel)', () => {
    // Pinning a sharp edge rather than designing around it: the first write is
    // accepted only because Date.now() dwarfs the 10s window. A `now` inside the
    // window reads as "already written at 0" and is suppressed. Unreachable from
    // production callers, which all pass Date.now(); asserted so that anyone who
    // later swaps the sentinel for an explicit absence check sees this move.
    const h = harness(session())
    expect(h.store.recordLastKnownState('a', 'x', LAST_KNOWN_STATE_MIN_INTERVAL_MS - 1)).toBe(false)
    expect(h.store.recordLastKnownState('a', 'x', LAST_KNOWN_STATE_MIN_INTERVAL_MS)).toBe(true)
  })
})

describe('batch', () => {
  it('flushes once when the body reports a mutation', () => {
    const h = harness(session({ id: 'a' }), session({ id: 'b' }))
    const notified = h.store.batch(() => {
      let any = false
      if (h.store.recordLastKnownState('a', 'aa', T0)) any = true
      if (h.store.recordLastKnownState('b', 'bb', T0)) any = true
      return any
    })
    expect(notified).toBe(true)
    expect(h.order).toEqual(['persist', 'broadcast', 'tray'])
  })

  it('flushes NOTHING when the body reports no mutation', () => {
    const h = harness(session())
    h.store.recordLastKnownState('a', 'first', T0)
    const notified = h.store.batch(() =>
      // Every update rate-limited: the body reports false.
      h.store.recordLastKnownState('a', 'second', T0 + 1)
    )
    expect(notified).toBe(false)
    expect(h.order).toEqual([])
  })

  it('does not flush on a throw', () => {
    const h = harness(session())
    expect(() =>
      h.store.batch(() => {
        h.store.setStatus('a', 'dead', T0)
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(h.order).toEqual([])
  })
})

describe('the SessionLookup port remote-reconnect declares', () => {
  it('is satisfied structurally, so the adapter can be a pass-through', () => {
    // Compile-time guard: SessionStore must keep get/values/changed compatible
    // with remote-reconnect.ts's SessionLookup. A drift here is a type error,
    // which is the whole point of this assertion.
    const h = harness(session())
    const lookup: {
      get(id: string): Session | undefined
      values(): Iterable<Session>
      changed(): void
    } = h.store
    expect(lookup.get('a')).toBe(h.store.get('a'))
    lookup.changed()
    expect(h.order).toEqual(['persist', 'broadcast', 'tray'])
    expect(h.saved[0]?.[0]).toBe(h.store.get('a'))
  })
})
