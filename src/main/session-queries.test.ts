import { describe, expect, it } from 'vitest'
import type { Session } from '../shared/types'
import {
  assertNoConflictingToolOnWorktree,
  assertToolCompatible,
  findSessionByBranch,
  findSessionByPrNumber,
  findSessionOnWorktree,
  occupiedWorktreePaths,
  worktreePathsForHost,
} from './session-queries'

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

describe('findSessionOnWorktree (exact, host-scoped)', () => {
  it('matches a session on the same host and worktree path', () => {
    const sessions = [
      makeSession({ id: 'a', hostId: 'h1', worktreePath: '/r/a' }),
      makeSession({ id: 'b', hostId: 'h1', worktreePath: '/r/b' }),
    ]
    expect(findSessionOnWorktree(sessions, 'h1', '/r/b')?.id).toBe('b')
  })

  it('scopes local lookups to hostId null (does not match remote sessions)', () => {
    const sessions = [makeSession({ id: 'remote', hostId: 'h1', worktreePath: '/r/x' })]
    expect(findSessionOnWorktree(sessions, null, '/r/x')).toBeUndefined()
  })

  it('does not match a session on a different host with the same path', () => {
    const sessions = [makeSession({ id: 'a', hostId: 'h2', worktreePath: '/r/x' })]
    expect(findSessionOnWorktree(sessions, 'h1', '/r/x')).toBeUndefined()
  })

  it('compares paths exactly — no canonicalization', () => {
    const sessions = [makeSession({ id: 'a', hostId: null, worktreePath: '/canonical/wt' })]
    // A symlinked spelling of the same location does NOT match under exact compare.
    expect(findSessionOnWorktree(sessions, null, '/symlink/wt')).toBeUndefined()
  })

  it('returns undefined when nothing occupies the path', () => {
    expect(findSessionOnWorktree([], 'h1', '/r/x')).toBeUndefined()
  })

  it('returns the first matching session', () => {
    const sessions = [
      makeSession({ id: 'first', hostId: 'h1', worktreePath: '/r/x' }),
      makeSession({ id: 'second', hostId: 'h1', worktreePath: '/r/x' }),
    ]
    expect(findSessionOnWorktree(sessions, 'h1', '/r/x')?.id).toBe('first')
  })
})

describe('assertToolCompatible', () => {
  it('throws the mixed-tools error when the existing session uses a different tool', () => {
    const existing = makeSession({ id: 'a', tool: 'codex' })
    expect(() => assertToolCompatible(existing, 'claude')).toThrow(
      'Worktree already has a codex session; mixed tools per worktree are not supported'
    )
  })

  it('does not throw when the tools match', () => {
    const existing = makeSession({ id: 'a', tool: 'claude' })
    expect(() => assertToolCompatible(existing, 'claude')).not.toThrow()
  })
})

describe('assertNoConflictingToolOnWorktree (scan-all tool guard)', () => {
  it('throws when a later duplicate on the path uses a different tool, even if the first matches', () => {
    // The P2 case: a same-tool first record must not mask a mismatched later
    // one. restoreSessions() keys by session.id and can hold both.
    const sessions = [
      makeSession({ id: 'first', hostId: 'h1', worktreePath: '/r/x', tool: 'claude' }),
      makeSession({ id: 'second', hostId: 'h1', worktreePath: '/r/x', tool: 'codex' }),
    ]
    expect(() => assertNoConflictingToolOnWorktree(sessions, 'h1', '/r/x', 'claude')).toThrow(
      'Worktree already has a codex session; mixed tools per worktree are not supported'
    )
  })

  it('does not throw when every match on the path shares the tool', () => {
    const sessions = [
      makeSession({ id: 'first', hostId: 'h1', worktreePath: '/r/x', tool: 'claude' }),
      makeSession({ id: 'second', hostId: 'h1', worktreePath: '/r/x', tool: 'claude' }),
    ]
    expect(() => assertNoConflictingToolOnWorktree(sessions, 'h1', '/r/x', 'claude')).not.toThrow()
  })

  it('ignores sessions on a different host or path', () => {
    const sessions = [
      makeSession({ id: 'otherHost', hostId: 'h2', worktreePath: '/r/x', tool: 'codex' }),
      makeSession({ id: 'otherPath', hostId: 'h1', worktreePath: '/r/y', tool: 'codex' }),
    ]
    expect(() => assertNoConflictingToolOnWorktree(sessions, 'h1', '/r/x', 'claude')).not.toThrow()
  })

  it('is a no-op (falls through) when nothing occupies the path', () => {
    expect(() => assertNoConflictingToolOnWorktree([], 'h1', '/r/x', 'claude')).not.toThrow()
  })
})

describe('occupiedWorktreePaths (canonical, all sessions)', () => {
  const canonicalize = (p: string) => (p === '/symlink/wt' ? '/canonical/wt' : p)

  it('collects canonicalized paths across every session, local and remote', () => {
    const sessions = [
      makeSession({ id: 'a', hostId: null, worktreePath: '/symlink/wt' }),
      makeSession({ id: 'b', hostId: 'h1', worktreePath: '/r/b' }),
    ]
    expect(occupiedWorktreePaths(sessions, canonicalize)).toEqual(
      new Set(['/canonical/wt', '/r/b'])
    )
  })

  it('returns an empty set for no sessions', () => {
    expect(occupiedWorktreePaths([], canonicalize)).toEqual(new Set())
  })
})

describe('worktreePathsForHost (raw, host-scoped)', () => {
  it('collects raw worktree paths only for sessions on the given host', () => {
    const sessions = [
      makeSession({ id: 'a', hostId: 'h1', worktreePath: '/r/a' }),
      makeSession({ id: 'b', hostId: 'h2', worktreePath: '/r/b' }),
      makeSession({ id: 'c', hostId: null, worktreePath: '/local/c' }),
    ]
    expect(worktreePathsForHost(sessions, 'h1')).toEqual(new Set(['/r/a']))
  })

  it('does not canonicalize (remote paths are opaque)', () => {
    const sessions = [makeSession({ id: 'a', hostId: 'h1', worktreePath: '/symlink/wt' })]
    expect(worktreePathsForHost(sessions, 'h1')).toEqual(new Set(['/symlink/wt']))
  })
})

describe('findSessionByBranch', () => {
  it('matches on project, host, and branch together', () => {
    const sessions = [
      makeSession({ id: 'a', projectPath: '/p', hostId: null, branch: 'feat' }),
      makeSession({ id: 'b', projectPath: '/p', hostId: null, branch: 'main' }),
    ]
    expect(findSessionByBranch(sessions, '/p', null, 'feat')?.id).toBe('a')
  })

  it('distinguishes host', () => {
    const sessions = [makeSession({ id: 'a', projectPath: '/p', hostId: 'h1', branch: 'feat' })]
    expect(findSessionByBranch(sessions, '/p', null, 'feat')).toBeUndefined()
  })

  it('distinguishes project', () => {
    const sessions = [makeSession({ id: 'a', projectPath: '/other', hostId: null, branch: 'feat' })]
    expect(findSessionByBranch(sessions, '/p', null, 'feat')).toBeUndefined()
  })
})

describe('findSessionByPrNumber', () => {
  it('matches on project, host, and PR number together', () => {
    const sessions = [
      makeSession({ id: 'a', projectPath: '/p', hostId: null, prNumber: 7 }),
      makeSession({ id: 'b', projectPath: '/p', hostId: null, prNumber: 8 }),
    ]
    expect(findSessionByPrNumber(sessions, '/p', null, 8)?.id).toBe('b')
  })

  it('distinguishes host', () => {
    const sessions = [makeSession({ id: 'a', projectPath: '/p', hostId: 'h1', prNumber: 7 })]
    expect(findSessionByPrNumber(sessions, '/p', null, 7)).toBeUndefined()
  })

  it('returns undefined when no session carries that PR number', () => {
    const sessions = [makeSession({ id: 'a', projectPath: '/p', hostId: null })]
    expect(findSessionByPrNumber(sessions, '/p', null, 7)).toBeUndefined()
  })
})
