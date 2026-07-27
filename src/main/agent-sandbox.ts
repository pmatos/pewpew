// Pure derivation of the bubblewrap argv prefix that confines an agent
// process to its session worktree. Claude Code's own sandbox only isolates
// Bash subprocesses — the built-in Write/Edit tools bypass it entirely under
// --dangerously-skip-permissions — so pewpew owns this boundary itself at the
// tmux spawn layer instead. Kept free of fs/child_process so bind order (see
// below) can be asserted directly in unit tests.
//
// The host filesystem is read-only by default (--ro-bind / /) — Bash writes
// to anything outside the explicit writable mounts below (a sibling repo,
// ~/.bashrc, SSH keys, another worktree) resolve EROFS. This is narrower
// than the project tree alone: it's the actual containment boundary, not
// just a documentation note about one.
//
// Verified against the real bwrap + claude CLI: a write to <project>, a
// sibling worktree, or an arbitrary host path (e.g. $HOME) resolves EROFS
// from both the Write tool and Bash, while worktree writes, `npm ci`,
// `git add`/`commit`, and `git config --local` all succeed.
//
// Bind order is load-bearing — later binds override earlier ones:
//   1. --ro-bind / /                       host filesystem, read-only
//   2. --dev /dev                          minimal, safe device nodes
//   3. --proc /proc                        fresh procfs
//   4. --tmpfs /tmp                        session-scoped scratch space
//      (build tools, npm, editors all assume /tmp is writable; a fresh
//      tmpfs keeps it isolated from the host's /tmp and other sessions')
//   5. --ro-bind <project> <project>       lock the project root read-only
//      (redundant with step 1 but kept explicit — the project's own
//      protection shouldn't depend on the root strategy staying this way)
//   6. --bind <project>/.git <project>/.git    ...except the shared .git,
//      writable again (git commit/checkout need it for the linked worktree)
//   7. --ro-bind-try <project>/.git/hooks ...  ...except hooks/, which stays
//      read-only (kills the code-exec-persistence path through .git/hooks).
//      "-try" degrades gracefully when hooks/ doesn't exist (e.g. a repo with
//      core.hooksPath pointed elsewhere) instead of hard-failing bwrap's spawn.
//   8. extra caller-granted writable paths — any path that equals, is
//      nested under, or is an ancestor of <project> is dropped, since it
//      would re-open the read-only guarantees from steps 1 and 5-7
//   9. --bind <worktree> <worktree>        the session's own worktree, r/w
//   10. --chdir <worktree> --              land in the worktree; `--`
//      separates bwrap's own options from the command to run inside it
//
// Deliberately NOT ro-binding <project>/.git/config: that breaks `git config
// --local` with "Device or resource busy", which fails husky-style `prepare`
// scripts during `npm ci` — every session would die at install.

import { normalize } from 'node:path'

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
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--ro-bind',
    projectPath,
    projectPath,
    '--bind',
    `${projectPath}/.git`,
    `${projectPath}/.git`,
    '--ro-bind-try',
    `${projectPath}/.git/hooks`,
    `${projectPath}/.git/hooks`,
  ]

  // extraWritablePaths binds run after the project ro-binds above, and bwrap
  // binds are order-dependent — a caller-supplied path that overlaps
  // projectPath in EITHER direction would re-mount part or all of the
  // project read-write, undoing the guarantees this function exists to
  // enforce: a path nested under projectPath re-opens that subtree, and a
  // path that is an ANCESTOR of projectPath (e.g. extraWritablePaths
  // containing "/home/dev" when projectPath is "/home/dev/project") re-mounts
  // projectPath itself along with it. Drop any such overlap rather than
  // trusting the caller to avoid it.
  //
  // Both sides are normalized (lexically, via node:path — no fs access)
  // before comparing: a non-canonical entry like "<project>/../project"
  // collapses right back to <project> itself, which the raw string wouldn't
  // match against a plain startsWith/=== check.
  const normalizedProjectPath = normalize(projectPath)

  const overlapsProject = (path: string): boolean => {
    const normalizedPath = normalize(path)
    return (
      normalizedPath === normalizedProjectPath ||
      normalizedPath === '/' ||
      normalizedPath.startsWith(`${normalizedProjectPath}/`) ||
      normalizedProjectPath.startsWith(`${normalizedPath}/`)
    )
  }

  const safeExtraWritablePaths = extraWritablePaths.filter((path) => !overlapsProject(path))

  for (const path of safeExtraWritablePaths) {
    args.push('--bind', path, path)
  }

  args.push('--bind', worktreePath, worktreePath, '--chdir', worktreePath, '--')
  return args
}
