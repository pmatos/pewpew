// Pure derivation of the bubblewrap argv prefix that confines an agent
// process to its session worktree. Claude Code's own sandbox only isolates
// Bash subprocesses — the built-in Write/Edit tools bypass it entirely under
// --dangerously-skip-permissions — so pewpew owns this boundary itself at the
// tmux spawn layer instead. Kept free of fs/child_process so bind order (see
// below) can be asserted directly in unit tests.
//
// Verified against the real bwrap + claude CLI: a write to <project> or a
// sibling worktree resolves EROFS from the Write tool itself, while worktree
// writes, `npm ci`, `git add`/`commit`, and `git config --local` all succeed.
//
// Bind order is load-bearing — later binds override earlier ones:
//   1. --dev-bind / /                      full host filesystem, read-write
//   2. --ro-bind <project> <project>       lock the project root read-only
//   3. --bind <project>/.git <project>/.git    ...except the shared .git,
//      writable again (git commit/checkout need it for the linked worktree)
//   4. --ro-bind <project>/.git/hooks ...  ...except hooks/, which stays
//      read-only (kills the code-exec-persistence path through .git/hooks)
//   5. extra caller-granted writable paths (e.g. /tmp)
//   6. --bind <worktree> <worktree>        the session's own worktree, r/w
//   7. --chdir <worktree> --               land in the worktree; `--`
//      separates bwrap's own options from the command to run inside it
//
// Deliberately NOT ro-binding <project>/.git/config: that breaks `git config
// --local` with "Device or resource busy", which fails husky-style `prepare`
// scripts during `npm ci` — every session would die at install.

export interface SandboxOptions {
  enabled?: boolean
  extraWritablePaths?: string[]
}

export function buildSandboxArgs(
  projectPath: string,
  worktreePath: string,
  opts: SandboxOptions = {}
): string[] {
  const { enabled = true, extraWritablePaths = [] } = opts
  if (!enabled) return []

  // Nothing to confine to when the "worktree" IS the project root (e.g. a
  // session opened directly on the main checkout rather than a linked
  // worktree) — there's no narrower boundary to enforce.
  if (worktreePath === projectPath) return []

  const args = [
    'bwrap',
    '--dev-bind',
    '/',
    '/',
    '--ro-bind',
    projectPath,
    projectPath,
    '--bind',
    `${projectPath}/.git`,
    `${projectPath}/.git`,
    '--ro-bind',
    `${projectPath}/.git/hooks`,
    `${projectPath}/.git/hooks`,
  ]

  for (const path of extraWritablePaths) {
    args.push('--bind', path, path)
  }

  args.push('--bind', worktreePath, worktreePath, '--chdir', worktreePath, '--')
  return args
}
