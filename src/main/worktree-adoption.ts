import { branchRefExists } from './branch-ref'
import { resolveOriginDefaultBase, type GitRunner } from './origin-base'

interface NamedWorktreeRequest {
  worktreePath: string
  branch: string
}

export interface NamedWorktreeGit {
  runGit: GitRunner
  runWorktreeGit?: GitRunner
  branchExists?: (branch: string) => Promise<boolean>
}

type CheckoutResult = { ok: true } | { ok: false; stage: 'origin' | 'worktree'; cause: unknown }

export type NamedWorktreeAttempt = { ok: true } | { ok: false; message: string }

async function checkout(
  { worktreePath, branch }: NamedWorktreeRequest,
  git: NamedWorktreeGit
): Promise<CheckoutResult> {
  let originRef: string
  try {
    originRef = await resolveOriginDefaultBase(git.runGit)
  } catch (cause) {
    return { ok: false, stage: 'origin', cause }
  }

  const runWorktreeGit = git.runWorktreeGit ?? git.runGit
  try {
    await runWorktreeGit(['worktree', 'add', worktreePath, '--no-track', '-b', branch, originRef])
    return { ok: true }
  } catch (creationError) {
    // An injected probe may reject; keep it outside the adoption catch so a
    // transport failure is never converted into a checkout diagnostic.
    const exists = git.branchExists
      ? await git.branchExists(branch)
      : await branchRefExists(git.runGit, branch)
    if (!exists) return { ok: false, stage: 'worktree', cause: creationError }

    try {
      await runWorktreeGit(['worktree', 'add', worktreePath, branch])
      return { ok: true }
    } catch (cause) {
      return { ok: false, stage: 'worktree', cause }
    }
  }
}

// Ordinary Sessions throw the original cause; issue Sessions return a display
// error. Both intents share the same origin-default checkout protocol.
export async function checkoutNamedWorktree(
  request: NamedWorktreeRequest,
  git: NamedWorktreeGit
): Promise<void> {
  const result = await checkout(request, git)
  if (!result.ok) throw result.cause
}

export async function tryCheckoutNamedWorktree(
  request: NamedWorktreeRequest,
  git: NamedWorktreeGit
): Promise<NamedWorktreeAttempt> {
  const result = await checkout(request, git)
  if (result.ok) return result
  if (result.stage === 'worktree') {
    return { ok: false, message: worktreeCreationError(request.branch, result.cause) }
  }

  const detail = (result.cause as Error).message
  const message =
    detail === 'no-origin-remote'
      ? 'This project has no origin remote.'
      : detail === 'no-origin-default-branch'
        ? "Could not determine origin's default branch."
        : `Failed to resolve origin default: ${detail}`
  return { ok: false, message }
}

export function worktreeCreationError(branch: string, cause: unknown): string {
  return `Failed to create worktree for branch "${branch}": ${(cause as Error).message}`
}
