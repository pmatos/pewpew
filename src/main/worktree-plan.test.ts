import { describe, expect, it } from 'vitest'
import { planIssueWorktree } from './worktree-plan'

describe('planIssueWorktree', () => {
  it('names the worktree and branch issue-<n>', () => {
    expect(planIssueWorktree(37)).toEqual({
      worktreeName: 'issue-37',
      branch: 'issue-37',
    })
  })
})
