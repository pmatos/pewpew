import { describe, it, expect } from 'vitest'
import { buildSandboxArgs } from './agent-sandbox'

const PROJECT = '/home/dev/project'
const WORKTREE = '/home/dev/project/.claude/worktrees/wt1'

describe('buildSandboxArgs', () => {
  it('produces the exact bind order, including the trailing -- separator', () => {
    // Order is load-bearing — later binds override earlier ones. Asserting
    // the literal array (not just membership) catches a refactor that
    // reorders or dedupes these entries and silently removes the boundary.
    expect(buildSandboxArgs(PROJECT, WORKTREE)).toEqual([
      'bwrap',
      '--dev-bind',
      '/',
      '/',
      '--ro-bind',
      PROJECT,
      PROJECT,
      '--bind',
      `${PROJECT}/.git`,
      `${PROJECT}/.git`,
      '--ro-bind-try',
      `${PROJECT}/.git/hooks`,
      `${PROJECT}/.git/hooks`,
      '--bind',
      WORKTREE,
      WORKTREE,
      '--chdir',
      WORKTREE,
      '--',
    ])
  })

  it('does not ro-bind .git/config (would break `git config --local`)', () => {
    const args = buildSandboxArgs(PROJECT, WORKTREE)
    expect(args).not.toContain(`${PROJECT}/.git/config`)
  })

  it('defaults to enabled when opts is omitted', () => {
    expect(buildSandboxArgs(PROJECT, WORKTREE).length).toBeGreaterThan(0)
  })

  it('returns no args when explicitly disabled', () => {
    expect(buildSandboxArgs(PROJECT, WORKTREE, { enabled: false })).toEqual([])
  })

  it('returns no args when the worktree is the project root itself', () => {
    expect(buildSandboxArgs(PROJECT, PROJECT)).toEqual([])
  })

  it('returns no args when the worktree equals the project root even if disabled is explicit false-then-true', () => {
    // enabled:true + same path still short-circuits on the degenerate case.
    expect(buildSandboxArgs(PROJECT, PROJECT, { enabled: true })).toEqual([])
  })

  it('appends extra writable paths as --bind pairs before the final --chdir/--', () => {
    const args = buildSandboxArgs(PROJECT, WORKTREE, { extraWritablePaths: ['/tmp', '/var/tmp'] })
    const chdirIdx = args.indexOf('--chdir')
    const tmpIdx = args.indexOf('--bind', args.indexOf(`${PROJECT}/.git/hooks`))
    expect(args.slice(tmpIdx, tmpIdx + 3)).toEqual(['--bind', '/tmp', '/tmp'])
    expect(args.slice(tmpIdx + 3, tmpIdx + 6)).toEqual(['--bind', '/var/tmp', '/var/tmp'])
    expect(tmpIdx).toBeLessThan(chdirIdx)
    expect(args.slice(chdirIdx)).toEqual(['--chdir', WORKTREE, '--'])
  })

  it('appends no extra --bind pairs when extraWritablePaths is empty', () => {
    const withEmpty = buildSandboxArgs(PROJECT, WORKTREE, { extraWritablePaths: [] })
    const withOmitted = buildSandboxArgs(PROJECT, WORKTREE)
    expect(withEmpty).toEqual(withOmitted)
  })

  it('drops extraWritablePaths entries that overlap the project root', () => {
    const args = buildSandboxArgs(PROJECT, WORKTREE, {
      extraWritablePaths: [PROJECT, `${PROJECT}/.git/hooks`, `${PROJECT}-other`, '/tmp'],
    })
    const occurrences = (value: string) => args.filter((a) => a === value).length
    // The project root and its .git/hooks carve-out already appear twice
    // each (as the ro-bind source/target from steps 2 and 4) — a dropped
    // overlap must not add a third occurrence via an extra --bind pair.
    expect(occurrences(PROJECT)).toBe(2)
    expect(occurrences(`${PROJECT}/.git/hooks`)).toBe(2)
    // A path that merely shares a string prefix (not a path separator) with
    // the project root, and a genuinely unrelated path, are not overlaps.
    expect(args).toContain(`${PROJECT}-other`)
    expect(args).toContain('/tmp')
  })

  it('drops extraWritablePaths entries that are an ANCESTOR of the project root', () => {
    // A caller-supplied ancestor (e.g. "/home/dev", or the extreme case "/")
    // would re-mount projectPath itself read-write via the later --bind,
    // since bwrap binds are order-dependent — not just a subtree within it.
    const args = buildSandboxArgs(PROJECT, WORKTREE, {
      extraWritablePaths: ['/home/dev', '/', '/tmp'],
    })
    expect(args).not.toContain('/home/dev')
    // '/' is also the --dev-bind target from step 1, so assert on the
    // occurrence count rather than presence.
    expect(args.filter((a) => a === '/').length).toBe(2)
    expect(args).toContain('/tmp')
  })
})
