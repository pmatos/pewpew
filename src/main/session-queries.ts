import type { AgentTool, Session } from '../shared/types'

// Pure lookups over the live session set. session-manager.ts owns the session
// registry (a Map) and its mutations; the "is a session already occupying X?"
// question is asked from a dozen call sites with subtly different rules — host
// scoping, exact vs. canonical path comparison, whether a tool mismatch is an
// error. Concentrating those queries here keeps each rule stated once and makes
// them testable without standing up the whole manager.

type Canonicalize = (path: string) => string

// Exact, host-scoped occupancy. `hostId === null` scopes to local sessions; a
// string scopes to that remote host. Paths are compared verbatim.
export function findSessionOnWorktree(
  sessions: Iterable<Session>,
  hostId: string | null,
  worktreePath: string
): Session | undefined {
  for (const session of sessions) {
    if (session.hostId === hostId && session.worktreePath === worktreePath) return session
  }
  return undefined
}

// Canonical, un-scoped occupancy: matches any session (local or remote) whose
// worktree path resolves to the same location. Used by the local adopt path,
// where a symlinked worktree must resolve to the single session that owns it.
export function findSessionOnCanonicalWorktree(
  sessions: Iterable<Session>,
  worktreePath: string,
  canonicalize: Canonicalize
): Session | undefined {
  const target = canonicalize(worktreePath)
  for (const session of sessions) {
    if (canonicalize(session.worktreePath) === target) return session
  }
  return undefined
}

// Guards the "one agent tool per worktree" invariant. Throws when the session
// already living on a worktree uses a different tool than the one requested.
export function assertToolCompatible(existing: Session, tool: AgentTool): void {
  if (existing.tool !== tool) {
    throw new Error(
      `Worktree already has a ${existing.tool} session; mixed tools per worktree are not supported`
    )
  }
}

// Canonicalized worktree paths across every session — the local mirror's
// "already adopted" set.
export function occupiedWorktreePaths(
  sessions: Iterable<Session>,
  canonicalize: Canonicalize
): Set<string> {
  const paths = new Set<string>()
  for (const session of sessions) paths.add(canonicalize(session.worktreePath))
  return paths
}

// Raw worktree paths for the sessions on a given host — the remote mirror's
// "already adopted" set. Remote paths are opaque to the local filesystem, so
// they are never canonicalized.
export function worktreePathsForHost(sessions: Iterable<Session>, hostId: string): Set<string> {
  const paths = new Set<string>()
  for (const session of sessions) {
    if (session.hostId === hostId) paths.add(session.worktreePath)
  }
  return paths
}

export function findSessionByBranch(
  sessions: Iterable<Session>,
  projectPath: string,
  hostId: string | null,
  branch: string
): Session | undefined {
  for (const session of sessions) {
    if (
      session.hostId === hostId &&
      session.projectPath === projectPath &&
      session.branch === branch
    ) {
      return session
    }
  }
  return undefined
}

export function findSessionByPrNumber(
  sessions: Iterable<Session>,
  projectPath: string,
  hostId: string | null,
  prNumber: number
): Session | undefined {
  for (const session of sessions) {
    if (
      session.hostId === hostId &&
      session.projectPath === projectPath &&
      session.prNumber === prNumber
    ) {
      return session
    }
  }
  return undefined
}
