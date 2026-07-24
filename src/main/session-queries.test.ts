import { describe, expect, it } from 'vitest'
import type { Session } from '../shared/types'
import {
  assertToolCompatible,
  findSessionByBranch,
  findSessionByPrNumber,
  findSessionOnCanonicalWorktree,
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

describe('findSessionOnCanonicalWorktree (canonical, un-scoped)', () => {
  const canonicalize = (p: string) => (p === '/symlink/wt' ? '/canonical/wt' : p)

  it('matches when both paths canonicalize to the same location', () => {
    const sessions = [makeSession({ id: 'a', hostId: null, worktreePath: '/canonical/wt' })]
    expect(findSessionOnCanonicalWorktree(sessions, '/symlink/wt', canonicalize)?.id).toBe('a')
  })

  it('matches irrespective of hostId (no host scoping)', () => {
    const sessions = [makeSession({ id: 'remote', hostId: 'h1', worktreePath: '/canonical/wt' })]
    expect(findSessionOnCanonicalWorktree(sessions, '/symlink/wt', canonicalize)?.id).toBe('remote')
  })

  it('returns undefined when no canonical path matches', () => {
    const sessions = [makeSession({ id: 'a', worktreePath: '/other' })]
    expect(findSessionOnCanonicalWorktree(sessions, '/symlink/wt', canonicalize)).toBeUndefined()
  })

  it('canonicalizes the stored session path too', () => {
    const sessions = [makeSession({ id: 'a', hostId: null, worktreePath: '/symlink/wt' })]
    expect(findSessionOnCanonicalWorktree(sessions, '/canonical/wt', canonicalize)?.id).toBe('a')
  })
})

describe('canonical-vs-exact inconsistency is preserved', () => {
  // The local worktree-adopt path canonicalizes both sides; the local
  // issue/PR-lookup path compares raw strings. This pins that difference so a
  // future unification is a deliberate, separately-reviewed change.
  const canonicalize = (p: string) => (p === '/symlink/wt' ? '/canonical/wt' : p)
  const sessions = [makeSession({ id: 'a', hostId: null, worktreePath: '/canonical/wt' })]

  it('canonical lookup matches the symlinked spelling', () => {
    expect(findSessionOnCanonicalWorktree(sessions, '/symlink/wt', canonicalize)?.id).toBe('a')
  })

  it('exact lookup misses the symlinked spelling', () => {
    expect(findSessionOnWorktree(sessions, null, '/symlink/wt')).toBeUndefined()
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
