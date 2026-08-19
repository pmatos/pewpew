import type { AgentTool, Session } from '../shared/types'

// Everything `buildSession` needs, already resolved by the caller: no IO, no
// clock, no path normalization. `now` is injected so the factory stays pure;
// `worktreePath` is passed verbatim (callers decide whether to canonicalize).
export interface SessionRecordInput {
  id: string
  hostId: string | null
  projectPath: string
  projectName: string
  worktreeName: string
  worktreePath: string
  branch: string
  tool: AgentTool
  sandboxed: boolean
  now: number
  issueNumber?: number
  prNumber?: number
  prIsFork?: boolean
  prHeadRepo?: string
  repoFingerprint?: string
}

// Assemble a freshly-spawned session. This is the single policy site for the
// shape of a new `Session`, replacing five near-identical object literals in
// `session-manager`. The returned object is plainly mutable on purpose:
// callers register it and then patch fields in place (async repoFingerprint,
// PR/issue numbers resolved after the fact).
export function buildSession(input: SessionRecordInput): Session {
  const session: Session = {
    id: input.id,
    hostId: input.hostId,
    projectPath: input.projectPath,
    projectName: input.projectName,
    worktreeName: input.worktreeName,
    worktreePath: input.worktreePath,
    branch: input.branch,
    issueNumber: input.issueNumber,
    pid: 0,
    tmuxSession: `pewpew-${input.id}`,
    status: 'running',
    lastActivity: input.now,
    hookEvents: [],
    tool: input.tool,
    sandboxed: input.sandboxed,
  }
  // A remote session opens with a live SSH connection; a local one has no
  // connection state at all. Deriving the key from hostId is the invariant.
  if (input.hostId !== null) session.connectionState = 'live'
  if (input.repoFingerprint) session.repoFingerprint = input.repoFingerprint
  if (input.prNumber !== undefined) session.prNumber = input.prNumber
  if (input.prIsFork !== undefined) session.prIsFork = input.prIsFork
  if (input.prHeadRepo !== undefined) session.prHeadRepo = input.prHeadRepo
  return session
}
