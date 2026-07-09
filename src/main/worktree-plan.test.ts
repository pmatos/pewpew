import { describe, expect, it } from 'vitest'
import {
  forkFieldsFromPr,
  planPrWorktree,
  planIssueWorktree,
  type PrViewInfo,
} from './worktree-plan'

const samePr: PrViewInfo = {
  headRefName: 'feature-x',
  state: 'OPEN',
  title: 'Add feature x',
}

const forkPr: PrViewInfo = {
  headRefName: 'codex/fix-x',
  state: 'OPEN',
  title: 'Fix x',
  isCrossRepository: true,
  headRepositoryOwner: { login: 'contributor' },
  headRepository: { name: 'pewpew' },
}

describe('forkFieldsFromPr', () => {
  it('returns no fork fields for a same-repo PR', () => {
    expect(forkFieldsFromPr(samePr)).toEqual({})
  })

  it('marks a cross-repository PR as a fork with owner/name head repo', () => {
    expect(forkFieldsFromPr(forkPr)).toEqual({
      prIsFork: true,
      prHeadRepo: 'contributor/pewpew',
    })
  })

  it('leaves prHeadRepo undefined when the head repo owner or name is missing', () => {
    expect(
      forkFieldsFromPr({
        headRefName: 'x',
        state: 'OPEN',
        title: 't',
        isCrossRepository: true,
        headRepositoryOwner: { login: 'contributor' },
        headRepository: null,
      })
    ).toEqual({ prIsFork: true, prHeadRepo: undefined })
  })
})

describe('planPrWorktree', () => {
  it('checks out a same-repo PR under its own head branch and fetches that branch', () => {
    const plan = planPrWorktree(42, samePr)
    expect(plan).toEqual({
      worktreeName: 'pr-42',
      headBranch: 'feature-x',
      isFork: false,
      forkFields: {},
      localBranch: 'feature-x',
      fetchArgv: ['fetch', 'origin', 'feature-x'],
    })
  })

  it('namespaces a fork PR under pewpew/ and fetches the pull ref, never origin/<branch>', () => {
    const plan = planPrWorktree(335, forkPr)
    expect(plan).toEqual({
      worktreeName: 'pr-335',
      headBranch: 'codex/fix-x',
      isFork: true,
      forkFields: { prIsFork: true, prHeadRepo: 'contributor/pewpew' },
      localBranch: 'pewpew/pr-335',
      fetchArgv: ['fetch', 'origin', '+pull/335/head:pewpew/pr-335'],
    })
  })
})

describe('planIssueWorktree', () => {
  it('names the worktree and branch issue-<n>', () => {
    expect(planIssueWorktree(37)).toEqual({
      worktreeName: 'issue-37',
      branch: 'issue-37',
    })
  })
})
