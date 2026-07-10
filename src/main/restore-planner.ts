import type { ConnectionState, SessionStatus } from '../shared/types'

// Local environment facts consulted when restoring a session from disk. Remote
// sessions ignore all three (they materialize lazily with no local tmux or
// worktree), so `deriveRestoredState` only reads these for local sessions.
export interface RestoreEnv {
  // A live local tmux session with the session's id already exists.
  hasLiveTmux: boolean
  // The session's worktree directory still exists on disk.
  worktreeExists: boolean
  // The tmux binary is on PATH (checked once per restore to avoid a modal storm).
  tmuxAvailable: boolean
}

// Classifies the restore decision so the IO loop can drive side effects
// (reattach a pty, bump counters) and diagnostics without re-deriving the rule.
export type RestoreOutcome =
  // Remote session materialized as pending, awaiting first connection.
  | 'remote-pending'
  // Remote session left dead — the remote tmux is confirmed gone.
  | 'remote-dead'
  // Remote terminal (completed/error) session — finished, restored as 'live' so
  // it isn't lazily reconnected/probed (which would flip it back to 'dead').
  | 'remote-terminal'
  // Local session with a live tmux — reattach its pty in place.
  | 'reattach'
  // Local session deferred to lazy restore (pending) to avoid up-front spawn cost.
  | 'defer'
  // Local session killed because its worktree is gone.
  | 'dead-no-worktree'
  // Local session killed because tmux is unavailable.
  | 'dead-no-tmux'
  // Local terminal (completed/error) session whose tmux is gone.
  | 'terminal-dead'
  // Local terminal session whose tmux is still alive — left untouched.
  | 'terminal-alive'
  // Local session in a state we don't recover (e.g. already dead) — left as-is.
  | 'inactive'

export interface DerivedRestoreState {
  status: SessionStatus
  connectionState: ConnectionState | undefined
  outcome: RestoreOutcome
}

// Pure decision core extracted from `restoreSessions`. Given a persisted
// session's status/host and the local environment facts, compute the status,
// connectionState, and an outcome tag — without any IO or mutation. Callers
// apply the result and perform the IO (pty reattach, path canonicalization,
// backfill) themselves.
export function deriveRestoredState(
  session: { status: SessionStatus; hostId: string | null; connectionState?: ConnectionState },
  env: RestoreEnv
): DerivedRestoreState {
  if (session.hostId) {
    // Lazy restore: a remote session materializes in `pending` until the first
    // click opens the host's SSH control connection. `running` → `idle` mirrors
    // the local resumed-status mapping; a persisted `dead` means the remote tmux
    // is confirmed gone, so there is nothing to reconnect to — keep whatever
    // connectionState was persisted (e.g. 'offline') rather than forcing it.
    const status = session.status === 'running' ? 'idle' : session.status
    if (status === 'dead') {
      return { status, connectionState: session.connectionState, outcome: 'remote-dead' }
    }
    if (status === 'completed' || status === 'error') {
      // A finished remote session (e.g. one kept via promptCleanup) must not be
      // lazily restored as 'pending': that renders DetailPane's "Connecting…"
      // overlay and invites the first-open/batch reconnect probe to flip it back
      // to 'dead', silently undoing Keep. Restore it 'live' — the terminal state
      // an in-session completion lands in — so it reads as done and offers no
      // reconnect affordance.
      return { status, connectionState: 'live', outcome: 'remote-terminal' }
    }
    return { status, connectionState: 'pending', outcome: 'remote-pending' }
  }

  if (
    session.status === 'running' ||
    session.status === 'idle' ||
    session.status === 'needs_input'
  ) {
    // Preserve `needs_input` so the tray/status-bar attention signals survive a
    // restart — claude --continue resumes mid-wait, so the user still needs to
    // answer. Everything else resumes as `idle`.
    const resumedStatus: SessionStatus = session.status === 'needs_input' ? 'needs_input' : 'idle'
    if (env.hasLiveTmux) {
      return { status: resumedStatus, connectionState: undefined, outcome: 'reattach' }
    }
    if (!env.worktreeExists) {
      return { status: 'dead', connectionState: undefined, outcome: 'dead-no-worktree' }
    }
    if (!env.tmuxAvailable) {
      return { status: 'dead', connectionState: undefined, outcome: 'dead-no-tmux' }
    }
    // Lazy restore (mirrors the remote arm): mark pending and defer the tmux +
    // agent spawn until the user opens the card. Spawning all persisted sessions
    // up front cost ~1 GB each and OOM'd the box when many sessions existed.
    return { status: resumedStatus, connectionState: 'pending', outcome: 'defer' }
  }

  if (session.status === 'completed' || session.status === 'error') {
    // Terminal states: if the tmux session is gone, the card shouldn't claim the
    // session is still alive. Don't auto-recover — the conversation already ended.
    if (!env.hasLiveTmux) {
      return { status: 'dead', connectionState: undefined, outcome: 'terminal-dead' }
    }
    return { status: session.status, connectionState: undefined, outcome: 'terminal-alive' }
  }

  // Any other persisted status (e.g. already `dead`): leave as-is, with the
  // persisted connectionState dropped.
  return { status: session.status, connectionState: undefined, outcome: 'inactive' }
}
