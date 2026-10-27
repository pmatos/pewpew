import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../shared/types'
import {
  selectNumbersToOpen,
  openNumberedSessions,
  type NumberedSessionRequest,
  type NumberedSessionAdapters,
} from './numbered-session-plan'

function makeSession(overrides: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    hostId: null,
    projectPath: '/proj',
    projectName: 'proj',
    worktreeName: 'wt',
    worktreePath: '/proj/.claude/worktrees/wt',
    branch: 'main',
    pid: 0,
    tmuxSession: 'pewpew-x',
    status: 'idle',
    lastActivity: 0,
    hookEvents: [],
    tool: 'claude',
    ...overrides,
  }
}

function batch(
  request: Partial<NumberedSessionRequest> = {},
  adapters: Partial<NumberedSessionAdapters> = {}
) {
  const input: NumberedSessionRequest = {
    kind: 'pr',
    projectPath: '/proj',
    hostId: null,
    numbers: [1, 2, 3],
    options: {},
    ...request,
  }
  const effects = {
    sessions: vi.fn(() => [] as Session[]),
    defaultTool: vi.fn(() => 'claude' as const),
    list: vi.fn(async () => [{ number: 1 }, { number: 2 }, { number: 3 }]),
    create: vi.fn(async (_path: string, number: number) =>
      makeSession({ id: `new-${number}`, prNumber: number })
    ),
    describeError: vi.fn((error: unknown) => `formatted: ${String(error)}`),
    ...adapters,
  }
  return { input, effects, run: () => openNumberedSessions(input, effects) }
}

describe('openNumberedSessions', () => {
  it('sorts and deduplicates explicit numbers before filtering to open items', async () => {
    const numbers = [3, 1, 3, 2, 4]
    const b = batch({ numbers }, { list: async () => [{ number: 3 }, { number: 1 }] })
    expect(await b.run()).toMatchObject({
      created: [expect.objectContaining({ prNumber: 1 }), expect.objectContaining({ prNumber: 3 })],
      skipped: [],
      failed: [],
    })
    expect(numbers).toEqual([3, 1, 3, 2, 4])
  })

  it.each([{ numbers: [] }, { numbers: [7] }, { numbers: [7, 7] }])(
    'bypasses listing for $numbers explicit numbers',
    async ({ numbers }) => {
      const b = batch({ numbers })
      const result = await b.run()
      expect(b.effects.list).not.toHaveBeenCalled()
      expect(b.effects.create).toHaveBeenCalledTimes(numbers.length === 0 ? 0 : 1)
      expect(result).toMatchObject({ skipped: [], failed: [] })
    }
  )

  it.each([
    ['pr', 'PRs'],
    ['issue', 'issues'],
  ] as const)('returns the existing no-open message for %s requests', async (kind, noun) => {
    const b = batch({ kind }, { list: async () => [] })
    expect(await b.run()).toBe(`None of the requested ${noun} are open.`)
    expect(b.effects.sessions).not.toHaveBeenCalled()
    expect(b.effects.create).not.toHaveBeenCalled()
  })

  it('preserves all-open listing order and reports duplicate listed numbers as skipped', async () => {
    const b = batch(
      { numbers: undefined },
      { list: async () => [{ number: 3 }, { number: 1 }, { number: 3 }, { number: 2 }] }
    )
    expect(await b.run()).toEqual({
      created: [3, 1, 2].map((number) => makeSession({ id: `new-${number}`, prNumber: number })),
      reused: [],
      skipped: [3],
      failed: [],
    })
  })

  it('returns an empty summary when the all-open listing is empty', async () => {
    const b = batch({ numbers: undefined }, { list: async () => [] })
    expect(await b.run()).toEqual({ created: [], reused: [], skipped: [], failed: [] })
  })

  it.each([{ numbers: undefined }, { numbers: [1, 2] }])(
    'returns listing failures before reading state ($numbers)',
    async ({ numbers }) => {
      const b = batch({ numbers }, { list: async () => 'gh unavailable' })
      expect(await b.run()).toBe('gh unavailable')
      expect(b.effects.sessions).not.toHaveBeenCalled()
      expect(b.effects.defaultTool).not.toHaveBeenCalled()
      expect(b.effects.create).not.toHaveBeenCalled()
    }
  )

  it('formats a thrown listing error without starting creation', async () => {
    const error = { stderr: 'rate limited' }
    const b = batch(
      {},
      {
        list: async () => {
          throw error
        },
      }
    )
    expect(await b.run()).toBe('formatted: [object Object]')
    expect(b.effects.describeError).toHaveBeenCalledWith(error)
    expect(b.effects.sessions).not.toHaveBeenCalled()
    expect(b.effects.create).not.toHaveBeenCalled()
  })

  it.each(['pr', 'issue'] as const)(
    'scopes occupied %s numbers by project, host and field',
    async (kind) => {
      const field = kind === 'pr' ? 'prNumber' : 'issueNumber'
      const otherField = kind === 'pr' ? 'issueNumber' : 'prNumber'
      const sessions = [
        makeSession({ id: 'matching', hostId: 'h1', [field]: 1 }),
        makeSession({ id: 'local', [field]: 2 }),
        makeSession({ id: 'other-host', hostId: 'h2', [field]: 2 }),
        makeSession({ id: 'other-project', hostId: 'h1', projectPath: '/other', [field]: 2 }),
        makeSession({ id: 'other-kind', hostId: 'h1', [otherField]: 2 }),
        makeSession({ id: 'unnumbered', hostId: 'h1' }),
      ]
      const b = batch({ kind, hostId: 'h1', numbers: [1, 2] }, { sessions: () => sessions })
      expect(await b.run()).toMatchObject({
        skipped: [1],
        created: [expect.objectContaining({ id: 'new-2' })],
        reused: [],
      })
      expect(sessions).toHaveLength(6)
    }
  )

  it('uses the post-listing snapshot for both occupied numbers and reused Session ids', async () => {
    const sessions: Session[] = []
    const reused = makeSession({ id: 'existing', issueNumber: 99 })
    const readSessions = vi.fn(() => [...sessions])
    const b = batch(
      {},
      {
        list: async () => {
          sessions.push(makeSession({ id: 'occupied', prNumber: 1 }), reused)
          return [{ number: 1 }, { number: 2 }]
        },
        sessions: readSessions,
        create: async () => reused,
      }
    )
    expect(await b.run()).toEqual({ created: [], reused: [reused], skipped: [1], failed: [] })
    expect(readSessions).toHaveBeenCalledTimes(1)
  })

  it('keeps a pre-creation snapshot even when creation adds Sessions to the live array', async () => {
    const sessions = [makeSession({ id: 'existing', issueNumber: 99 })]
    const fresh = makeSession({ id: 'fresh', prNumber: 1 })
    const b = batch(
      { numbers: [1] },
      {
        sessions: () => sessions,
        create: async () => {
          sessions.push(fresh)
          return fresh
        },
      }
    )
    expect(await b.run()).toEqual({ created: [fresh], reused: [], skipped: [], failed: [] })
  })

  it('forwards the original options to every creation and the repo override to listing', async () => {
    const options = { tool: 'omp' as const, repo: 'up/stream', skipPermissions: true }
    const b = batch({ hostId: 'h1', options })
    await b.run()
    expect(b.effects.list).toHaveBeenCalledWith('/proj', 'h1', 'up/stream')
    for (const number of [1, 2, 3]) {
      expect(b.effects.create).toHaveBeenCalledWith('/proj', number, 'h1', options)
    }
    expect(b.effects.defaultTool).not.toHaveBeenCalled()
  })

  it('passes a null repo when no override is given', async () => {
    const b = batch()
    await b.run()
    expect(b.effects.list).toHaveBeenCalledWith('/proj', null, null)
  })

  it('collects returned and thrown creation failures and continues the batch', async () => {
    const error = new Error('create failed')
    const b = batch(
      {},
      {
        create: async (_path, number) => {
          if (number === 1) return 'not found'
          if (number === 2) throw error
          return makeSession({ id: 'new-3', prNumber: 3 })
        },
      }
    )
    expect(await b.run()).toEqual({
      created: [makeSession({ id: 'new-3', prNumber: 3 })],
      reused: [],
      skipped: [],
      failed: [
        { number: 1, error: 'not found' },
        { number: 2, error: 'formatted: Error: create failed' },
      ],
    })
    expect(b.effects.describeError).toHaveBeenCalledWith(error)
  })

  it.each([true, false])(
    'serializes remote Codex and continues after errors (explicit tool: %s)',
    async (explicit) => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const started: number[] = []
      const b = batch(
        { hostId: 'h1', options: explicit ? { tool: 'codex' } : {} },
        {
          defaultTool: () => 'codex',
          create: async (_path, number) => {
            started.push(number)
            if (number === 1) {
              await gate
              throw new Error('failed')
            }
            return makeSession({ id: `new-${number}`, prNumber: number })
          },
        }
      )
      const pending = b.run()
      await vi.waitFor(() => expect(started.length).toBeGreaterThan(0))
      try {
        expect(started).toEqual([1])
      } finally {
        release()
      }
      expect(await pending).toMatchObject({
        created: [
          expect.objectContaining({ prNumber: 2 }),
          expect.objectContaining({ prNumber: 3 }),
        ],
        failed: [{ number: 1, error: 'formatted: Error: failed' }],
      })
      expect(started).toEqual([1, 2, 3])
    }
  )

  it.each([
    [null, 'codex'],
    [null, 'claude'],
    [null, 'omp'],
    ['h1', 'claude'],
    ['h1', 'omp'],
  ] as const)('starts %s/%s concurrently and preserves result order', async (hostId, tool) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started: number[] = []
    const finished: number[] = []
    const b = batch(
      { hostId, options: { tool } },
      {
        create: async (_path, number) => {
          started.push(number)
          if (number === 1) await gate
          finished.push(number)
          return makeSession({ id: `new-${number}`, prNumber: number })
        },
      }
    )
    const pending = b.run()
    await vi.waitFor(() => expect(started.length).toBeGreaterThan(0))
    try {
      expect(started).toEqual([1, 2, 3])
      expect(finished).toEqual([2, 3])
    } finally {
      release()
    }
    expect(await pending).toMatchObject({
      created: [1, 2, 3].map((prNumber) => expect.objectContaining({ prNumber })),
    })
  })

  it('reads the default tool after the open-item listing completes', async () => {
    const order: string[] = []
    const b = batch(
      {},
      {
        list: async () => {
          order.push('list')
          return [{ number: 1 }]
        },
        sessions: () => {
          order.push('snapshot')
          return []
        },
        defaultTool: () => {
          order.push('tool')
          return 'codex'
        },
        create: async () => {
          order.push('create')
          return makeSession({ id: 'new' })
        },
      }
    )
    await b.run()
    expect(order).toEqual(['list', 'snapshot', 'tool', 'create'])
  })

  it('does not translate a Session snapshot failure into a gh error', async () => {
    const b = batch(
      {},
      {
        sessions: () => {
          throw new Error('snapshot failed')
        },
      }
    )
    await expect(b.run()).rejects.toThrow('snapshot failed')
    expect(b.effects.describeError).not.toHaveBeenCalled()
  })
})

describe('selectNumbersToOpen', () => {
  it('partitions items into toCreate (new) and toSkip (already present)', () => {
    const items = [{ number: 1 }, { number: 2 }, { number: 3 }]
    const result = selectNumbersToOpen(items, new Set([2]))
    expect(result.toCreate).toEqual([{ number: 1 }, { number: 3 }])
    expect(result.toSkip).toEqual([2])
  })

  it('dedupes repeated numbers within the same list', () => {
    const result = selectNumbersToOpen([{ number: 7 }, { number: 7 }], new Set())
    expect(result.toCreate).toEqual([{ number: 7 }])
    expect(result.toSkip).toEqual([7])
  })

  it('returns empty toCreate when everything is already present', () => {
    const result = selectNumbersToOpen([{ number: 1 }, { number: 2 }], new Set([1, 2]))
    expect(result.toCreate).toEqual([])
    expect(result.toSkip).toEqual([1, 2])
  })

  it('does not mutate the caller-supplied existing set', () => {
    const existing = new Set([2])
    selectNumbersToOpen([{ number: 3 }], existing)
    expect(existing).toEqual(new Set([2]))
  })
})
