import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, chmodSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, posix } from 'path'
import { detectSetupState, discoverRepos, parseWorktreeList } from './project-scanner'

describe('parseWorktreeList', () => {
  it('returns empty array for empty input', () => {
    expect(parseWorktreeList('')).toEqual([])
  })

  it('flags the first worktree as main and others as not main', () => {
    const stdout = [
      'worktree /home/user/repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /home/user/repo/.claude/worktrees/feat-a',
      'HEAD def456',
      'branch refs/heads/pewpew/feat-a',
      '',
      'worktree /tmp/external-wt',
      'HEAD 789abc',
      'branch refs/heads/external/feature',
      '',
    ].join('\n')

    const result = parseWorktreeList(stdout)

    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({
      name: 'repo',
      path: '/home/user/repo',
      branch: 'main',
      isMain: true,
    })
    expect(result[1]).toEqual({
      name: 'feat-a',
      path: '/home/user/repo/.claude/worktrees/feat-a',
      branch: 'pewpew/feat-a',
      isMain: false,
    })
    expect(result[2]).toEqual({
      name: 'external-wt',
      path: '/tmp/external-wt',
      branch: 'external/feature',
      isMain: false,
    })
  })

  it('falls back to HEAD when no branch line is present (detached HEAD)', () => {
    const stdout = ['worktree /home/user/repo', 'HEAD abc123', 'detached', ''].join('\n')

    const result = parseWorktreeList(stdout)
    expect(result).toHaveLength(1)
    expect(result[0].branch).toBe('HEAD')
    expect(result[0].isMain).toBe(true)
  })

  it('handles a single-worktree repository', () => {
    const stdout = ['worktree /home/user/solo', 'HEAD abc123', 'branch refs/heads/main', ''].join(
      '\n'
    )

    const result = parseWorktreeList(stdout)
    expect(result).toHaveLength(1)
    expect(result[0].isMain).toBe(true)
  })

  it('derives worktree names with a supplied basename function (remote POSIX paths)', () => {
    const stdout = [
      'worktree /srv/repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /srv/repo/.claude/worktrees/feat-x',
      'HEAD def456',
      'branch refs/heads/pewpew/feat-x',
      '',
    ].join('\n')

    // Supply a distinguishing basename to prove the injected function is used
    // (this is how remote callers pass posix.basename for SSH-listed paths).
    const lastSegmentUpper = (p: string): string => posix.basename(p).toUpperCase()
    const result = parseWorktreeList(stdout, lastSegmentUpper)

    expect(result.map((w) => w.name)).toEqual(['REPO', 'FEAT-X'])
  })
})

describe('discoverRepos', () => {
  let root: string

  function makeRepo(path: string): void {
    mkdirSync(join(path, '.git'), { recursive: true })
  }

  function makeDir(path: string): void {
    mkdirSync(path, { recursive: true })
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'discoverRepos-'))
  })

  afterEach(() => {
    try {
      chmodSync(root, 0o755)
    } catch {
      // ignore
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('depth=1 matches current behavior (direct children only)', () => {
    makeRepo(join(root, 'alpha'))
    makeRepo(join(root, 'beta', 'sub'))
    makeDir(join(root, 'gamma'))

    const result = discoverRepos([root], [], true, 1)

    expect(result.map((r) => r.name)).toEqual(['alpha'])
  })

  it('depth=1 still includes a dotdir child with .git (regression guard)', () => {
    makeRepo(join(root, '.config-repo'))

    const result = discoverRepos([root], [], true, 1)

    expect(result.map((r) => r.name)).toEqual(['.config-repo'])
  })

  it('depth=2 discovers nested repos', () => {
    makeRepo(join(root, 'alpha'))
    makeRepo(join(root, 'beta', 'sub'))

    const result = discoverRepos([root], [], true, 2)

    expect(result.map((r) => r.name).sort()).toEqual(['alpha', 'sub'])
  })

  it('stops descending once a .git is found', () => {
    makeRepo(join(root, 'alpha'))
    makeRepo(join(root, 'alpha', '.claude', 'worktrees', 'wt'))

    const result = discoverRepos([root], [], true, 5)

    expect(result.map((r) => r.name)).toEqual(['alpha'])
  })

  it('skips node_modules during recursion', () => {
    makeRepo(join(root, 'pkg'))
    makeRepo(join(root, 'pkg-consumer', 'node_modules', 'nested'))

    const result = discoverRepos([root], [], true, 5)

    expect(result.map((r) => r.name)).toEqual(['pkg'])
  })

  it('skips dotdirs during recursion (past depth 1)', () => {
    makeRepo(join(root, 'container', '.hidden', 'repo'))

    const result = discoverRepos([root], [], true, 5)

    expect(result).toEqual([])
  })

  it('dedupes across scanDirs via symlink', () => {
    makeRepo(join(root, 'real', 'alpha'))
    symlinkSync(join(root, 'real'), join(root, 'mirror'))

    const result = discoverRepos([join(root, 'real'), join(root, 'mirror')], [], true, 2)

    expect(result.map((r) => r.name)).toEqual(['alpha'])
  })

  it('terminates on symlink cycles', () => {
    makeDir(join(root, 'a'))
    symlinkSync(root, join(root, 'a', 'loop'))
    makeRepo(join(root, 'a', 'real-repo'))

    const result = discoverRepos([root], [], true, 6)

    expect(result.map((r) => r.name)).toEqual(['real-repo'])
  })

  it('skips broken symlinks silently', () => {
    symlinkSync(join(root, 'does-not-exist'), join(root, 'dangling'))
    makeRepo(join(root, 'alpha'))

    const result = discoverRepos([root], [], true, 3)

    expect(result.map((r) => r.name)).toEqual(['alpha'])
  })

  it('includes and dedupes pinned paths', () => {
    makeRepo(join(root, 'alpha'))
    const pinned = join(root, 'pinned', 'repo')
    makeRepo(pinned)

    const result = discoverRepos([root], [pinned], true, 1)

    // root yields alpha (pinned not reached at depth 1); pinned adds 'repo'.
    expect(result.map((r) => r.name).sort()).toEqual(['alpha', 'repo'])
  })

  it('dedupes pinned path against scanDir discovery', () => {
    const repoPath = join(root, 'alpha')
    makeRepo(repoPath)

    const result = discoverRepos([root], [repoPath], true, 1)

    expect(result).toHaveLength(1)
    expect(result[0].path).toBe(repoPath)
  })

  it('silently skips non-existent scanDir', () => {
    makeRepo(join(root, 'alpha'))

    const result = discoverRepos([join(root, 'missing'), root], [], true, 1)

    expect(result.map((r) => r.name)).toEqual(['alpha'])
  })

  it('does not abort the walk when a subdir is unreadable', () => {
    makeRepo(join(root, 'alpha'))
    const locked = join(root, 'locked')
    makeDir(locked)
    makeRepo(join(root, 'beta'))
    chmodSync(locked, 0o000)
    try {
      const result = discoverRepos([root], [], true, 3)
      expect(result.map((r) => r.name).sort()).toEqual(['alpha', 'beta'])
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it('clamps maxDepth=0 up to 1', () => {
    makeRepo(join(root, 'alpha'))
    makeRepo(join(root, 'beta', 'sub'))

    const result = discoverRepos([root], [], true, 0)

    expect(result.map((r) => r.name)).toEqual(['alpha'])
  })

  it('clamps large maxDepth down to 6', () => {
    // Build a chain 7 levels deep: root/a/b/c/d/e/f/repo/.git
    makeRepo(join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'repo'))

    const result = discoverRepos([root], [], true, 99)

    // Depth 6 means the walk visits depth 1..6; 'repo' at level 7 is out of reach.
    expect(result).toEqual([])
  })
})

describe('detectSetupState', () => {
  let repo: string

  function writeSettings(command: string): void {
    mkdirSync(join(repo, '.claude'), { recursive: true })
    writeFileSync(
      join(repo, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] },
      })
    )
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'detectSetupState-'))
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns unsetup when settings file is missing', () => {
    expect(detectSetupState(repo)).toBe('unsetup')
  })

  it('returns ready for a current-path hook command', () => {
    writeSettings('/home/user/.config/pewpew/hooks/notify.sh')
    expect(detectSetupState(repo)).toBe('ready')
  })

  it('returns ready for a tilde-expanded hook command', () => {
    writeSettings('~/.config/pewpew/hooks/notify.sh')
    expect(detectSetupState(repo)).toBe('ready')
  })

  it('returns unsetup for legacy cc-pewpew XDG path', () => {
    writeSettings('/home/user/.config/cc-pewpew/hooks/notify.sh')
    expect(detectSetupState(repo)).toBe('unsetup')
  })

  it('returns unsetup for legacy ~/.cc-pewpew/ path', () => {
    writeSettings('~/.cc-pewpew/hooks/notify.sh')
    expect(detectSetupState(repo)).toBe('unsetup')
  })
})
