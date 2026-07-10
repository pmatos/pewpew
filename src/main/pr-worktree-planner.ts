// Pure planning for checking out a GitHub PR into a worktree.
//
// The decisions here — is the PR a fork, which local branch to check out, which
// refspec to fetch, whether the PR is even open — are identical for local
// (execFile git) and remote (SSH) session creation. Keeping them in one pure
// module means the subtle fork invariants live in exactly one place, are unit-
// testable without any I/O mocking, and can't drift between the two call sites.

// Fields gh returns for a PR. Beyond head branch/state/title we read the
// cross-repository flag and the head repo identity so a fork PR can be both
// checked out (via refs/pull/<n>/head) and marked as such on the session.
export interface PrViewInfo {
  headRefName: string
  state: string
  title: string
  isCrossRepository?: boolean
  headRepositoryOwner?: { login?: string } | null
  headRepository?: { name?: string } | null
}

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

// `gh pr view` fails for many reasons beyond the PR genuinely not existing —
// rate limiting, auth, network, or gh resolving the wrong default repo. Only
// report "not found" when gh actually said the PR couldn't be resolved;
// otherwise surface the real error so a rate-limit or auth failure isn't
// misreported as a missing PR (which sends the user hunting for a PR that's
// right there on GitHub).
export function describePrLookupFailure(prNumber: number, detail: string): string {
  const trimmed = detail.trim()
  const genuinelyMissing =
    /could not resolve to a (pull ?request|issue)/i.test(trimmed) ||
    /no pull requests? found/i.test(trimmed)
  if (!trimmed || genuinelyMissing) {
    return `PR #${prNumber} not found in this repository.`
  }
  return `Failed to look up PR #${prNumber}: ${trimmed}`
}

export interface PrWorktreePlan {
  // Directory name (and IPC-visible worktree name) for the PR: always `pr-<n>`.
  worktreeName: string
  // The PR's real head branch name, as reported by gh. Used for user-facing
  // messages and for the same-repo `origin/<branch>` fallback.
  branch: string
  // The local branch to check out. A fork PR's head branch name isn't unique
  // across forks, so it gets a PR-scoped branch namespaced under `pewpew/`;
  // same-repo PRs keep the real branch so pushes update the PR via origin.
  localBranch: string
  isFork: boolean
  forkFields: ForkFields
  // The third argument to `git fetch origin`. A fork PR head is only
  // authoritative via refs/pull/<n>/head, force-fetched (`+`) into the
  // pewpew-namespaced branch; a same-repo PR head lives on origin/<branch>.
  fetchRefspec: string
  // The PR title, carried through so callers can parse an issue number from it.
  title: string
}

export type PlanPrWorktreeResult =
  | { ok: true; plan: PrWorktreePlan }
  | { ok: false; message: string }

// Decide how to check out a PR from its gh metadata. Returns a user-facing
// message (never throws) when the PR isn't open; otherwise a fully-resolved
// plan the caller executes with its own git runner (local or remote).
export function planPrWorktree(prNumber: number, prInfo: PrViewInfo): PlanPrWorktreeResult {
  if (prInfo.state !== 'OPEN') {
    return { ok: false, message: `PR #${prNumber} is ${prInfo.state.toLowerCase()}, not open.` }
  }

  const worktreeName = `pr-${prNumber}`
  const branch = prInfo.headRefName
  const forkFields = forkFieldsFromPr(prInfo)
  const isFork = forkFields.prIsFork === true
  const localBranch = isFork ? `pewpew/${worktreeName}` : branch
  const fetchRefspec = isFork ? `+pull/${prNumber}/head:${localBranch}` : branch

  return {
    ok: true,
    plan: {
      worktreeName,
      branch,
      localBranch,
      isFork,
      forkFields,
      fetchRefspec,
      title: prInfo.title,
    },
  }
}

// The error surfaced when a fork PR's pull-ref fetch didn't produce the local
// branch: there is no valid origin fallback for a fork (origin/<branch> is not
// the PR head), so both call sites must fail explicitly with this message.
export function forkPullRefUnavailableMessage(branch: string, prNumber: number): string {
  return `Failed to create worktree for branch "${branch}": could not fetch refs/pull/${prNumber}/head`
}
