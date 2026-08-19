import { describe, expect, it } from 'vitest'
import { buildSession, type SessionRecordInput } from './session-record'

// Seam under test: the pure `buildSession` factory extracted from the five
// hand-assembled `Session` object literals in `session-manager` (local
// `adoptWorktree`, remote `adoptRemoteWorktree`, `createRemoteSession`,
// `createRemotePrSession`, `createRemoteIssueSession`). Expected values are the
// documented behaviour of those literals (the spec), not a recomputation of the
// new implementation:
//   - defaults: pid 0, status 'running', empty hookEvents, tmuxSession derived
//     as `pewpew-<id>`, lastActivity taken from the injected `now`.
//   - the load-bearing invariant: a remote session (hostId set) is born
//     `connectionState: 'live'`; a local session (hostId null) omits the key.
//   - repoFingerprint, prNumber, fork fields and issueNumber appear only when
//     the caller supplies them.

function base(overrides: Partial<SessionRecordInput> = {}): SessionRecordInput {
  return {
    id: 'abcd1234',
    hostId: null,
    projectPath: '/home/u/proj',
    projectName: 'proj',
    worktreeName: 'wt',
    worktreePath: '/home/u/proj/.claude/worktrees/wt',
    branch: 'proj/wt',
    tool: 'claude',
    sandboxed: true,
    now: 1000,
    ...overrides,
  }
}

describe('buildSession — a local session', () => {
  it('assembles the persisted defaults with the tmux name derived from the id', () => {
    const session = buildSession(base({ id: 'ff00aa11' }))
    expect(session).toEqual({
      id: 'ff00aa11',
      hostId: null,
      projectPath: '/home/u/proj',
      projectName: 'proj',
      worktreeName: 'wt',
      worktreePath: '/home/u/proj/.claude/worktrees/wt',
      branch: 'proj/wt',
      issueNumber: undefined,
      pid: 0,
      tmuxSession: 'pewpew-ff00aa11',
      status: 'running',
      lastActivity: 1000,
      hookEvents: [],
      tool: 'claude',
      sandboxed: true,
    })
  })

  it('omits connectionState — a local session is not born live', () => {
    const session = buildSession(base())
    expect('connectionState' in session).toBe(false)
  })
})

describe('buildSession — a remote session', () => {
  it("is born connectionState 'live' whenever a hostId is present", () => {
    const session = buildSession(base({ hostId: 'host-1' }))
    expect(session.hostId).toBe('host-1')
    expect(session.connectionState).toBe('live')
  })
})

describe('buildSession — repoFingerprint', () => {
  it('carries a known fingerprint through', () => {
    const session = buildSession(base({ repoFingerprint: 'deadbeef' }))
    expect(session.repoFingerprint).toBe('deadbeef')
  })

  it('omits the key when the fingerprint is unknown', () => {
    const session = buildSession(base({ repoFingerprint: undefined }))
    expect('repoFingerprint' in session).toBe(false)
  })
})

describe('buildSession — PR fields', () => {
  it('records a fork PR with its number and fork provenance', () => {
    const session = buildSession(base({ prNumber: 42, prIsFork: true, prHeadRepo: 'octo/fork' }))
    expect(session.prNumber).toBe(42)
    expect(session.prIsFork).toBe(true)
    expect(session.prHeadRepo).toBe('octo/fork')
  })

  it('records a same-repo PR number without the fork keys', () => {
    const session = buildSession(base({ prNumber: 7 }))
    expect(session.prNumber).toBe(7)
    expect('prIsFork' in session).toBe(false)
    expect('prHeadRepo' in session).toBe(false)
  })

  it('omits prNumber entirely for a non-PR session', () => {
    const session = buildSession(base())
    expect('prNumber' in session).toBe(false)
  })
})

describe('buildSession — issueNumber', () => {
  it('carries a resolved issue number through', () => {
    const session = buildSession(base({ issueNumber: 15 }))
    expect(session.issueNumber).toBe(15)
  })
})

describe('buildSession — full record', () => {
  it('assembles the richest literal: a remote fork-PR session', () => {
    const session = buildSession(
      base({
        id: 'c0ffee00',
        hostId: 'host-9',
        projectName: 'remoteproj',
        worktreePath: '/remote/wt',
        branch: 'pr-branch',
        tool: 'codex',
        sandboxed: false,
        issueNumber: 5,
        prNumber: 99,
        prIsFork: true,
        prHeadRepo: 'octo/fork',
        repoFingerprint: 'fp-123',
      })
    )
    expect(session).toEqual({
      id: 'c0ffee00',
      hostId: 'host-9',
      projectPath: '/home/u/proj',
      projectName: 'remoteproj',
      worktreeName: 'wt',
      worktreePath: '/remote/wt',
      branch: 'pr-branch',
      prNumber: 99,
      prIsFork: true,
      prHeadRepo: 'octo/fork',
      issueNumber: 5,
      pid: 0,
      tmuxSession: 'pewpew-c0ffee00',
      status: 'running',
      connectionState: 'live',
      lastActivity: 1000,
      hookEvents: [],
      tool: 'codex',
      sandboxed: false,
      repoFingerprint: 'fp-123',
    })
  })
})
