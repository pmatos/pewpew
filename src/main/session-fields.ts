import type { AgentTool } from '../shared/types'
import { parseIssueNumber, parsePrNumber, worktreeBranchName } from './branch-naming'

// The persisted fields `deriveSessionFields` reads. `tool` is optional here (not
// on the full `Session` type) because legacy sessions written before the
// multi-agent change omit it — reconciling that gap is one of this module's jobs.
export interface PersistedSessionFields {
  branch: string
  worktreeName: string
  projectName: string
  issueNumber?: number
  prNumber?: number
  tool?: AgentTool
}

// Environment facts the caller resolves via IO before deriving fields.
export interface DerivedFieldsEnv {
  // For a LOCAL session whose worktree exists on this machine, the branch read
  // live from git (already falling back to the conventional name). `undefined`
  // for remote sessions or when the local worktree is absent — those keep their
  // persisted branch, or fall back to the conventional name when it's empty.
  resolvedLocalBranch: string | undefined
}

export interface DerivedFields {
  branch: string
  issueNumber: number | undefined
  prNumber: number | undefined
  tool: AgentTool
}

// Pure decision core extracted from `session-manager`'s `backfillDerivedFields`.
// Given a persisted session's fields and the resolved local branch, compute the
// reconciled branch / issueNumber / prNumber / tool — without any IO or
// mutation. Callers apply the result. The live git branch of a local worktree
// trumps whatever was persisted (self-healing an earlier version's wrong
// default); remote sessions can't reach git without SSH, so they keep the
// persisted branch and only fall back when it's missing.
export function deriveSessionFields(
  session: PersistedSessionFields,
  env: DerivedFieldsEnv
): DerivedFields {
  const branch =
    env.resolvedLocalBranch !== undefined
      ? env.resolvedLocalBranch
      : session.branch || worktreeBranchName(session.projectName, session.worktreeName)

  return {
    branch,
    issueNumber: session.issueNumber ?? parseIssueNumber(session.worktreeName, branch),
    prNumber: session.prNumber ?? parsePrNumber(session.worktreeName),
    tool: session.tool || 'claude',
  }
}
