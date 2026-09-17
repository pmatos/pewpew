import type { Session, SessionStatus } from '../shared/types'

// Durable storage for the whole session set. CONTRACT: `save` runs first in
// `changed()`, before the renderer is told — a crash between the two can lose
// the broadcast but never the write. The array is freshly allocated per flush,
// but its elements are the store's own *live, mutable* Session objects:
// serialize them synchronously and never retain them. A throw propagates out of
// `changed()` and skips the broadcast and the tray, so a full disk leaves the UI
// showing the last state that actually landed rather than one that didn't.
export interface SessionPersistence {
  save(sessions: Session[]): void
}

// Push of the session set to every renderer window. CONTRACT: receives the same
// array instance the persistence port just saw, and must not retain it or its
// elements. The store does not catch, so a throw here aborts `changed()` before
// the tray is updated.
export interface SessionBroadcast {
  publish(sessions: Session[]): void
}

// The OS tray's view of the session set: it reads an aggregate, not the whole
// record. CONTRACT: called last, after the state is durable and the renderer has
// been told, so a slow or throwing tray can never delay or suppress either.
export interface SessionTray {
  update(sessions: Session[]): void
}

export interface SessionStoreDeps {
  persist: SessionPersistence
  broadcast: SessionBroadcast
  tray: SessionTray
}

// Rate-limit `lastKnownState` writes per session to once every 10s so the 3s
// thumbnail tick doesn't churn `sessions.json` on disk.
export const LAST_KNOWN_STATE_MIN_INTERVAL_MS = 10_000
export const LAST_KNOWN_STATE_MAX_BYTES = 3 * 1024

/**
 * The session registry: the in-memory `id -> Session` map behind sessions.json,
 * the persist + broadcast + tray fan-out every change has to trigger, and the
 * two write policies that travel with the data (status stamping, `lastKnownState`
 * rate limiting).
 *
 * LIVE REFERENCES. `get`/`values`/`all` hand back the store's own Session
 * objects, never copies. Callers mutate fields in place and then call
 * `changed()`. This is deliberate and load-bearing, not an oversight: the
 * remote-reconnect coordinator writes `connectionState`/`status` in place and
 * re-reads `session.status` *after* an await (see remote-reconnect.ts's
 * SessionLookup CONTRACT), so a snapshot-returning store would silently break
 * that re-read. The usual preference for an immutable core is declined here for
 * exactly that reason: what this module owns is lifecycle and the change edge,
 * not field writes.
 *
 * MUTATORS NEVER NOTIFY. Every mutator returns whether it actually changed
 * anything and reaches no sink. `changed()` is the only thing that touches disk,
 * renderer or tray. That split is what lets a batch which mutated nothing emit
 * nothing, and it keeps every notify placement visible at its call site rather
 * than buried in a mutator.
 *
 * THE CALLER OWNS THE CLOCK. `setStatus` and `recordLastKnownState` take `now`
 * rather than reading a clock, so one batch shares one timestamp exactly as the
 * pre-store code did, and the store's own tests need no fake timers.
 *
 * This interface structurally satisfies remote-reconnect's `SessionLookup`
 * (`get`/`values`/`changed`) but deliberately does not import it: the consumer
 * owns its port, and the match is proved where the two meet — the wiring site in
 * session-manager.
 */
export interface SessionStore {
  /** The live Session for `id`, or undefined. Mutate its fields in place, then call `changed()`. */
  get(id: string): Session | undefined

  /**
   * Lazy iteration over the live Sessions, in insertion order. Deleting the
   * current entry during iteration is safe and skips nothing else (Map
   * semantics) — `removeSessionsForHost` relies on it. For a stable snapshot
   * taken before a loop mutates the registry, use `all()`.
   */
  values(): Iterable<Session>

  /** A fresh array of the live Sessions. The array is the caller's; the elements are the store's. */
  all(): Session[]

  /** Register `session` under its id, replacing any entry already there. Does not notify. */
  insert(session: Session): void

  /**
   * Swap the stored object for `id` to `next`; returns false if `id` is absent
   * or `next` is already the stored object. For the copy-on-write hook state
   * machine, whose reducer returns fresh objects.
   *
   * CONTRACT — object identity changes: any reference a caller captured before
   * this call goes stale. It still points at the old object, and writes to it
   * are dropped. This is pre-existing behaviour, documented here rather than
   * fixed; an identity-preserving `merge(id, patch)` is the successor if someone
   * decides to close it. Does not notify.
   */
  replace(id: string, next: Session): boolean

  /** Drop `id`; returns whether it was present, for the caller's dirty flag. Does not notify. */
  delete(id: string): boolean

  /**
   * Set status and stamp `lastActivity` from `now`. Returns false only when `id`
   * is absent — a status set to its current value still moves `lastActivity`, so
   * it is a real mutation and returns true. Mutates in place, preserving object
   * identity. Does not notify.
   */
  setStatus(id: string, status: SessionStatus, now: number): boolean

  /**
   * Record a thumbnail snapshot, subject to the per-session 10s rate limit, the
   * 3 KiB tail cap, and the text-equality no-op. Returns whether the session was
   * actually mutated — false for an absent id, a write inside the window, or
   * text identical to what is stored. That false is the entire mechanism by
   * which an all-rate-limited batch emits nothing. Does not notify.
   */
  recordLastKnownState(id: string, text: string, now: number): boolean

  /**
   * Realize the side effects of whatever just changed, in order:
   * persist -> broadcast -> tray, all three receiving the same freshly allocated
   * array of live Sessions. Unconditional: it does not track dirtiness, because
   * callers legitimately mutate live Session fields directly and an implicit
   * dirty flag would make those writes invisible.
   */
  changed(): void

  /**
   * Run `body` and call `changed()` exactly once if and only if `body` returns
   * true. Returns whether it notified.
   *
   * `body` returning `boolean` is the point: the natural wrong implementation,
   * `batch(fn) { try { fn() } finally { changed() } }`, cannot be expressed
   * through this signature, and a caller who forgets to thread the dirty flag
   * gets a compile error rather than a spurious broadcast.
   *
   * Only usable when nothing must happen between the last mutation and the
   * notification. `handleHookEvent` realizes side-effect intents in that gap and
   * therefore keeps an explicit `if (mutated) changed()`.
   */
  batch(body: () => boolean): boolean
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  const sessions = new Map<string, Session>()
  // Per-session clock of the last accepted `lastKnownState` write.
  const lastKnownStateWrites = new Map<string, number>()

  function changed(): void {
    // One array, three sinks. Before the store, persistSessions, notifyRenderer
    // and updateTray(getSessions()) each rebuilt it independently, so nothing
    // structurally guaranteed they agreed.
    const snapshot = Array.from(sessions.values())
    deps.persist.save(snapshot)
    deps.broadcast.publish(snapshot)
    deps.tray.update(snapshot)
  }

  return {
    get: (id) => sessions.get(id),
    values: () => sessions.values(),
    all: () => Array.from(sessions.values()),

    insert(session) {
      sessions.set(session.id, session)
    },

    replace(id, next) {
      const current = sessions.get(id)
      if (!current || current === next) return false
      sessions.set(id, next)
      return true
    },

    delete: (id) => sessions.delete(id),

    setStatus(id, status, now) {
      const session = sessions.get(id)
      if (!session) return false
      session.status = status
      session.lastActivity = now
      return true
    },

    recordLastKnownState(id, text, now) {
      const session = sessions.get(id)
      if (!session) return false
      const last = lastKnownStateWrites.get(id) ?? 0
      if (now - last < LAST_KNOWN_STATE_MIN_INTERVAL_MS) return false
      const trimmed =
        text.length > LAST_KNOWN_STATE_MAX_BYTES ? text.slice(-LAST_KNOWN_STATE_MAX_BYTES) : text
      // Idle sessions emit identical thumbnail text every tick; without this
      // no-op the 10s window would still trigger a write + broadcast for every
      // live session indefinitely.
      if (session.lastKnownState?.text === trimmed) return false
      session.lastKnownState = { text: trimmed, timestamp: now }
      lastKnownStateWrites.set(id, now)
      return true
    },

    changed,

    batch(body) {
      if (!body()) return false
      changed()
      return true
    },
  }
}
