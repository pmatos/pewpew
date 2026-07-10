import { describe, expect, it } from 'vitest'
import {
  describePrLookupFailure,
  forkFieldsFromPr,
  planPrWorktree,
  prHeadFetchRemote,
  type PrViewInfo,
} from './pr-worktree-planner'

// A same-repo (non-fork) PR: gh reports isCrossRepository=false and the head
// branch lives on origin, so the real branch name is safe to check out directly.
function sameRepoPr(overrides: Partial<PrViewInfo> = {}): PrViewInfo {
  return {
    headRefName: 'feat-y',
    state: 'OPEN',
    title: 'feat: y',
    isCrossRepository: false,
    ...overrides,
  }
}

// A fork PR: gh reports isCrossRepository=true and identifies the head repo by
// owner/name. Its head branch name is NOT unique across forks.
function forkPr(overrides: Partial<PrViewInfo> = {}): PrViewInfo {
  return {
    headRefName: 'codex/fix-x',
    state: 'OPEN',
    title: 'docs: fix x',
    isCrossRepository: true,
    headRepositoryOwner: { login: 'contributor' },
    headRepository: { name: 's11' },
    ...overrides,
  }
}

describe('forkFieldsFromPr', () => {
  it('returns empty fields for a same-repo PR', () => {
    expect(forkFieldsFromPr(sameRepoPr())).toEqual({})
  })

  it('marks a cross-repository PR as a fork and records owner/name', () => {
    expect(forkFieldsFromPr(forkPr())).toEqual({
      prIsFork: true,
      prHeadRepo: 'contributor/s11',
    })
  })

  it('marks a fork but omits headRepo when owner or name is missing', () => {
    expect(forkFieldsFromPr(forkPr({ headRepository: null }))).toEqual({
      prIsFork: true,
      prHeadRepo: undefined,
    })
    expect(forkFieldsFromPr(forkPr({ headRepositoryOwner: null }))).toEqual({
      prIsFork: true,
      prHeadRepo: undefined,
    })
  })
})

describe('prHeadFetchRemote', () => {
  it('fetches from origin when there is no repo override', () => {
    expect(prHeadFetchRemote()).toBe('origin')
    expect(prHeadFetchRemote(null)).toBe('origin')
  })

  it('fetches from the overridden repo https URL', () => {
    expect(prHeadFetchRemote('up/stream')).toBe('https://github.com/up/stream.git')
  })
})

describe('describePrLookupFailure', () => {
  it('reports "not found" when gh could not resolve the PR', () => {
    expect(
      describePrLookupFailure(
        42,
        'GraphQL: Could not resolve to a PullRequest with the number of 42.'
      )
    ).toBe('PR #42 not found in this repository.')
  })

  it('reports "not found" when gh found no pull requests', () => {
    expect(describePrLookupFailure(42, 'no pull requests found for branch')).toBe(
      'PR #42 not found in this repository.'
    )
  })

  it('reports "not found" when there is no detail at all', () => {
    expect(describePrLookupFailure(42, '   ')).toBe('PR #42 not found in this repository.')
  })

  it('surfaces the real error for a rate-limit / auth / network failure', () => {
    expect(describePrLookupFailure(42, 'API rate limit exceeded')).toBe(
      'Failed to look up PR #42: API rate limit exceeded'
    )
  })
})

describe('planPrWorktree', () => {
  it('refuses a PR that is not open, naming its state in lowercase', () => {
    expect(planPrWorktree(9, sameRepoPr({ state: 'CLOSED' }))).toEqual({
      ok: false,
      message: 'PR #9 is closed, not open.',
    })
    expect(planPrWorktree(12, sameRepoPr({ state: 'MERGED' }))).toEqual({
      ok: false,
      message: 'PR #12 is merged, not open.',
    })
  })

  it('plans a same-repo PR against its real head branch on origin', () => {
    const result = planPrWorktree(7, sameRepoPr())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.plan).toEqual({
      worktreeName: 'pr-7',
      branch: 'feat-y',
      localBranch: 'feat-y',
      isFork: false,
      forkFields: {},
      fetchRemote: 'origin',
      fetchRefspec: 'feat-y',
      title: 'feat: y',
    })
  })

  it('plans a fork PR against a pewpew-namespaced branch fetched from the pull ref', () => {
    const result = planPrWorktree(335, forkPr())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.plan).toEqual({
      worktreeName: 'pr-335',
      branch: 'codex/fix-x',
      localBranch: 'pewpew/pr-335',
      isFork: true,
      forkFields: { prIsFork: true, prHeadRepo: 'contributor/s11' },
      fetchRemote: 'origin',
      fetchRefspec: '+pull/335/head:pewpew/pr-335',
      title: 'docs: fix x',
    })
  })

  it('treats a repo override as head-elsewhere: pull-ref checkout from the upstream URL', () => {
    // A fork clone opening a plain (non-cross-repo) PR from its upstream: the head
    // lives outside origin, so it must be fetched from the upstream's URL into a
    // pewpew-namespaced branch and flagged like a fork.
    const result = planPrWorktree(42, sameRepoPr({ headRefName: 'feature-x' }), 'up/stream')
    if (!result.ok) throw new Error(result.message)
    expect(result.plan).toEqual({
      worktreeName: 'pr-42',
      branch: 'feature-x',
      localBranch: 'pewpew/pr-42',
      isFork: true,
      forkFields: { prIsFork: true, prHeadRepo: 'up/stream' },
      fetchRemote: 'https://github.com/up/stream.git',
      fetchRefspec: '+pull/42/head:pewpew/pr-42',
      title: 'feat: y',
    })
  })

  it('keeps the real head repo when a cross-repo PR is opened via a repo override', () => {
    // The override picks which repo the PR is listed from; prHeadRepo still names
    // the actual head repo (the contributor's fork) when gh reports one.
    const result = planPrWorktree(50, forkPr(), 'up/stream')
    if (!result.ok) throw new Error(result.message)
    expect(result.plan.fetchRemote).toBe('https://github.com/up/stream.git')
    expect(result.plan.forkFields).toEqual({ prIsFork: true, prHeadRepo: 'contributor/s11' })
  })

  it('never derives a fork local branch that could collide with the base repo', () => {
    // A fork whose head branch is literally "main" must not resolve to the base
    // repo's main branch — the pewpew/ namespace and pull-ref fetch guarantee it.
    const result = planPrWorktree(50, forkPr({ headRefName: 'main' }))
    if (!result.ok) throw new Error(result.message)
    expect(result.plan.localBranch).toBe('pewpew/pr-50')
    expect(result.plan.fetchRefspec).toBe('+pull/50/head:pewpew/pr-50')
    expect(result.plan.branch).toBe('main')
  })
})
