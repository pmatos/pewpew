import { describe, expect, it } from 'vitest'
import type { Session } from '../shared/types'
import {
  numbersInUse,
  selectNumbersToOpen,
  shouldCreateSerially,
  summarizeCreations,
  type CreateOutcome,
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

describe('numbersInUse', () => {
  it('collects the requested field only for sessions matching project and host', () => {
    const sessions = [
      makeSession({ id: 'a', projectPath: '/proj', hostId: null, prNumber: 10 }),
      makeSession({ id: 'b', projectPath: '/proj', hostId: null, prNumber: 11 }),
      makeSession({ id: 'c', projectPath: '/other', hostId: null, prNumber: 12 }),
      makeSession({ id: 'd', projectPath: '/proj', hostId: 'h1', prNumber: 13 }),
    ]
    expect(numbersInUse(sessions, '/proj', null, 'prNumber')).toEqual(new Set([10, 11]))
  })

  it('scopes matching to the given remote host', () => {
    const sessions = [
      makeSession({ id: 'a', projectPath: '/proj', hostId: 'h1', prNumber: 20 }),
      makeSession({ id: 'b', projectPath: '/proj', hostId: null, prNumber: 21 }),
    ]
    expect(numbersInUse(sessions, '/proj', 'h1', 'prNumber')).toEqual(new Set([20]))
  })

  it('ignores sessions that lack the requested field', () => {
    const sessions = [
      makeSession({ id: 'a', projectPath: '/proj', issueNumber: 30 }),
      makeSession({ id: 'b', projectPath: '/proj' }),
    ]
    expect(numbersInUse(sessions, '/proj', null, 'issueNumber')).toEqual(new Set([30]))
  })

  it('returns an empty set when nothing matches', () => {
    expect(numbersInUse([], '/proj', null, 'prNumber')).toEqual(new Set())
  })
})

describe('shouldCreateSerially', () => {
  it('serializes only remote Codex creation', () => {
    expect(shouldCreateSerially('h1', 'codex')).toBe(true)
  })

  it('parallelizes remote Claude creation', () => {
    expect(shouldCreateSerially('h1', 'claude')).toBe(false)
  })

  it('parallelizes local Codex creation', () => {
    expect(shouldCreateSerially(null, 'codex')).toBe(false)
  })

  it('parallelizes local Claude creation', () => {
    expect(shouldCreateSerially(null, 'claude')).toBe(false)
  })
})

describe('summarizeCreations', () => {
  it('splits outcomes into created, reused, skipped, and failed', () => {
    const fresh = makeSession({ id: 'new-1', prNumber: 1 })
    const preexisting = makeSession({ id: 'old-2', prNumber: 2 })
    const outcomes: CreateOutcome[] = [
      { session: fresh },
      { session: preexisting },
      { number: 3, error: 'boom' },
    ]
    const summary = summarizeCreations(outcomes, new Set(['old-2']), [9])
    expect(summary.created).toEqual([fresh])
    expect(summary.reused).toEqual([preexisting])
    expect(summary.skipped).toEqual([9])
    expect(summary.failed).toEqual([{ number: 3, error: 'boom' }])
  })

  it('classifies a session whose id existed before the batch as reused', () => {
    const reusedSession = makeSession({ id: 's-issue504', issueNumber: 504, prNumber: 545 })
    const summary = summarizeCreations([{ session: reusedSession }], new Set(['s-issue504']), [])
    expect(summary.created).toEqual([])
    expect(summary.reused).toEqual([reusedSession])
  })

  it('classifies a brand-new session id as created', () => {
    const created = makeSession({ id: 'brand-new', prNumber: 7 })
    const summary = summarizeCreations([{ session: created }], new Set(['old']), [])
    expect(summary.created).toEqual([created])
    expect(summary.reused).toEqual([])
  })

  it('produces empty buckets for an empty batch', () => {
    expect(summarizeCreations([], new Set(), [])).toEqual({
      created: [],
      reused: [],
      skipped: [],
      failed: [],
    })
  })
})
