import { describe, it, expect, vi } from 'vitest'
import { createReconnectScheduler, type AttemptOutcome } from './reconnect-scheduler'

interface FakeTimer {
  fn: () => void
  ms: number
  cleared: boolean
}

function fakeTimers() {
  const timers: FakeTimer[] = []
  return {
    timers,
    setTimer(fn: () => void, ms: number) {
      const t: FakeTimer = { fn, ms, cleared: false }
      timers.push(t)
      return { handle: t, unref() {} }
    },
    clearTimer(h: unknown) {
      const handle = (h as { handle?: FakeTimer } | undefined)?.handle
      if (handle) handle.cleared = true
    },
    last(): FakeTimer {
      return timers[timers.length - 1]
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

const config =
  (over: Partial<{ enabled: boolean; initialDelayMs: number; maxDelayMs: number }> = {}) =>
  () => ({ enabled: true, initialDelayMs: 1000, maxDelayMs: 30000, ...over })

describe('reconnect-scheduler', () => {
  it('fires the attempt after the initial delay and stops on recovery', async () => {
    const timers = fakeTimers()
    const attempt = vi.fn().mockResolvedValue('recovered')
    const scheduler = createReconnectScheduler({
      attempt,
      config: config(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random: () => 0,
    })

    scheduler.schedule('s1')
    expect(timers.timers).toHaveLength(1)
    // delay = initial(1000) * jitter(0.5 + random(0)*0.5 = 0.5) = 500
    expect(timers.last().ms).toBe(500)

    timers.last().fn()
    await flush()

    expect(attempt).toHaveBeenCalledWith('s1')
    expect(attempt).toHaveBeenCalledTimes(1)
    // recovered → no reschedule
    expect(timers.timers).toHaveLength(1)
  })

  it('reschedules with exponential backoff, capped at maxDelayMs', async () => {
    const timers = fakeTimers()
    const attempt = vi.fn().mockResolvedValue('retry')
    const scheduler = createReconnectScheduler({
      attempt,
      config: config(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random: () => 0,
    })

    scheduler.schedule('s1')
    const delays: number[] = []
    for (let i = 0; i < 8; i++) {
      delays.push(timers.last().ms)
      timers.last().fn()
      await flush()
    }

    // base = min(1000 * 2^n, 30000), jitter 0.5 → base/2.
    // 1000→30000 doubling caps at attempt 5 (32000 clamps to 30000).
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000, 15000])
  })

  it('stops without rescheduling when the attempt gives up', async () => {
    const timers = fakeTimers()
    const attempt = vi.fn().mockResolvedValue('gave-up' as AttemptOutcome)
    const scheduler = createReconnectScheduler({
      attempt,
      config: config(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random: () => 0,
    })

    scheduler.schedule('s1')
    timers.last().fn()
    await flush()

    expect(attempt).toHaveBeenCalledTimes(1)
    expect(timers.timers).toHaveLength(1)
  })

  it('cancel clears the pending timer and a late fire is inert', async () => {
    const timers = fakeTimers()
    const attempt = vi.fn().mockResolvedValue('retry' as AttemptOutcome)
    const scheduler = createReconnectScheduler({
      attempt,
      config: config(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random: () => 0,
    })

    scheduler.schedule('s1')
    const t = timers.last()
    scheduler.cancel('s1')
    expect(t.cleared).toBe(true)

    t.fn() // simulate a timer that already fired before clear won the race
    await flush()

    expect(attempt).not.toHaveBeenCalled()
    expect(timers.timers).toHaveLength(1)
  })

  it('drops the result if canceled while the attempt is in flight', async () => {
    const timers = fakeTimers()
    let resolveAttempt!: (o: AttemptOutcome) => void
    const attempt = vi.fn().mockImplementation(
      () =>
        new Promise<AttemptOutcome>((r) => {
          resolveAttempt = r
        })
    )
    const scheduler = createReconnectScheduler({
      attempt,
      config: config(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random: () => 0,
    })

    scheduler.schedule('s1')
    timers.last().fn()
    await flush()
    expect(attempt).toHaveBeenCalledTimes(1)

    scheduler.cancel('s1')
    resolveAttempt('retry')
    await flush()

    // canceled mid-attempt → the resolved 'retry' must not re-arm
    expect(timers.timers).toHaveLength(1)
  })

  it('is idempotent: a second schedule while armed does not stack timers', () => {
    const timers = fakeTimers()
    const scheduler = createReconnectScheduler({
      attempt: vi.fn().mockResolvedValue('retry' as AttemptOutcome),
      config: config(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random: () => 0,
    })

    scheduler.schedule('s1')
    scheduler.schedule('s1')

    expect(timers.timers).toHaveLength(1)
  })

  it('does not schedule when reconnect is disabled', () => {
    const timers = fakeTimers()
    const scheduler = createReconnectScheduler({
      attempt: vi.fn().mockResolvedValue('retry' as AttemptOutcome),
      config: config({ enabled: false }),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random: () => 0,
    })

    scheduler.schedule('s1')

    expect(timers.timers).toHaveLength(0)
  })

  it('re-arms when a fresh schedule arrives during an in-flight attempt', async () => {
    const timers = fakeTimers()
    let resolveAttempt!: (o: AttemptOutcome) => void
    const attempt = vi.fn().mockImplementation(
      () =>
        new Promise<AttemptOutcome>((r) => {
          resolveAttempt = r
        })
    )
    const scheduler = createReconnectScheduler({
      attempt,
      config: config(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random: () => 0,
    })

    scheduler.schedule('s1')
    timers.last().fn() // fire → attempt is now in flight (pending)
    await flush()
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(timers.timers).toHaveLength(1)

    // A fresh drop arrives WHILE the attempt is in flight (e.g. the reattached
    // PTY died again). It must not be swallowed by the idempotency guard.
    scheduler.schedule('s1')
    expect(timers.timers).toHaveLength(1) // still in flight, no new timer yet

    // The attempt reports success — normally it would stop. The mid-flight drop
    // must force a fresh re-arm so the new disconnect isn't lost.
    resolveAttempt('recovered')
    await flush()

    expect(timers.timers).toHaveLength(2)
    expect(timers.last().ms).toBe(500) // fresh backoff at attempt 0
  })

  it('shutdown cancels all timers and makes further scheduling a no-op', () => {
    const timers = fakeTimers()
    const scheduler = createReconnectScheduler({
      attempt: vi.fn().mockResolvedValue('retry' as AttemptOutcome),
      config: config(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random: () => 0,
    })

    scheduler.schedule('s1')
    scheduler.schedule('s2')
    expect(timers.timers).toHaveLength(2)

    scheduler.shutdown()
    expect(timers.timers.every((t) => t.cleared)).toBe(true)

    scheduler.schedule('s3')
    expect(timers.timers).toHaveLength(2) // no new timer after shutdown
  })
})
