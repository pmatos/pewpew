import { branchRefExists } from './branch-ref'
import { forkPullRefUnavailableMessage, type PrWorktreePlan } from './pr-worktree-planner'
import { worktreeCreationError } from './worktree-adoption'
import type { GitRunner } from './origin-base'

export type PrWorktreeCheckoutResult = { ok: true } | { ok: false; message: string }

function fetchFailureDetail(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim()
    if (stderr) return stderr
  }
  return err instanceof Error ? err.message : String(err)
}

// The plan names the PR head; checkout owns the Git sequence for both local
// and remote worktrees. The runner is the only placement-specific adapter.
export async function checkoutPrWorktree(
  plan: PrWorktreePlan,
  worktreePath: string,
  runGit: GitRunner
): Promise<PrWorktreeCheckoutResult> {
  let fetchError: string | undefined
  try {
    await runGit(['fetch', plan.fetchRemote, plan.fetchRefspec])
  } catch (err) {
    fetchError = fetchFailureDetail(err)
  }

  const branchExists = await branchRefExists(runGit, plan.localBranch, { quiet: true })
  if (plan.isFork && !branchExists) {
    return {
      ok: false,
      message: forkPullRefUnavailableMessage(plan.branch, plan.prNumber, fetchError),
    }
  }

  const addArgs = branchExists
    ? ['worktree', 'add', worktreePath, plan.localBranch]
    : ['worktree', 'add', worktreePath, '-b', plan.localBranch, `origin/${plan.branch}`]
  try {
    await runGit(addArgs)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: worktreeCreationError(plan.branch, err) }
  }
}
