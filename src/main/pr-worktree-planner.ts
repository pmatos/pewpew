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

// Where to fetch a PR head's refs/pull/<n>/head from. With no override the head
// lives on origin; an override (the PR's own repo, e.g. a fork's upstream when a
// fork clone opens an upstream PR) exposes the pull ref on its own GitHub URL,
// which we fetch directly so no named remote is required for it.
export function prHeadFetchRemote(repo?: string | null): string {
  return repo ? `https://github.com/${repo}.git` : 'origin'
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
  // True when the PR head lives outside our origin — a cross-repo (fork) PR, OR
  // a repo override (a fork clone opening its upstream's PR). Both need the
  // pull-ref checkout into a pewpew-namespaced branch and have no origin/<branch>
  // fallback.
  isFork: boolean
  forkFields: ForkFields
  // The remote to `git fetch` from: `origin` normally, or the overridden repo's
  // GitHub URL when the PR belongs to a different repo than origin.
  fetchRemote: string
  // The refspec argument to `git fetch <fetchRemote>`. A head-elsewhere PR head is
  // only authoritative via refs/pull/<n>/head, force-fetched (`+`) into the
  // pewpew-namespaced branch; a same-repo PR head lives on origin/<branch>.
  fetchRefspec: string
  // The PR title, carried through so callers can parse an issue number from it.
  title: string
}

export type PlanPrWorktreeResult =
  { ok: true; plan: PrWorktreePlan } | { ok: false; message: string }

// Decide how to check out a PR from its gh metadata. Returns a user-facing
// message (never throws) when the PR isn't open; otherwise a fully-resolved
// plan the caller executes with its own git runner (local or remote).
export function planPrWorktree(
  prNumber: number,
  prInfo: PrViewInfo,
  repo?: string | null
): PlanPrWorktreeResult {
  if (prInfo.state !== 'OPEN') {
    return { ok: false, message: `PR #${prNumber} is ${prInfo.state.toLowerCase()}, not open.` }
  }

  const worktreeName = `pr-${prNumber}`
  const branch = prInfo.headRefName
  const crossRepoFields = forkFieldsFromPr(prInfo)
  const externalRepo = repo || undefined
  // The head lives outside origin for a cross-repo (fork) PR OR when a repo
  // override targets a different repo than origin. Both take the pull-ref path.
  const isFork = crossRepoFields.prIsFork === true || externalRepo !== undefined
  const localBranch = isFork ? `pewpew/${worktreeName}` : branch
  const fetchRemote = prHeadFetchRemote(externalRepo)
  const fetchRefspec = isFork ? `+pull/${prNumber}/head:${localBranch}` : branch
  const headRepo = crossRepoFields.prHeadRepo ?? externalRepo
  const forkFields: ForkFields = {
    ...(isFork ? { prIsFork: true } : {}),
    ...(headRepo ? { prHeadRepo: headRepo } : {}),
  }

  return {
    ok: true,
    plan: {
      worktreeName,
      branch,
      localBranch,
      isFork,
      forkFields,
      fetchRemote,
      fetchRefspec,
      title: prInfo.title,
    },
  }
}

// The error surfaced when a head-elsewhere PR's pull-ref fetch didn't produce
// the local branch: there is no valid origin fallback (origin/<branch> is not
// the PR head), so both call sites must fail explicitly with this message. When
// the fetch itself reported an error, `detail` carries it — an override fetch
// runs over the upstream repo's own URL rather than the pre-configured `origin`,
// so a private/SSH-only/GHES upstream can fail auth here even though `gh pr view`
// succeeded, and the raw git error is what tells the user that (rather than
// looking like the PR doesn't exist).
export function forkPullRefUnavailableMessage(
  branch: string,
  prNumber: number,
  detail?: string
): string {
  const base = `Failed to create worktree for branch "${branch}": could not fetch refs/pull/${prNumber}/head`
  const trimmed = detail?.trim()
  return trimmed ? `${base} — ${trimmed}` : base
}
