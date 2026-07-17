// Whether a local branch ref exists in the repository a GitRunner targets.
// Pure with respect to the injected runner so it can be exercised without
// spawning git — a successful `rev-parse --verify refs/heads/<branch>` means the
// branch exists; a non-zero exit (rejection) means it doesn't. `quiet` mirrors
// the `--quiet` flag some callers pass to silence git's diagnostics.

import type { GitRunner } from './origin-base'

export async function branchRefExists(
  run: GitRunner,
  branch: string,
  opts: { quiet?: boolean } = {}
): Promise<boolean> {
  const argv = ['rev-parse', '--verify', ...(opts.quiet ? ['--quiet'] : []), `refs/heads/${branch}`]
  try {
    await run(argv)
    return true
  } catch {
    return false
  }
}
