import { basename, join } from 'path'
import type { Session } from '../shared/types'

// The relocation target: where a local project is moving to, plus the
// canonicalized old managed-worktree root the caller precomputes so this planner
// stays pure.
export interface RelocationTarget {
  oldProjectPath: string
  newProjectPath: string
  // `<oldProjectPath>/.claude/worktrees/` after canonicalization, WITH a trailing
  // path separator. Session worktreePaths are stored canonical, so managed
  // worktrees are matched against this canonical prefix; the trailing separator
  // stops a sibling like `.../worktrees-backup/…` from matching.
  oldManagedRoot: string
}

// One session's remapped identity after a project relocation. The caller applies
// these fields and performs the side effects (repoFingerprint, PTY recreation,
// status) itself.
export interface RelocationRemap {
  id: string
  projectPath: string
  projectName: string
  worktreePath: string
}

// Pure decision core extracted from `relocateProject`. Selects the local sessions
// belonging to the old project and computes their new project path/name and
// worktree path — without any I/O or mutation.
//
// Only managed worktrees living under the old project's `.claude/worktrees` tree
// are re-rooted, preserving the exact subpath (worktreeName may be a branch label
// like `<project>/feat-x` that doesn't match the on-disk dirname). External
// mirrored paths, and remote sessions, are left untouched.
export function planRelocation(
  sessions: Iterable<Session>,
  target: RelocationTarget
): RelocationRemap[] {
  const { oldProjectPath, newProjectPath, oldManagedRoot } = target
  const projectName = basename(newProjectPath)
  const remaps: RelocationRemap[] = []

  for (const session of sessions) {
    if (session.hostId !== null || session.projectPath !== oldProjectPath) continue

    const worktreePath = session.worktreePath.startsWith(oldManagedRoot)
      ? join(
          newProjectPath,
          '.claude',
          'worktrees',
          session.worktreePath.slice(oldManagedRoot.length)
        )
      : session.worktreePath

    remaps.push({ id: session.id, projectPath: newProjectPath, projectName, worktreePath })
  }

  return remaps
}
