import type { Session } from './types'

type StatusFields = Pick<Session, 'status' | 'hostId'>

// 'completed'/'error' are terminal: the user has made a cleanup decision (or the
// session errored), so no probe/reattach path may touch them — probing one would
// find its tmux gone and flip it to 'dead', silently reverting a Keep.
export const isTerminalStatus = (status: Session['status']): boolean =>
  status === 'completed' || status === 'error'

// A local session that finished (or was Kept) and can be resumed. Remote
// completed/error stay excluded: they're pinned to a terminal 'live' state on
// purpose, with no reconnect path.
export const isRestartableFinished = (session: StatusFields): boolean =>
  !session.hostId && isTerminalStatus(session.status)

// Sessions "Restart" can bring back. Dead ones have their own restart UI; a
// tmux server kill or a Keep on the cleanup dialog must not strand a resumable
// conversation, hence local finished sessions qualify too.
export const isRestartable = (session: StatusFields): boolean =>
  session.status === 'dead' || isRestartableFinished(session)
