// Pure worktree-planning decisions shared by local and remote PR/issue session
// creation. This module owns the worktree/branch naming conventions and the
// fork-aware branch + fetch-refspec logic — the subtlest, most bug-prone part
// of session creation — so it lives behind one tested seam instead of being
// duplicated verbatim across the four creation orchestrators in
// session-manager.ts. The orchestrators keep their own IO (git fetch, worktree
// add) but read every naming/branch/fetch decision from here.

export interface PrViewInfo {
  headRefName: string
  state: string
  title: string
  isCrossRepository?: boolean
  headRepositoryOwner?: { login?: string } | null
  headRepository?: { name?: string } | null
}

// The `--json` field set `gh pr view` must request to populate PrViewInfo.
export const PR_VIEW_FIELDS =
  'headRefName,state,title,isCrossRepository,headRepositoryOwner,headRepository'

export interface ForkFields {
  prIsFork?: boolean
  prHeadRepo?: string
}

export function forkFieldsFromPr(prInfo: PrViewInfo): ForkFields {
  if (prInfo.isCrossRepository !== true) return {}
  const owner = prInfo.headRepositoryOwner?.login
  const name = prInfo.headRepository?.name
  return { prIsFork: true, prHeadRepo: owner && name ? `${owner}/${name}` : undefined }
}

export interface PrWorktreePlan {
  worktreeName: string
  headBranch: string
  isFork: boolean
  forkFields: ForkFields
  localBranch: string
  fetchArgv: string[]
}

export function planPrWorktree(prNumber: number, prInfo: PrViewInfo): PrWorktreePlan {
  const worktreeName = `pr-${prNumber}`
  const headBranch = prInfo.headRefName
  const forkFields = forkFieldsFromPr(prInfo)
  const isFork = forkFields.prIsFork === true

  // The local branch to check out. A fork PR's head branch name isn't unique
  // across forks, so give it a PR-scoped local branch. We namespace it under
  // `pewpew/` (rather than a bare `pr-<n>`) so the forced fetch below can never
  // clobber an unrelated user branch that happens to be named `pr-<n>`. Same-
  // repo PRs keep the real branch name so pushes from the worktree update the
  // PR via origin/<branch>.
  const localBranch = isFork ? `pewpew/${worktreeName}` : headBranch

  // Fetch the PR head into the local branch we'll check out. A fork PR head is
  // ONLY authoritative via GitHub's refs/pull/<n>/head: we must not fetch
  // origin/<branch>, because if the fork's head branch name also exists on the
  // base repo (e.g. a fork whose head branch is `main`) that fetch would
  // succeed and we'd later check out the base repo's branch instead of the PR's
  // commits. A same-repo PR head lives on origin/<branch>, so fetch that. The
  // forced refspec (`+`) is required because a removed session leaves the
  // pewpew/ branch behind and a later PR force-push makes a non-forced fetch
  // reject as non-fast-forward — the pewpew/ branch is pewpew-owned and must
  // always track the current PR head.
  const fetchArgv = isFork
    ? ['fetch', 'origin', `+pull/${prNumber}/head:${localBranch}`]
    : ['fetch', 'origin', headBranch]

  return { worktreeName, headBranch, isFork, forkFields, localBranch, fetchArgv }
}

export interface IssueWorktreePlan {
  worktreeName: string
  branch: string
}

export function planIssueWorktree(issueNumber: number): IssueWorktreePlan {
  const name = `issue-${issueNumber}`
  return { worktreeName: name, branch: name }
}
