import type { Host, Session, ToastEvent } from '../shared/types'
import type { HostConnectionState } from './host-connection'
import type { PreparedRemoteHostLease } from './remote-host-runtime'
import type { RemoteTmuxProbeResult } from './pty-manager'
import type { AttemptOutcome } from './reconnect-scheduler'
import { applyProbeTransition, computeProbeTransition } from './probe-transition'
import { classifyAutoReconnectResult } from './reconnect-outcome'

// Read/notify slice of the session registry. CONTRACT: `get`/`values` return the
// registry's own *live, mutable* Session objects, never copies — the coordinator
// writes `connectionState`/`status` in place (directly and via applyProbeTransition)
// and re-reads `session.status` *after* the reattach await, so a concurrent
// session.end → Keep that lands during the await is observed on the same object.
// `changed()` persists + broadcasts. This is the seam `session-store` will
// implement; a store that returned copies would silently break that re-read.
export interface SessionLookup {
  get(id: string): Session | undefined
  values(): Iterable<Session>
  changed(): void
}

// The remote host: its config, its live ControlMaster connection state, and
// acquiring a prepared lease. `acquireLease` retains the ControlMaster; its
// rejection may carry a `hostConnectionState` (see HostConnectionTaggedError).
// `runtimeState` is a call-time oracle — read repeatedly, its value changes
// across a single reconnect.
export interface RemoteHost {
  get(hostId: string): Host | undefined
  runtimeState(hostId: string): HostConnectionState | undefined
  acquireLease(host: Host): Promise<PreparedRemoteHostLease>
}

// Per-session remote terminal transport, carried over the ControlMaster the lease
// keeps alive. `hasPty` is a call-time check of the local attach state.
export interface RemoteTerminal {
  probe(id: string, host: Host): Promise<RemoteTmuxProbeResult>
  reattach(id: string, host: Host): Promise<void>
  hasPty(id: string): boolean
}

// User-facing side effects the classified auto-reconnect outcomes realize.
export interface UserFeedback {
  toast(event: Omit<ToastEvent, 'id'> & { id?: string }): void
  promptCleanup(id: string): Promise<void>
}

export interface RemoteReconnectDeps {
  sessions: SessionLookup
  host: RemoteHost
  terminal: RemoteTerminal
  feedback: UserFeedback
  // Ambient clock, injected so probe-transition timestamps are deterministic in
  // tests. Defaults to Date.now.
  now?: () => number
}

// A rejection from acquireLease/probe/reattach may carry the connection state
// remote-host-runtime captured before stopHostConnection wiped the runtime entry.
// The coordinator reads it to classify auth-failed vs unreachable without
// re-parsing stderr.
type HostConnectionTaggedError = { hostConnectionState?: HostConnectionState }

interface ReconnectOutcome {
  state: HostConnectionState | undefined
  lease: PreparedRemoteHostLease
}

export interface RemoteReconnectCoordinator {
  reconnectRemoteSession(id: string): Promise<void>
  attemptAutoReconnect(id: string): Promise<AttemptOutcome>
  probePendingSessionsOnHost(hostId: string, stateHint?: HostConnectionState): Promise<void>
}

// Coordinates remote-session reconnect/probe: two coalescing maps, the
// prepared-host lease lifecycle, and the probe→transition→reattach orchestration,
// all behind three methods. Extracted from session-manager; the pure decision
// cores (probe-transition, reconnect-outcome) are imported directly, every
// stateful/effectful collaborator is an injected port.
export function createRemoteReconnectCoordinator(
  deps: RemoteReconnectDeps
): RemoteReconnectCoordinator {
  const { sessions, host, terminal, feedback } = deps
  const now = deps.now ?? Date.now

  // In-flight reconnect promises keyed by session id. Two concurrent clicks on
  // the same pending card (fast double-click, or a click that races the
  // auto-fired batch probe) coalesce into one SSH attempt.
  const inflightReconnects = new Map<string, Promise<ReconnectOutcome>>()

  // Eager batch probe for remaining `pending` sessions on a host that just
  // became live. Runs `tmux has-session` per sibling over the live ControlMaster
  // (no new SSH handshakes). If the runtime state is `auth-failed` /
  // `unreachable` we short-circuit: all siblings inherit that state without any
  // network I/O, satisfying spec AC #8 "auth failures transition directly to
  // host-auth-failed with no further attempts".
  const inflightBatchProbes = new Map<string, Promise<void>>()

  // Probe-only reconnect for a remote session. If the remote tmux session is
  // present we reattach and mark `live`; if it is gone we mark the session
  // `dead` (matches issue #12 AC #4: "either reattach the PTY or marks the
  // session dead"). Creating a fresh remote tmux session is `reviveSession`'s
  // job — that requires explicit user intent ("Restart terminal" on dead).
  //
  // On SSH failure we classify via the host runtime state (set by
  // host-connection's `startRuntime` before ensureHostConnection rejects), so
  // auth-failed vs. network-unreachable get distinct UI states without
  // re-parsing stderr.
  async function reconnectRemoteSession(id: string): Promise<void> {
    // A terminal session is done — never re-probe/reconnect it. attemptAutoReconnect
    // already bails on 'completed'/'error' before calling; guard the manual/IPC entry
    // point too, so triggering Reconnect on a kept ('completed') or errored session
    // can't probe-and-flip it back to 'dead', silently undoing the user's Keep.
    // Defense-in-depth: deriveRestoredState now restores terminal remotes as 'live'
    // (not 'pending'), so the UI no longer offers Reconnect for them — but this keeps
    // any other caller that reaches here with a stale non-live terminal session a
    // no-op. Mirrors the status guard in attemptAutoReconnect.
    const current = sessions.get(id)
    if (current && (current.status === 'completed' || current.status === 'error')) return

    const existing = inflightReconnects.get(id)
    if (existing) {
      await existing
      return
    }

    // Capture hostId BEFORE the await: if `removeSession(id)` runs while this
    // reconnect is in flight, `sessions.get(id)` would return undefined after
    // the await and we'd neither release the host retain nor run the sibling
    // batch — leaking the ControlMaster for the lifetime of the app.
    const initialHostId = sessions.get(id)?.hostId ?? null

    const promise = doReconnectRemoteSession(id)
    inflightReconnects.set(id, promise)
    let reconnectError: unknown = undefined
    let outcome: ReconnectOutcome | undefined
    try {
      outcome = await promise
    } catch (err) {
      reconnectError = err
    } finally {
      inflightReconnects.delete(id)
    }
    const successState = outcome?.state
    const leaseForBatch = outcome?.lease
    // Fire-and-forget the sibling batch probe — the caller should not block on
    // it. `probePendingSessionsOnHost` is idempotent so concurrent clicks on
    // multiple cards of the same host still collapse to a single batch.
    //
    // Always attempt the batch probe, even when the clicked reconnect rejected:
    // - on success (runtime was `live`), we reconcile siblings over the
    //   now-live ControlMaster
    // - on auth-failed / unreachable, the batch's short-circuit cascades that
    //   state to every pending sibling without any new SSH I/O (spec AC #8)
    //
    // Skip only when there's no host at all (orphaned hostId / missing registry
    // entry) or we couldn't determine any state — there's nothing to probe.
    const hostId = sessions.get(id)?.hostId ?? initialHostId
    const tagged = (reconnectError as HostConnectionTaggedError | null)?.hostConnectionState
    const stateHint = successState ?? tagged ?? (hostId ? host.runtimeState(hostId) : undefined)
    if (hostId && stateHint) {
      // Fire-and-forget: user's first click should not wait for sibling
      // reconciliation. The prepared-host lease is released after the batch,
      // keeping the ControlMaster alive while siblings reuse one SSH handshake.
      ;(async () => {
        try {
          await probePendingSessionsOnHost(hostId, stateHint)
        } catch (err) {
          console.error(`probePendingSessionsOnHost(${hostId}) failed:`, err)
        } finally {
          await leaseForBatch?.release()
        }
      })()
    } else {
      await leaseForBatch?.release()
    }
    if (reconnectError !== undefined) throw reconnectError
  }

  async function doReconnectRemoteSession(id: string): Promise<ReconnectOutcome> {
    const session = sessions.get(id)
    if (!session) throw new Error(`Session ${id} not found`)
    if (!session.hostId) {
      throw new Error(`Session ${id} is not a remote session`)
    }
    const hostId = session.hostId
    const h = host.get(hostId)
    if (!h) {
      session.connectionState = 'unreachable'
      sessions.changed()
      throw new Error(`Host configuration for "${hostId}" was removed`)
    }
    session.connectionState = 'connecting'
    sessions.changed()

    let lease: PreparedRemoteHostLease | null = null
    try {
      lease = await host.acquireLease(h)
      const probe = await terminal.probe(id, h)
      // Pure decision core in probe-transition.ts. `null` = the session resolved to
      // a terminal state while this probe was in flight (e.g. a delayed session.end
      // hook drove promptCleanup and the user chose Keep). Applying the probe result
      // now would clobber that decision ('absent' → 'dead'), re-exposing cleanup and
      // risking deletion of the kept worktree. Leave it untouched; the lease is still
      // returned below so the caller reconciles/releases it.
      let transition = computeProbeTransition(session.status, probe, now())
      if (transition?.reattach) {
        // Reattach before applying the delta so a reattach failure leaves the
        // session's fields untouched and falls through to the catch below. The
        // reattach await is a real window in which a concurrent session.end → Keep
        // can drive status to terminal, so re-derive against the now-current status:
        // a stale 'running → idle' delta must not revert a session the user kept.
        await terminal.reattach(id, h)
        transition = computeProbeTransition(session.status, probe, now())
      }
      if (transition) {
        applyProbeTransition(session, transition)
        sessions.changed()
      }
    } catch (err) {
      // Prefer the state captured by remote-host-runtime (attached to the error
      // before stopHostConnection wipes the runtime entry). Fall back to the
      // live runtime when the failure happened after the host was prepared
      // (e.g. bootstrap / PTY attach step).
      const tagged = (err as HostConnectionTaggedError | null)?.hostConnectionState
      const runtimeState = tagged ?? host.runtimeState(hostId)
      if (runtimeState === 'auth-failed') {
        session.connectionState = 'auth-failed'
      } else if (runtimeState === 'unreachable') {
        session.connectionState = 'unreachable'
      } else {
        session.connectionState = 'offline'
      }
      sessions.changed()
      await lease?.release()
      throw err
    }
    const finalState = host.runtimeState(hostId)
    if (!lease) throw new Error(`Session ${id} did not acquire a remote host lease`)
    return { state: finalState, lease }
  }

  // One auto-reconnect attempt for a remote session that dropped. Delegates to
  // the manual reconnect (so we inherit its probe/reattach, concurrency
  // coalescing, sibling batch, and auth classification) and maps the resulting
  // session state to a scheduler outcome. The scheduler owns the backoff loop.
  async function attemptAutoReconnect(id: string): Promise<AttemptOutcome> {
    const session = sessions.get(id)
    if (!session) return 'gave-up'
    if (!session.hostId) return 'gave-up'
    // The session ended normally (completed/error) between scheduling and now —
    // don't probe/reattach, which would flip it to 'dead' with a bogus toast.
    if (session.status === 'completed' || session.status === 'error') return 'gave-up'
    const h = host.get(session.hostId)
    const label = h?.label || h?.alias || session.hostId

    // A manual reconnect (or the user's Retry click) may have already reattached
    // between the drop and this tick. Detect a genuine live attach via the pty —
    // connectionState alone is stale ('live' is never reset on a bare drop).
    if (session.connectionState === 'live' && terminal.hasPty(id)) return 'recovered'

    try {
      await reconnectRemoteSession(id)
    } catch {
      // connectionState set inside doReconnectRemoteSession is authoritative.
    }

    const after = sessions.get(id)
    if (!after) return 'gave-up'

    const { outcome, effect } = classifyAutoReconnectResult({
      status: after.status,
      connectionState: after.connectionState,
    })
    switch (effect) {
      case 'toast-reconnected':
        feedback.toast({ severity: 'info', title: `Reconnected to ${label}` })
        break
      case 'prompt-cleanup':
        // Remote tmux confirmed gone: the agent ended. The session.end hook that
        // drives promptCleanup for a live session is unreliable over a remote link
        // (it races the ControlMaster/reverse-forward teardown as the PTY drops, so
        // the message is often lost before it arrives), leaving remote sessions
        // without the "Clean up worktree?" dialog local sessions get on exit. This
        // probe result is the dependable "session ended" signal, so prompt the same
        // cleanup here — otherwise the card is silently left dead and the user
        // removes it by hand, deleting the worktree with no confirmation. Fire and
        // forget (the dialog awaits user input); promptCleanup's own in-progress
        // guard makes a late-arriving session.end hook a no-op.
        void feedback.promptCleanup(id).catch((err) => {
          console.error(`promptCleanup(${id}) failed:`, err)
          // If the dialog itself failed (no window available, Electron dialog IPC
          // error), still surface the "session ended" signal the old synchronous
          // toast guaranteed — a dialog failure must not silently swallow it.
          feedback.toast({ severity: 'error', title: `${label}: remote session ended` })
        })
        break
      case 'toast-auth-failed':
        feedback.toast({ severity: 'error', title: `SSH authentication failed on ${label}` })
        break
      case 'none':
        break
    }
    return outcome
  }

  async function probePendingSessionsOnHost(
    hostId: string,
    stateHint?: HostConnectionState
  ): Promise<void> {
    const existing = inflightBatchProbes.get(hostId)
    if (existing) return existing
    const promise = doProbePendingSessionsOnHost(hostId, stateHint)
    inflightBatchProbes.set(hostId, promise)
    try {
      await promise
    } finally {
      inflightBatchProbes.delete(hostId)
    }
  }

  async function doProbePendingSessionsOnHost(
    hostId: string,
    stateHint?: HostConnectionState
  ): Promise<void> {
    const h = host.get(hostId)
    if (!h) return
    const reconnectHost = h

    const pending: Session[] = []
    for (const session of sessions.values()) {
      // Skip terminal (completed/error) sessions from the pending pool: probing one
      // would find its tmux gone and flip it to 'dead', silently reverting a session
      // the user chose to keep. deriveRestoredState now restores terminal remotes as
      // 'live' (not 'pending'), so they shouldn't reach here — this is defense-in-depth
      // against any other path leaving a terminal session 'pending'. Mirrors the
      // guards in attemptAutoReconnect and reconnectRemoteSession.
      if (
        session.hostId === hostId &&
        session.connectionState === 'pending' &&
        session.status !== 'completed' &&
        session.status !== 'error'
      ) {
        pending.push(session)
      }
    }
    if (pending.length === 0) return

    // Short-circuit the cascade if the runtime is known-failed. Prefer
    // stateHint: on an ensureHostConnection failure the runtime entry has been
    // deleted by stopHostConnection, so runtimeState would return undefined
    // and we'd fall through to the probe loop — defeating the "no further
    // attempts" contract on auth-failed cascades.
    const runtime = stateHint ?? host.runtimeState(hostId)
    if (runtime === 'auth-failed' || runtime === 'unreachable') {
      for (const s of pending) s.connectionState = runtime
      sessions.changed()
      return
    }

    async function reconnectNext(index: number): Promise<void> {
      const s = pending[index]
      if (!s) return
      // The snapshot was taken once at batch entry; by the time we get here
      // another concurrent reconnect (e.g. user clicking a sibling card) may
      // have already advanced this session out of `pending`. Skip — otherwise
      // we'd duplicate the remote reattach and leak the earlier runtime retain.
      if (s.connectionState !== 'pending') {
        await reconnectNext(index + 1)
        return
      }
      try {
        const probe = await terminal.probe(s.id, reconnectHost)
        // Same pure decision core as doReconnectRemoteSession (probe-transition.ts).
        // `null` = the session resolved to terminal (a concurrent session.end →
        // promptCleanup → Keep) while this probe was in flight — the snapshot filter
        // above only catches sessions already terminal at batch entry. Skip it and
        // move on without clobbering that decision.
        let transition = computeProbeTransition(s.status, probe, now())
        if (transition === null) {
          await reconnectNext(index + 1)
          return
        }
        if (transition.reattach) {
          // The reattach await is a real window in which a concurrent session.end →
          // Keep can resolve this session to terminal; re-derive against the
          // now-current status so a stale 'running → idle' delta can't revert it.
          await terminal.reattach(s.id, reconnectHost)
          transition = computeProbeTransition(s.status, probe, now())
          if (transition === null) {
            await reconnectNext(index + 1)
            return
          }
        }
        applyProbeTransition(s, transition)
        // An SSH probe failure (unreachable — timeout / auth / network) means the
        // remote may still be running. The transition already marked it; bail so we
        // don't mis-classify the rest of the batch as dead on a transient failure.
        if (probe === 'unreachable') return
      } catch (err) {
        // A mid-batch SSH failure means the host dropped. Mark this sibling
        // unreachable and stop — remaining siblings stay `pending` for a
        // later manual reconnect, avoiding a flood of follow-up SSH attempts.
        console.error(`probePendingSessionsOnHost(${hostId}) aborted on ${s.id}:`, err)
        s.connectionState = 'unreachable'
        return
      }
      await reconnectNext(index + 1)
    }

    await reconnectNext(0)
    sessions.changed()
  }

  return { reconnectRemoteSession, attemptAutoReconnect, probePendingSessionsOnHost }
}
