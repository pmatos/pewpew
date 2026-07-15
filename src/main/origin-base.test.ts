import { describe, expect, it } from 'vitest'
import { parseOriginHeadSymref, remoteTrackingRef, resolveOriginDefaultBase } from './origin-base'

describe('parseOriginHeadSymref', () => {
  it('extracts the default branch from ls-remote --symref output', () => {
    const stdout = 'ref: refs/heads/develop\tHEAD\nabc123\tHEAD\n'
    expect(parseOriginHeadSymref(stdout)).toBe('refs/remotes/origin/develop')
  })

  it('handles a branch name with slashes', () => {
    const stdout = 'ref: refs/heads/release/2.0\tHEAD\ndeadbeef\tHEAD\n'
    expect(parseOriginHeadSymref(stdout)).toBe('refs/remotes/origin/release/2.0')
  })

  it('returns undefined when no symref line is present', () => {
    expect(parseOriginHeadSymref('abc123\tHEAD\n')).toBeUndefined()
  })

  it('returns undefined for empty output', () => {
    expect(parseOriginHeadSymref('')).toBeUndefined()
  })
})

describe('remoteTrackingRef', () => {
  it('passes through a fully-qualified remote-tracking ref', () => {
    expect(remoteTrackingRef('refs/remotes/origin/main')).toBe('refs/remotes/origin/main')
  })

  it('qualifies a short origin/<branch> ref', () => {
    expect(remoteTrackingRef('origin/main')).toBe('refs/remotes/origin/main')
  })

  it('trims surrounding whitespace before qualifying', () => {
    expect(remoteTrackingRef('  origin/develop\n')).toBe('refs/remotes/origin/develop')
  })

  it('returns undefined for a bare local branch name', () => {
    expect(remoteTrackingRef('main')).toBeUndefined()
  })

  it('returns undefined for empty input', () => {
    expect(remoteTrackingRef('   ')).toBeUndefined()
  })
})

describe('resolveOriginDefaultBase', () => {
  function fakeGitRunner(script: Record<string, string | Error>) {
    return async (argv: string[]) => {
      const key = argv.join(' ')
      const result = script[key]
      if (result === undefined) throw new Error(`unexpected git ${key}`)
      if (result instanceof Error) throw result
      return { stdout: result }
    }
  }

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
