// Pure worktree-planning for issue sessions. The subtler PR-worktree planning
// (fork detection, local-branch choice, fetch-refspec decision) lives in
// ./pr-worktree-planner; this module owns only the `issue-<n>` naming
// convention, shared by local and remote issue-session creation so the two
// paths can't drift.

export interface IssueWorktreePlan {
  worktreeName: string
  branch: string
}

export function planIssueWorktree(issueNumber: number): IssueWorktreePlan {
  const name = `issue-${issueNumber}`
  return { worktreeName: name, branch: name }
}
