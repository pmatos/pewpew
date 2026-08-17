// Shared two-phase fallback for `git worktree add`, used by both the local and
// remote issue- and session-creation paths so those four sites can't drift.
//
// The protocol: try to add a worktree that also creates a fresh branch. Git
// fails that DWIM when the branch already exists, so on failure we probe for the
// branch and, if it's there, retry adding a worktree that adopts it. The outcome
// is a discriminated result carrying the *original* error object as `cause`,
// letting each caller surface failure its own way — issue paths wrap `cause`
// into a user-facing string via `worktreeCreationError`, session paths re-throw
// it — without this module owning either policy. `branchExists` is deliberately
// left outside the try/catch: a probe failure (e.g. a dropped SSH connection) is
// not proof the branch is absent, so it propagates rather than being treated as
// "does not exist".

export interface WorktreeAdoptionSteps {
  addNewBranch: () => Promise<void>
  branchExists: () => Promise<boolean>
  adoptExistingBranch: () => Promise<void>
}

export type WorktreeAdoptionResult = { ok: true } | { ok: false; cause: unknown }

export async function createOrAdoptWorktree(
  steps: WorktreeAdoptionSteps
): Promise<WorktreeAdoptionResult> {
  try {
    await steps.addNewBranch()
    return { ok: true }
  } catch (creationError) {
    if (!(await steps.branchExists())) {
      return { ok: false, cause: creationError }
    }
    try {
      await steps.adoptExistingBranch()
      return { ok: true }
    } catch (adoptionError) {
      return { ok: false, cause: adoptionError }
    }
  }
}

export function worktreeCreationError(branch: string, cause: unknown): string {
  return `Failed to create worktree for branch "${branch}": ${(cause as Error).message}`
}
