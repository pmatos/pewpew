// Per-session exponential-backoff scheduler for auto-reconnecting dropped
// remote sessions. Pure and injectable: timers, jitter, and the attempt
// function are all supplied by the caller so the backoff policy is unit
// testable without real time. Session-manager owns the actual attempt
// (probe + reattach) and maps its result to an AttemptOutcome.

export type AttemptOutcome = 'recovered' | 'retry' | 'gave-up'

export interface ReconnectConfigLike {
  enabled: boolean
  initialDelayMs: number
  maxDelayMs: number
}

export interface TimerHandle {
  unref?: () => void
}

export interface ReconnectSchedulerDeps {
  attempt: (sessionId: string) => Promise<AttemptOutcome>
  config: () => ReconnectConfigLike
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
  random?: () => number
}

export interface ReconnectScheduler {
  schedule(sessionId: string): void
  cancel(sessionId: string): void
  cancelAll(): void
  shutdown(): void
}

interface Entry {
  handle: TimerHandle
  attemptNo: number
  canceled: boolean
  // True only while the awaited attempt is in flight. A fresh schedule() during
  // that window can't arm a new timer (the entry still occupies the map), so it
  // records `rearm` and fire() restarts the backoff once the attempt resolves —
  // otherwise a re-drop mid-reconnect would be silently lost.
  running: boolean
  rearm: boolean
}

export function createReconnectScheduler(deps: ReconnectSchedulerDeps): ReconnectScheduler {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle)
  const clearTimer =
    deps.clearTimer ?? ((h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>))
  const random = deps.random ?? Math.random

  const entries = new Map<string, Entry>()
  let stopped = false

  function delayFor(attemptNo: number, cfg: ReconnectConfigLike): number {
    const base = Math.min(cfg.initialDelayMs * 2 ** attemptNo, cfg.maxDelayMs)
    // Jitter in [0.5, 1.0] of the nominal delay spreads a herd of sessions
    // that all dropped together (shared ControlMaster) across the window.
    const jitter = 0.5 + random() * 0.5
    return Math.round(base * jitter)
  }

  function arm(sessionId: string, attemptNo: number): void {
    const ms = delayFor(attemptNo, deps.config())
    const handle = setTimer(() => void fire(sessionId), ms)
    handle.unref?.()
    entries.set(sessionId, { handle, attemptNo, canceled: false, running: false, rearm: false })
  }

  async function fire(sessionId: string): Promise<void> {
    const entry = entries.get(sessionId)
    if (!entry || stopped) return

    entry.running = true
    let outcome: AttemptOutcome
    try {
      outcome = await deps.attempt(sessionId)
    } catch {
      outcome = 'retry'
    }
    entry.running = false

    // Drop the result if we were canceled or shut down while the attempt was
    // in flight, or if a fresh schedule replaced this entry.
    if (stopped || entry.canceled) return
    if (entries.get(sessionId) !== entry) return

    // A fresh drop arrived while this attempt was in flight (e.g. the reattached
    // PTY died again). Restart the backoff so that disconnect isn't lost, even
    // if this attempt "succeeded" — the session is down again.
    if (entry.rearm) {
      arm(sessionId, 0)
      return
    }

    if (outcome === 'retry') {
      arm(sessionId, entry.attemptNo + 1)
    } else {
      entries.delete(sessionId)
    }
  }

  function cancel(sessionId: string): void {
    const entry = entries.get(sessionId)
    if (!entry) return
    entry.canceled = true
    clearTimer(entry.handle)
    entries.delete(sessionId)
  }

  function cancelAll(): void {
    for (const entry of entries.values()) {
      entry.canceled = true
      clearTimer(entry.handle)
    }
    entries.clear()
  }

  return {
    schedule(sessionId) {
      if (stopped) return
      if (!deps.config().enabled) return
      const existing = entries.get(sessionId)
      if (existing) {
        // A timer is pending or an attempt is in flight. A merely-pending timer
        // already covers this drop; but if an attempt is in flight, record the
        // fresh drop so fire() re-arms afterward instead of silently losing it.
        if (existing.running) existing.rearm = true
        return
      }
      arm(sessionId, 0)
    },
    cancel,
    cancelAll,
    shutdown() {
      stopped = true
      cancelAll()
    },
  }
}
