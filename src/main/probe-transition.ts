import type { RemoteTmuxProbeResult } from './pty-manager'
import type { ConnectionState, SessionStatus } from '../shared/types'

// The field delta a tmux probe result applies to a remote session. Sparse: only
// the keys the probe actually changes are present, so callers apply it over the
// live session and untouched fields (status/lastActivity on an 'unreachable'
// probe) are preserved rather than clobbered.
export interface ProbeTransition {
  connectionState: ConnectionState
  status?: SessionStatus
  lastActivity?: number
  reattach?: boolean
}

// Pure decision core shared by the manual reconnect (`doReconnectRemoteSession`)
// and the pending-batch probe (`doProbePendingSessionsOnHost`). Given a session's
// current status and a tmux probe result, derive the field delta to apply — or
// `null` when the session already resolved to a terminal state (completed/error)
// and the probe result must be ignored, so a late 'absent' can't revert a session
// the user chose to keep back to 'dead'.
//
// The caller owns the side effects: reattaching the PTY (when `reattach` is set,
// before applying the delta so a reattach failure leaves fields untouched),
// broadcasting via `onSessionsChanged`, and — in the batch site — bailing out on
// an 'unreachable' result. This function performs no I/O and no mutation.
export function computeProbeTransition(
  status: SessionStatus,
  probe: RemoteTmuxProbeResult,
  now: number
): ProbeTransition | null {
  if (status === 'completed' || status === 'error') return null
  switch (probe) {
    case 'present':
      // Reattach and go live. Only a `running` session collapses to `idle`; an
      // idle/needs_input session keeps its status so a reattach never rewrites a
      // session that was already waiting on the user.
      return {
        connectionState: 'live',
        ...(status === 'running' ? { status: 'idle' } : {}),
        lastActivity: now,
        reattach: true,
      }
    case 'absent':
      // Remote confirmed the tmux session is gone — mark dead. The user can
      // "Restart terminal" (reviveSession) to spawn a fresh one.
      return { connectionState: 'offline', status: 'dead', lastActivity: now }
    case 'unreachable':
      // SSH-level failure probing an otherwise-live connection. Do NOT mark dead:
      // the remote agent may still be running, so leave status/lastActivity intact
      // and let the user retry.
      return { connectionState: 'unreachable' }
  }
}

// Apply a probe transition's sparse delta to a session in place. Only the keys
// present on the transition are written, mirroring the per-branch field
// assignments the two probe sites previously duplicated inline.
export function applyProbeTransition(
  session: { connectionState?: ConnectionState; status: SessionStatus; lastActivity: number },
  transition: ProbeTransition
): void {
  session.connectionState = transition.connectionState
  if (transition.status !== undefined) session.status = transition.status
  if (transition.lastActivity !== undefined) session.lastActivity = transition.lastActivity
}
