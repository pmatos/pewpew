import { describe, expect, it } from 'vitest'
import {
  parseOriginHeadSymref,
  remoteTrackingRef,
  resolveOriginDefaultBase,
  serializeFetch,
} from './origin-base'

// A GitRunner whose behaviour is fully scripted by argv. Any command not in the
// script throws, which surfaces unexpected calls as test failures.
function fakeGitRunner(script: Record<string, string | Error>) {
  return async (argv: string[]) => {
    const key = argv.join(' ')
    const result = script[key]
    if (result === undefined) throw new Error(`unexpected git ${key}`)
    if (result instanceof Error) throw result
    return { stdout: result }
  }
}

describe('remoteTrackingRef', () => {
  it('returns undefined for blank input', () => {
    expect(remoteTrackingRef('')).toBeUndefined()
    expect(remoteTrackingRef('   \n')).toBeUndefined()
  })

  it('passes through a fully-qualified remote-tracking ref, trimmed', () => {
    expect(remoteTrackingRef('  refs/remotes/origin/main\n')).toBe('refs/remotes/origin/main')
  })

  it('qualifies a short origin/<branch> ref into a remote-tracking ref', () => {
    expect(remoteTrackingRef('origin/develop')).toBe('refs/remotes/origin/develop')
  })

  it('rejects refs that are neither remote-tracking nor origin-prefixed', () => {
    expect(remoteTrackingRef('refs/heads/main')).toBeUndefined()
    expect(remoteTrackingRef('main')).toBeUndefined()
  })
})

describe('parseOriginHeadSymref', () => {
  it('extracts the default branch from ls-remote --symref output', () => {
    const stdout = 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n'
    expect(parseOriginHeadSymref(stdout)).toBe('refs/remotes/origin/main')
  })

  it('handles a branch name that is not main', () => {
    const stdout = 'ref: refs/heads/develop\tHEAD\ndef456\tHEAD\n'
    expect(parseOriginHeadSymref(stdout)).toBe('refs/remotes/origin/develop')
  })

  it('returns undefined when no symref line is present', () => {
    expect(parseOriginHeadSymref('abc123\tHEAD\n')).toBeUndefined()
    expect(parseOriginHeadSymref('')).toBeUndefined()
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

describe('resolveOriginDefaultBase fetch coalescing', () => {
  function countingRunner(counter: { fetches: number }) {
    return async (argv: string[]) => {
      const key = argv.join(' ')
      if (key === 'fetch origin --quiet') {
        counter.fetches++
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { stdout: '' }
      }
      if (key === 'remote get-url origin') return { stdout: 'git@example.com:o/r.git\n' }
      if (key === 'ls-remote --symref origin HEAD') {
        return { stdout: 'ref: refs/heads/main\tHEAD\n' }
      }
      if (key === 'rev-parse --verify refs/remotes/origin/main') return { stdout: 'abc\n' }
      throw new Error(`unexpected git ${key}`)
    }
  }

  it('shares one fetch between concurrent callers with the same key', async () => {
    const counter = { fetches: 0 }
    const results = await Promise.all(
      [1, 2, 3].map(() => resolveOriginDefaultBase(countingRunner(counter), 'repo-a'))
    )
    expect(results).toEqual(Array(3).fill('refs/remotes/origin/main'))
    expect(counter.fetches).toBe(1)
  })

  it('fetches separately for different keys and for sequential calls', async () => {
    const counter = { fetches: 0 }
    await Promise.all([
      resolveOriginDefaultBase(countingRunner(counter), 'repo-a'),
      resolveOriginDefaultBase(countingRunner(counter), 'repo-b'),
    ])
    await resolveOriginDefaultBase(countingRunner(counter), 'repo-a')
    expect(counter.fetches).toBe(3)
  })

  it('propagates a shared fetch failure to every caller and clears the in-flight entry', async () => {
    const failing = async (argv: string[]) => {
      if (argv[0] === 'remote') return { stdout: 'url\n' }
      throw new Error('cannot lock ref')
    }
    const settled = await Promise.allSettled([
      resolveOriginDefaultBase(failing, 'repo-c'),
      resolveOriginDefaultBase(failing, 'repo-c'),
    ])
    for (const r of settled) {
      expect(r.status).toBe('rejected')
    }
    const counter = { fetches: 0 }
    await resolveOriginDefaultBase(countingRunner(counter), 'repo-c')
    expect(counter.fetches).toBe(1)
  })
})

describe('serializeFetch', () => {
  it('runs tasks with the same key one at a time, in order, even after a failure', async () => {
    const order: string[] = []
    const task =
      (name: string, fail = false) =>
      async () => {
        order.push(`start ${name}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push(`end ${name}`)
        if (fail) throw new Error(name)
      }

    const results = await Promise.allSettled([
      serializeFetch('k', task('a', true)),
      serializeFetch('k', task('b')),
    ])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled'])
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b'])
  })

  it('does not serialize different keys or unkeyed tasks', async () => {
    let active = 0
    let maxActive = 0
    const task = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
    }
    await Promise.all([
      serializeFetch('x', task),
      serializeFetch('y', task),
      serializeFetch(undefined, task),
    ])
    expect(maxActive).toBe(3)
  })
})
