import { describe, expect, it } from 'vitest'
import type { Session } from '../shared/types'
import { planRelocation, type RelocationTarget } from './relocation-plan'

// Seam under test: the pure `planRelocation` decision function extracted from
// `relocateProject`. It owns the "which sessions move where" policy — the local
// filter, the managed-worktree prefix rewrite, and the project name/path remap —
// leaving all I/O (git checks, path canonicalization, PTY recreation, config
// mutation, hook install) in the caller.
//
// Expected values are the documented behaviour of the original inline remap (the
// spec), written as hand-authored path literals — never recomputed with the same
// `slice`/`join` the implementation uses, which would make the tests tautological.

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    hostId: null,
    projectPath: '/home/u/proj',
    projectName: 'proj',
    worktreeName: 'w',
    worktreePath: '/home/u/proj/.claude/worktrees/feat-x',
    branch: 'main',
    pid: 0,
    tmuxSession: 'pewpew-s1',
    status: 'idle',
    lastActivity: 0,
    hookEvents: [],
    tool: 'claude',
    ...overrides,
  }
}

// The caller passes the canonicalized `<oldProjectPath>/.claude/worktrees/`
// prefix (trailing separator included) so this planner stays pure.
const target = (over: Partial<RelocationTarget> = {}): RelocationTarget => ({
  oldProjectPath: '/home/u/proj',
  newProjectPath: '/home/u/newproj',
  oldManagedRoot: '/home/u/proj/.claude/worktrees/',
  ...over,
})

describe('planRelocation — session selection', () => {
  it('remaps only local sessions whose projectPath equals oldProjectPath', () => {
    const local = makeSession({ id: 'local', projectPath: '/home/u/proj' })
    const remote = makeSession({ id: 'remote', hostId: 'host-1', projectPath: '/home/u/proj' })
    const otherProject = makeSession({
      id: 'other',
      projectPath: '/home/u/somewhere-else',
      worktreePath: '/home/u/somewhere-else/.claude/worktrees/feat-x',
    })

    const plan = planRelocation([local, remote, otherProject], target())

    expect(plan.map((r) => r.id)).toEqual(['local'])
  })

  it('does not match a project whose path is a prefix of oldProjectPath', () => {
    // `/home/u/pro` must not be swept up when relocating `/home/u/proj`.
    const sibling = makeSession({ id: 'sibling', projectPath: '/home/u/pro' })

    const plan = planRelocation([sibling], target())

    expect(plan).toEqual([])
  })

  it('returns an empty plan when nothing matches', () => {
    const remote = makeSession({ id: 'remote', hostId: 'host-1' })

    expect(planRelocation([remote], target())).toEqual([])
  })
})

describe('planRelocation — project identity remap', () => {
  it('rewrites projectPath and derives projectName from the new path basename', () => {
    const plan = planRelocation([makeSession({ id: 'local' })], target())

    expect(plan[0].projectPath).toBe('/home/u/newproj')
    expect(plan[0].projectName).toBe('newproj')
  })
})

describe('planRelocation — worktree path rewrite', () => {
  it('rewrites a managed worktree under the old .claude/worktrees root', () => {
    const s = makeSession({
      id: 'local',
      worktreePath: '/home/u/proj/.claude/worktrees/feat-x',
    })

    const plan = planRelocation([s], target())

    expect(plan[0].worktreePath).toBe('/home/u/newproj/.claude/worktrees/feat-x')
  })

  it('preserves a nested subpath rather than re-deriving it from the branch name', () => {
    // worktreeName can be a `<project>/feat-x`-style label whose directory tree
    // does not match the dirname; the exact subpath under worktrees/ must survive.
    const s = makeSession({
      id: 'local',
      worktreeName: 'proj/feat-x',
      worktreePath: '/home/u/proj/.claude/worktrees/team/feat-x',
    })

    const plan = planRelocation([s], target())

    expect(plan[0].worktreePath).toBe('/home/u/newproj/.claude/worktrees/team/feat-x')
  })

  it('keeps an external mirror worktree path verbatim', () => {
    const s = makeSession({
      id: 'local',
      worktreePath: '/mnt/mirror/proj-feat-x',
    })

    const plan = planRelocation([s], target())

    expect(plan[0].worktreePath).toBe('/mnt/mirror/proj-feat-x')
  })

  it('does not rewrite a sibling directory that shares the worktrees prefix', () => {
    // `.../worktrees-backup/x` must not be treated as living under
    // `.../worktrees/` — the trailing separator on oldManagedRoot guards this.
    const s = makeSession({
      id: 'local',
      worktreePath: '/home/u/proj/.claude/worktrees-backup/feat-x',
    })

    const plan = planRelocation([s], target())

    expect(plan[0].worktreePath).toBe('/home/u/proj/.claude/worktrees-backup/feat-x')
  })
})
