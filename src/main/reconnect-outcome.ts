import type { ConnectionState, SessionStatus } from '../shared/types'
import type { AttemptOutcome } from './reconnect-scheduler'

// The single side effect `attemptAutoReconnect` must realize for a classified
// result. The caller owns the I/O (formatting the toast with the host label,
// firing the fire-and-forget cleanup dialog); this module only names which one.
export type ReconnectEffect = 'none' | 'toast-reconnected' | 'prompt-cleanup' | 'toast-auth-failed'

export interface AutoReconnectClassification {
  outcome: AttemptOutcome
  effect: ReconnectEffect
}

// Pure decision core extracted from `attemptAutoReconnect`. Given the session
// state observed *after* the probe reconnect returns, map it to a scheduler
// outcome plus the one side effect the caller must realize. The branch order is
// load-bearing and mirrors the original inline sequence:
//
//   1. Already terminal (completed/error): the session resolved to a Keep while
//      the probe was in flight — give up silently, no toast, no cleanup.
//   2. Connection went live: reattached — recovered, toast "Reconnected".
//   3. Status went dead: the remote confirmed the agent ended — prompt the same
//      cleanup dialog a local session gets on exit (fire-and-forget at the site).
//   4. Auth failed: unrecoverable without user action — give up with a toast.
//   5. Otherwise (e.g. still unreachable): the remote may be up — retry.
//
// This function performs no I/O and no mutation; the caller owns `emitToast`,
// `promptCleanup`, and formatting the host label into the toast titles.
export function classifyAutoReconnectResult(after: {
  status: SessionStatus
  connectionState: ConnectionState | undefined
}): AutoReconnectClassification {
  if (after.status === 'completed' || after.status === 'error') {
    return { outcome: 'gave-up', effect: 'none' }
  }
  if (after.connectionState === 'live') {
    return { outcome: 'recovered', effect: 'toast-reconnected' }
  }
  if (after.status === 'dead') {
    return { outcome: 'gave-up', effect: 'prompt-cleanup' }
  }
  if (after.connectionState === 'auth-failed') {
    return { outcome: 'gave-up', effect: 'toast-auth-failed' }
  }
  return { outcome: 'retry', effect: 'none' }
}
