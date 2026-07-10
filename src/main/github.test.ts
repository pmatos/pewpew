import { describe, expect, it, vi } from 'vitest'
import {
  createPrLookup,
  describePrLookupFailure,
  forkFieldsFromPr,
  parseOwnerFromRemoteUrl,
  type GhRunner,
} from './github'

describe('parseOwnerFromRemoteUrl', () => {
  it('extracts the owner from an scp-style ssh remote', () => {
    expect(parseOwnerFromRemoteUrl('git@github.com:acme/widgets.git')).toBe('acme')
  })

  it('extracts the owner from an https remote with a .git suffix', () => {
    expect(parseOwnerFromRemoteUrl('https://github.com/acme/widgets.git')).toBe('acme')
  })

  it('extracts the owner when there is no .git suffix', () => {
    expect(parseOwnerFromRemoteUrl('https://github.com/acme/widgets')).toBe('acme')
  })

  it('tolerates a trailing slash', () => {
    expect(parseOwnerFromRemoteUrl('https://github.com/acme/widgets/')).toBe('acme')
  })

  it('returns undefined for a string that is not a remote url', () => {
    expect(parseOwnerFromRemoteUrl('not-a-remote')).toBeUndefined()
  })
})

describe('forkFieldsFromPr', () => {
  it('returns empty fields for a same-repo PR', () => {
    expect(forkFieldsFromPr({ headRefName: 'fix', state: 'OPEN', title: 't' })).toEqual({})
  })

  it('marks a cross-repository PR as a fork with owner/name head repo', () => {
    expect(
      forkFieldsFromPr({
        headRefName: 'fix',
        state: 'OPEN',
        title: 't',
        isCrossRepository: true,
        headRepositoryOwner: { login: 'contributor' },
        headRepository: { name: 'widgets' },
      })
    ).toEqual({ prIsFork: true, prHeadRepo: 'contributor/widgets' })
  })

  it('leaves prHeadRepo undefined when the fork head repo owner or name is missing', () => {
    expect(
      forkFieldsFromPr({
        headRefName: 'fix',
        state: 'OPEN',
        title: 't',
        isCrossRepository: true,
        headRepositoryOwner: { login: 'contributor' },
      })
    ).toEqual({ prIsFork: true, prHeadRepo: undefined })
  })
})

describe('describePrLookupFailure', () => {
  it('reports "not found" when gh could not resolve the PR', () => {
    expect(describePrLookupFailure(42, 'could not resolve to a PullRequest')).toBe(
      'PR #42 not found in this repository.'
    )
  })

  it('reports "not found" when there is no detail', () => {
    expect(describePrLookupFailure(42, '   ')).toBe('PR #42 not found in this repository.')
  })

  it('surfaces the real error for a rate-limit or auth failure', () => {
    expect(describePrLookupFailure(42, 'API rate limit exceeded')).toBe(
      'Failed to look up PR #42: API rate limit exceeded'
    )
  })
})

describe('createPrLookup', () => {
  const ghJson = (items: { number: number; owner?: string }[]): { stdout: string } => ({
    stdout: JSON.stringify(
      items.map((i) => ({
        number: i.number,
        headRepositoryOwner: i.owner ? { login: i.owner } : null,
      }))
    ),
  })

  it('queries gh with the branch and returns the PR number', async () => {
    const runGh = vi.fn<GhRunner>().mockResolvedValue(ghJson([{ number: 7 }]))
    const lookup = createPrLookup({ runGh, resolveOwner: () => undefined, now: () => 0 })

    expect(await lookup.lookup('/proj', 'feature')).toBe(7)
    expect(runGh).toHaveBeenCalledWith(
      [
        'pr',
        'list',
        '--head',
        'feature',
        '--state',
        'open',
        '--json',
        'number,headRepositoryOwner',
        '--limit',
        '10',
      ],
      '/proj'
    )
  })

  it('prefers the PR whose head repo owner matches the origin owner', async () => {
    const runGh = vi.fn<GhRunner>().mockResolvedValue(
      ghJson([
        { number: 1, owner: 'someoneelse' },
        { number: 2, owner: 'me' },
      ])
    )
    const lookup = createPrLookup({ runGh, resolveOwner: () => 'me', now: () => 0 })

    expect(await lookup.lookup('/proj', 'main')).toBe(2)
  })

  it('falls back to the first result when no owner matches', async () => {
    const runGh = vi.fn<GhRunner>().mockResolvedValue(
      ghJson([
        { number: 1, owner: 'a' },
        { number: 2, owner: 'b' },
      ])
    )
    const lookup = createPrLookup({ runGh, resolveOwner: () => 'me', now: () => 0 })

    expect(await lookup.lookup('/proj', 'main')).toBe(1)
  })

  it('caches a positive hit forever (no second gh call)', async () => {
    const runGh = vi.fn<GhRunner>().mockResolvedValue(ghJson([{ number: 7 }]))
    let clock = 0
    const lookup = createPrLookup({ runGh, resolveOwner: () => undefined, now: () => clock })

    expect(await lookup.lookup('/proj', 'feature')).toBe(7)
    clock = 10 * 60 * 1000
    expect(await lookup.lookup('/proj', 'feature')).toBe(7)
    expect(runGh).toHaveBeenCalledTimes(1)
  })

  it('caches a negative hit only until the TTL expires', async () => {
    const runGh = vi.fn<GhRunner>().mockResolvedValue(ghJson([]))
    let clock = 0
    const lookup = createPrLookup({
      runGh,
      resolveOwner: () => undefined,
      now: () => clock,
      negativeCacheTtlMs: 1000,
    })

    expect(await lookup.lookup('/proj', 'feature')).toBeUndefined()
    clock = 500
    expect(await lookup.lookup('/proj', 'feature')).toBeUndefined()
    expect(runGh).toHaveBeenCalledTimes(1)

    clock = 2000
    runGh.mockResolvedValue(ghJson([{ number: 9 }]))
    expect(await lookup.lookup('/proj', 'feature')).toBe(9)
    expect(runGh).toHaveBeenCalledTimes(2)
  })

  it('does not cache a transient gh failure — the next call retries', async () => {
    const runGh = vi
      .fn<GhRunner>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(ghJson([{ number: 5 }]))
    const lookup = createPrLookup({ runGh, resolveOwner: () => undefined, now: () => 0 })

    expect(await lookup.lookup('/proj', 'feature')).toBeUndefined()
    expect(await lookup.lookup('/proj', 'feature')).toBe(5)
    expect(runGh).toHaveBeenCalledTimes(2)
  })
})
