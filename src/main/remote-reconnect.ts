import type { Host, Session, ToastEvent } from '../shared/types'
import type { HostConnectionState } from './host-connection'
import type { PreparedRemoteHostLease } from './remote-host-runtime'
import type { RemoteTmuxProbeResult } from './pty-manager'
import type { AttemptOutcome } from './reconnect-scheduler'
import {
  applyProbeTransition,
  computeProbeTransition,
  type ProbeTransition,
} from './probe-transition'
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
}

// A rejection from acquireLease (prepareHost's ensureHostConnection leg) may
// carry the connection state remote-host-runtime captured before
// stopHostConnection wiped the runtime entry; probe/reattach rejections are
// never tagged — they only run after a successful lease, so the
// `host.runtimeState(hostId)` fallback at the catch site is load-bearing for
// every post-lease failure (bootstrap, PTY attach). The coordinator reads the
// tag to classify auth-failed vs unreachable without re-parsing stderr.
type HostConnectionTaggedError = { hostConnectionState?: HostConnectionState }

// The single consumer-side spelling of the tagged-error channel: narrows an
// unknown rejection to the state remote-host-runtime attached, so the property
// name lives in exactly one place on this side of the port.
function taggedConnectionState(err: unknown): HostConnectionState | undefined {
  return (err as HostConnectionTaggedError | null)?.hostConnectionState
}

// 'completed'/'error' are terminal statuses: the user has made a cleanup
// decision (or the session errored), so no probe/reattach path may touch them —
// probing one would find its tmux gone and flip it to 'dead', silently reverting
// a Keep. All three entry guards below (manual reconnect, auto attempt, batch
// filter) share this predicate; computeProbeTransition independently returns
// null for them as the last line of defense.
const isTerminal = (status: Session['status']): boolean =>
  status === 'completed' || status === 'error'

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

  // In-flight reconnect promises keyed by session id. Two concurrent clicks on
  // the same pending card (fast double-click, or a click that races the
  // auto-fired batch probe) coalesce into one SSH attempt.
  const inflightReconnects = new Map<string, Promise<PreparedRemoteHostLease>>()

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
    // A terminal session is done — never re-probe/reconnect it, so triggering
    // Reconnect on a kept ('completed') or errored session can't probe-and-flip
    // it back to 'dead', silently undoing the user's Keep. Defense-in-depth:
    // deriveRestoredState already restores terminal remotes as 'live' (not
    // 'pending'), so the UI no longer offers Reconnect for them.
    const current = sessions.get(id)
    if (current && isTerminal(current.status)) return

    const existing = inflightReconnects.get(id)
    if (existing) {
      await existing
      return
    }

    // Capture hostId BEFORE the await: if `removeSession(id)` runs while this
    // reconnect is in flight, `sessions.get(id)` would return undefined after
    // the await and we'd neither release the host retain nor run the sibling
    // batch — leaking the ControlMaster for the lifetime of the app. No await
    // has run since `current` was read, so this is the same entry.
    const initialHostId = current?.hostId ?? null

    const promise = doReconnectRemoteSession(id)
    inflightReconnects.set(id, promise)
    let reconnectError: unknown = undefined
    let lease: PreparedRemoteHostLease | undefined
    try {
      lease = await promise
    } catch (err) {
      reconnectError = err
    } finally {
      inflightReconnects.delete(id)
    }
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
    // On success the runtime is live (the lease was just acquired over it), so
    // a fresh oracle read serves where a failure instead falls back from the tag.
    const stateHint =
      taggedConnectionState(reconnectError) ?? (hostId ? host.runtimeState(hostId) : undefined)
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
          // The IIFE's promise is discarded, so a rejecting release() would
          // escape as an unhandled rejection — the port permits it even though
          // today's production release swallows errors.
          await lease?.release().catch((err) => {
            console.error(`releasing prepared-host lease for ${hostId} failed:`, err)
          })
        }
      })()
    } else {
      await lease?.release()
    }
    if (reconnectError !== undefined) throw reconnectError
  }

  // Probe one session over the live ControlMaster and compute its state
  // transition, reattaching when the remote tmux is still present. Pure decision
  // core in probe-transition.ts; callers own applying the delta and notifying.
  // A `null` transition means the session resolved to a terminal state while the
  // probe/reattach was in flight (e.g. a delayed session.end hook drove
  // promptCleanup and the user chose Keep) — applying the delta would clobber
  // that decision ('absent' → 'dead'), re-exposing cleanup and risking deletion
  // of the kept worktree, so callers must leave the session untouched.
  async function probeAndReattach(
    session: Session,
    h: Host
  ): Promise<{ probe: RemoteTmuxProbeResult; transition: ProbeTransition | null }> {
    const probe = await terminal.probe(session.id, h)
    let transition = computeProbeTransition(session.status, probe, Date.now())
    if (transition?.reattach) {
      // Reattach before the caller applies the delta so a reattach failure
      // leaves the session's fields untouched and propagates to its catch. The
      // reattach await is a real window in which a concurrent session.end →
      // Keep can drive status to terminal, so re-derive against the now-current
      // status: a stale 'running → idle' delta must not revert a kept session.
      await terminal.reattach(session.id, h)
      transition = computeProbeTransition(session.status, probe, Date.now())
    }
    return { probe, transition }
  }

  async function doReconnectRemoteSession(id: string): Promise<PreparedRemoteHostLease> {
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
      // A null transition leaves the session untouched; the lease is still
      // returned so the caller reconciles/releases it.
      const { transition } = await probeAndReattach(session, h)
      if (transition) {
        applyProbeTransition(session, transition)
        sessions.changed()
      }
      return lease
    } catch (err) {
      // Prefer the state captured by remote-host-runtime (attached to the error
      // before stopHostConnection wipes the runtime entry). Fall back to the
      // live runtime when the failure happened after the host was prepared
      // (e.g. bootstrap / PTY attach step).
      const runtimeState = taggedConnectionState(err) ?? host.runtimeState(hostId)
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
    if (isTerminal(session.status)) return 'gave-up'

    // A manual reconnect (or the user's Retry click) may have already reattached
    // between the drop and this tick. Detect a genuine live attach via the pty —
    // connectionState alone is stale ('live' is never reset on a bare drop).
    if (session.connectionState === 'live' && terminal.hasPty(id)) return 'recovered'

    // Below the 'recovered' fast path: host.get re-reads and parses config.json
    // synchronously, and the label is only used by the toast effects.
    const h = host.get(session.hostId)
    const label = h?.label || h?.alias || session.hostId

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
    const reconnectHost = host.get(hostId)
    if (!reconnectHost) return

    const pending: Session[] = []
    for (const session of sessions.values()) {
      // Skip terminal sessions from the pending pool (see isTerminal).
      // deriveRestoredState restores terminal remotes as 'live' (not 'pending'),
      // so they shouldn't reach here — this is defense-in-depth against any
      // other path leaving a terminal session 'pending'.
      if (
        session.hostId === hostId &&
        session.connectionState === 'pending' &&
        !isTerminal(session.status)
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

    // Track mutations so a batch that skipped every sibling (removed mid-batch,
    // concurrently advanced out of `pending`, or kept mid-probe) doesn't persist
    // and broadcast an unchanged registry.
    let dirty = false
    for (const s of pending) {
      // The snapshot was taken once at batch entry; by the time we get here
      // another concurrent reconnect (e.g. user clicking a sibling card) may
      // have already advanced this session out of `pending`. Skip — otherwise
      // we'd duplicate the remote reattach and leak the earlier runtime retain.
      // Re-check registry membership too: removeSession/removeSessionsForHost
      // delete the entry WITHOUT mutating this snapshot object, so a sibling
      // removed mid-batch (e.g. hosts:delete) still reads 'pending' here and
      // would be reattached as an ownerless PTY nothing can destroy.
      const live = sessions.get(s.id)
      if (!live || live.connectionState !== 'pending') continue
      try {
        const { probe, transition } = await probeAndReattach(s, reconnectHost)
        if (transition === null) continue
        applyProbeTransition(s, transition)
        dirty = true
        // An SSH probe failure (unreachable — timeout / auth / network) means the
        // remote may still be running. The transition already marked it; bail so we
        // don't mis-classify the rest of the batch as dead on a transient failure.
        if (probe === 'unreachable') break
      } catch (err) {
        // A mid-batch SSH failure means the host dropped. Mark this sibling
        // unreachable and stop — remaining siblings stay `pending` for a
        // later manual reconnect, avoiding a flood of follow-up SSH attempts.
        console.error(`probePendingSessionsOnHost(${hostId}) aborted on ${s.id}:`, err)
        s.connectionState = 'unreachable'
        dirty = true
        break
      }
    }
    if (dirty) sessions.changed()
  }

  return { reconnectRemoteSession, attemptAutoReconnect, probePendingSessionsOnHost }
}
