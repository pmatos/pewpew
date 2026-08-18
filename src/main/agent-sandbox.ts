// Pure derivation of the bubblewrap argv prefix that confines an agent
// process to its session worktree. Used for codex and omp, both of which run
// with their own approval checks bypassed (--dangerously-bypass-approvals-
// and-sandbox / --auto-approve), so pewpew owns this write boundary itself at
// the tmux spawn layer instead. claude does NOT go through this module — it
// runs under --permission-mode=auto instead (see buildAgentArgs in
// pty-manager.ts), relying on that mode's own approval gating plus the
// worktree guard hook (host-bootstrap.ts) rather than an OS-level sandbox.
// Kept free of fs/child_process so bind order (see below) can be asserted
// directly in unit tests.
//
// The host filesystem is read-only by default (--ro-bind / /) — Bash writes
// to anything outside the explicit writable mounts below (a sibling repo,
// ~/.bashrc, SSH keys, another worktree) resolve EROFS. This is narrower
// than the project tree alone: it's the actual containment boundary, not
// just a documentation note about one.
//
// This is a WRITE/PERSISTENCE boundary only, not a confidentiality or
// network one: the sandboxed process still has read access to the entire
// host filesystem (other repos, SSH keys, cloud credentials, etc.), and
// there's no --unshare-net/--unshare-user, so network egress is
// unrestricted. A compromised or prompt-injected agent can still read and
// exfiltrate host secrets even though it can't write outside its worktree —
// that's an explicitly accepted trade-off, not an oversight.
//
// PID namespace IS unshared (--unshare-pid before --proc): mounting a fresh
// procfs without it would still populate from the host's shared pid
// namespace, making every host process visible, and — on a host with
// kernel.yama.ptrace_scope=0 (unrestricted; 1/"restricted" is only a distro
// default, not a guarantee) — reachable via /proc/<host-pid>/root, which
// resolves through THAT process's own mount namespace and bypasses the
// --ro-bind / / restriction entirely. Verified empirically with real bwrap:
// with only --proc (no --unshare-pid), 729 host PIDs were visible from
// inside the sandbox; with --unshare-pid added, only the sandbox's own
// process tree (5 entries) is visible, and worktree writes, git operations,
// and /tmp scratch space all continue to work normally.
//
// Verified against real bwrap (originally with the claude CLI, back when
// claude also ran through this module): a write to <project>, a sibling
// worktree, or an arbitrary host path (e.g. $HOME) resolves EROFS from both
// an agent's file-edit tool and Bash, while worktree writes, `npm ci`,
// `git add`/`commit`, and `git config --local` all succeed.
//
// Bind order is load-bearing — later binds override earlier ones:
//   1. --ro-bind / /                       host filesystem, read-only
//   2. --dev /dev                          minimal, safe device nodes
//   3. --unshare-pid                       fresh pid namespace — must precede
//      --proc below, or the procfs it mounts still reflects the shared host
//      pid namespace instead of this one
//   4. --proc /proc                        fresh procfs, scoped to the
//      unshared pid namespace above
//   5. --tmpfs /tmp                        session-scoped scratch space
//      (build tools, npm, editors all assume /tmp is writable; a fresh
//      tmpfs keeps it isolated from the host's /tmp and other sessions')
//   6. --ro-bind <project> <project>       lock the project root read-only
//      (redundant with step 1 but kept explicit — the project's own
//      protection shouldn't depend on the root strategy staying this way)
//   7. --bind <project>/.git <project>/.git    ...except the shared .git,
//      writable again (git commit/checkout need it for the linked worktree)
//   8. --ro-bind-try <project>/.git/hooks ...  ...except hooks/, which stays
//      read-only (kills the code-exec-persistence path through .git/hooks).
//      "-try" degrades gracefully when hooks/ doesn't exist (e.g. a repo with
//      core.hooksPath pointed elsewhere) instead of hard-failing bwrap's spawn.
//   9. extra caller-granted writable paths — any path that equals, is
//      nested under, or is an ancestor of <project> is dropped, since it
//      would re-open the read-only guarantees from steps 1 and 6-8. Uses
//      --bind-try: a --bind of a source that doesn't exist makes bwrap exit
//      before the agent ever runs, which is worse than not granting the path.
//   10. extra caller-granted read-only paths — emitted after writable
//      exceptions so a path granted in both lists remains read-only.
//   11. --bind <worktree> <worktree>       the session's own worktree, r/w
//   12. --ro-bind-try <worktree>/.claude/settings.local.json  close the one
//      file back up: without this, Bash inside the sandbox (which the worktree
//      bind at step 11 left read-write) could overwrite its own guard-hook
//      settings and disarm the PreToolUse guard for the next session. -try
//      because the file may not exist yet on a session's first ever spawn.
//   13. --chdir <worktree> --              land in the worktree; `--`
//      separates bwrap's own options from the command to run inside it
//
// Deliberately NOT ro-binding <project>/.git/config: that breaks `git config
// --local` with "Device or resource busy", which fails husky-style `prepare`
// scripts during `npm ci` — every session would die at install.

import { normalize } from 'node:path'

// normalize() alone doesn't strip a trailing separator, so a projectPath of
// "/foo/bar/" would leave `${normalizedProjectPath}/` as a double slash that
// a legitimately-nested single-slash path wouldn't match. Every comparison
// in this file goes through this helper instead of bare normalize().
const normalizePath = (path: string): string => {
  const normalized = normalize(path)
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

export interface SandboxOptions {
  enabled?: boolean
  // Must already be fully resolved (no `~`, which bwrap does not expand) and
  // absolute. Sources that don't exist are silently skipped via --bind-try
  // rather than crashing the sandbox.
  extraWritablePaths?: string[]
  // Read-only host paths that must remain visible after mounts such as the
  // private /tmp tmpfs. Emitted after writable exceptions so a duplicated
  // path cannot accidentally become writable.
  extraReadOnlyPaths?: string[]
  // Real .git directory for the project root. Defaults to `<projectPath>/.git`
  // which is correct for a standard worktree. A gitfile root (a submodule or
  // linked worktree whose `.git` is a *file* like `gitdir: /path/to/real/.git`,
  // not a directory) must pass the resolved real git dir here instead — bwrap
  // can't bind a file as a directory mount, and `git commit/checkout` need the
  // real dir writable. Callers resolve this via `git rev-parse --git-common-dir`
  // (local) or the remote equivalent before calling buildSandboxArgs.
  gitDir?: string
}

export function buildSandboxArgs(
  projectPath: string,
  worktreePath: string,
  opts: SandboxOptions = {}
): string[] {
  const { enabled = true, extraWritablePaths = [], extraReadOnlyPaths = [], gitDir } = opts
  if (!enabled) return []

  // Nothing to confine to when the "worktree" IS the project root (e.g. a
  // session opened directly on the main checkout rather than a linked
  // worktree) — there's no narrower boundary to enforce. Normalized: an
  // unnormalized comparison here would miss equivalent non-canonical forms
  // (trailing slash, "./") and fall through to emitting both a read-only
  // and a read-write bind for the same directory, with the read-write one
  // winning — silently making the entire project writable.
  if (normalizePath(worktreePath) === normalizePath(projectPath)) return []

  // Resolve the real .git directory. A gitfile root (submodule or linked
  // worktree whose `.git` is a file, not a directory) must pass gitDir
  // explicitly — bwrap can't bind a file as a directory mount.
  const realGitDir = gitDir ?? `${projectPath}/.git`

  const args = [
    'bwrap',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--unshare-pid',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--ro-bind',
    projectPath,
    projectPath,
    '--bind',
    realGitDir,
    realGitDir,
    '--ro-bind-try',
    `${realGitDir}/hooks`,
    `${realGitDir}/hooks`,
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
  const normalizedProjectPath = normalizePath(projectPath)

  const overlapsProject = (path: string): boolean => {
    const normalizedPath = normalizePath(path)
    return (
      normalizedPath === normalizedProjectPath ||
      normalizedPath === '/' ||
      normalizedPath.startsWith(`${normalizedProjectPath}/`) ||
      normalizedProjectPath.startsWith(`${normalizedPath}/`)
    )
  }

  const safeExtraWritablePaths = extraWritablePaths.filter((path) => !overlapsProject(path))
  const safeExtraReadOnlyPaths = extraReadOnlyPaths.filter((path) => !overlapsProject(path))

  for (const path of safeExtraWritablePaths) {
    args.push('--bind-try', path, path)
  }
  for (const path of safeExtraReadOnlyPaths) {
    args.push('--ro-bind-try', path, path)
  }

  args.push(
    '--bind',
    worktreePath,
    worktreePath,
    '--ro-bind-try',
    `${worktreePath}/.claude/settings.local.json`,
    `${worktreePath}/.claude/settings.local.json`,
    '--chdir',
    worktreePath,
    '--'
  )
  return args
}
