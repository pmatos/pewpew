import { describe, expect, it } from 'vitest'
import {
  describePrLookupFailure,
  forkFieldsFromPr,
  planPrWorktree,
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
      fetchRefspec: '+pull/335/head:pewpew/pr-335',
      title: 'docs: fix x',
    })
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
