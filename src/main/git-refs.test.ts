import { describe, expect, it } from 'vitest'
import {
  sanitizeBranchPrefix,
  parseIssueNumber,
  resolveOriginDefaultBase,
  localBranchExists,
  type GitRunner,
} from './git-refs'

// A fake GitRunner scripted by exact argv join. Lets every test drive the
// git-ref resolution logic through the module's only seam without touching a
// real repository or the wider session-manager mock harness.
function fakeGitRunner(script: Record<string, string | Error>): GitRunner {
  return async (argv: string[]) => {
    const key = argv.join(' ')
    const result = script[key]
    if (result === undefined) throw new Error(`unexpected git ${key}`)
    if (result instanceof Error) throw result
    return { stdout: result }
  }
}

describe('sanitizeBranchPrefix', () => {
  it('preserves valid ref-component characters', () => {
    expect(sanitizeBranchPrefix('pewpew')).toBe('pewpew')
    expect(sanitizeBranchPrefix('my_repo.v2')).toBe('my_repo.v2')
  })

  it('replaces git-illegal characters with `-`', () => {
    expect(sanitizeBranchPrefix('My Repo')).toBe('My-Repo')
    expect(sanitizeBranchPrefix('repo:with~bad^chars?*[\\]')).toBe('repo-with-bad-chars')
  })

  it('strips consecutive dots rejected by git ref names', () => {
    expect(sanitizeBranchPrefix('my..repo')).toBe('my-repo')
    expect(sanitizeBranchPrefix('repo...v2')).toBe('repo-v2')
  })

  it('strips leading and trailing punctuation', () => {
    expect(sanitizeBranchPrefix('-leading')).toBe('leading')
    expect(sanitizeBranchPrefix('.dot.')).toBe('dot')
  })

  it('strips trailing `.lock` suffixes (illegal as ref-component suffixes)', () => {
    expect(sanitizeBranchPrefix('proj.lock')).toBe('proj')
    expect(sanitizeBranchPrefix('proj.lock.lock')).toBe('proj')
    expect(sanitizeBranchPrefix('proj-.lock')).toBe('proj')
  })

  it('falls back to `pewpew` when nothing valid remains', () => {
    expect(sanitizeBranchPrefix('   ')).toBe('pewpew')
    expect(sanitizeBranchPrefix(':::')).toBe('pewpew')
    expect(sanitizeBranchPrefix('')).toBe('pewpew')
  })
})

describe('parseIssueNumber', () => {
  it('parses every conventional separator', () => {
    expect(parseIssueNumber('issue37')).toBe(37)
    expect(parseIssueNumber('issue-37')).toBe(37)
    expect(parseIssueNumber('issue_37')).toBe(37)
    expect(parseIssueNumber('issue/37')).toBe(37)
    expect(parseIssueNumber('issue#37')).toBe(37)
    expect(parseIssueNumber('issue 37')).toBe(37)
  })

  it('matches case-insensitively and anywhere in the string', () => {
    expect(parseIssueNumber('feature/ISSUE-9-fix')).toBe(9)
    expect(parseIssueNumber('Fixing Issue42 today')).toBe(42)
  })

  it('returns the first match within a single source', () => {
    expect(parseIssueNumber('issue-3-then-issue-5')).toBe(3)
  })

  it('scans sources in order and returns the first that carries a number', () => {
    expect(parseIssueNumber(undefined, 'no-number-here', 'issue-11')).toBe(11)
  })

  it('returns undefined when no source names an issue', () => {
    expect(parseIssueNumber('feature/login', undefined, 'redesign')).toBeUndefined()
    expect(parseIssueNumber()).toBeUndefined()
  })
})

describe('resolveOriginDefaultBase', () => {
  it('returns origin/HEAD when symbolic-ref resolves and validates', async () => {
    await expect(
      resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': '',
          'ls-remote --symref origin HEAD': new Error('unavailable'),
          'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n',
          'rev-parse --verify refs/remotes/origin/main': 'abc123\n',
        })
      )
    ).resolves.toBe('refs/remotes/origin/main')
  })

  it('prefers ls-remote default branch over stale local origin/HEAD', async () => {
    await expect(
      resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': '',
          'ls-remote --symref origin HEAD': 'ref: refs/heads/develop\tHEAD\nabc123\tHEAD\n',
          'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n',
          'rev-parse --verify refs/remotes/origin/develop': 'abc123\n',
          'rev-parse --verify refs/remotes/origin/main': 'def456\n',
        })
      )
    ).resolves.toBe('refs/remotes/origin/develop')
  })

  it('validates fully qualified remote-tracking refs to avoid local branch ambiguity', async () => {
    await expect(
      resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': '',
          'ls-remote --symref origin HEAD': 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
          'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n',
          'rev-parse --verify refs/remotes/origin/main': 'abc123\n',
        })
      )
    ).resolves.toBe('refs/remotes/origin/main')
  })

  it('throws no-origin-remote when origin is missing', async () => {
    await expect(
      resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': new Error('No such remote'),
        })
      )
    ).rejects.toThrow(/^no-origin-remote$/)
  })

  it('adds context when fetch fails', async () => {
    await expect(
      resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': new Error('network down'),
        })
      )
    ).rejects.toThrow(/Failed to fetch origin: network down/)
  })

  it('falls back to origin/main when origin/HEAD is unset', async () => {
    await expect(
      resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': '',
          'ls-remote --symref origin HEAD': new Error('unset'),
          'symbolic-ref --short refs/remotes/origin/HEAD': new Error('unset'),
          'rev-parse --verify refs/remotes/origin/main': 'abc123\n',
        })
      )
    ).resolves.toBe('refs/remotes/origin/main')
  })

  it('uses ls-remote default branch when origin/HEAD is unset', async () => {
    await expect(
      resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': '',
          'ls-remote --symref origin HEAD': 'ref: refs/heads/develop\tHEAD\nabc123\tHEAD\n',
          'symbolic-ref --short refs/remotes/origin/HEAD': new Error('unset'),
          'rev-parse --verify refs/remotes/origin/develop': 'abc123\n',
        })
      )
    ).resolves.toBe('refs/remotes/origin/develop')
  })

  it('falls back to origin/master when origin/main is absent', async () => {
    await expect(
      resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': '',
          'ls-remote --symref origin HEAD': new Error('unset'),
          'symbolic-ref --short refs/remotes/origin/HEAD': new Error('unset'),
          'rev-parse --verify refs/remotes/origin/main': new Error('missing'),
          'rev-parse --verify refs/remotes/origin/master': 'abc123\n',
        })
      )
    ).resolves.toBe('refs/remotes/origin/master')
  })

  it('throws no-origin-default-branch when no candidate resolves', async () => {
    await expect(
      resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': '',
          'ls-remote --symref origin HEAD': new Error('unset'),
          'symbolic-ref --short refs/remotes/origin/HEAD': new Error('unset'),
          'rev-parse --verify refs/remotes/origin/main': new Error('missing'),
          'rev-parse --verify refs/remotes/origin/master': new Error('missing'),
        })
      )
    ).rejects.toThrow(/^no-origin-default-branch$/)
  })

  it('falls through when origin/HEAD points at a stale ref', async () => {
    await expect(
      resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': '',
          'ls-remote --symref origin HEAD': new Error('unset'),
          'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n',
          'rev-parse --verify refs/remotes/origin/main': new Error('stale'),
          'rev-parse --verify refs/remotes/origin/master': 'abc123\n',
        })
      )
    ).resolves.toBe('refs/remotes/origin/master')
  })
})

describe('localBranchExists', () => {
  it('reports true when git verifies the local ref', async () => {
    await expect(
      localBranchExists(
        fakeGitRunner({ 'rev-parse --verify --quiet refs/heads/feature': 'abc123\n' }),
        'feature'
      )
    ).resolves.toBe(true)
  })

  it('reports false when git cannot verify the local ref', async () => {
    await expect(localBranchExists(fakeGitRunner({}), 'ghost')).resolves.toBe(false)
  })

  it('verifies the fully qualified refs/heads ref, not an ambiguous name', async () => {
    const seen: string[][] = []
    const runner: GitRunner = async (argv) => {
      seen.push(argv)
      return { stdout: '' }
    }
    await localBranchExists(runner, 'topic')
    expect(seen).toEqual([['rev-parse', '--verify', '--quiet', 'refs/heads/topic']])
  })
})
