import { create } from 'zustand'

function applyReduceAnimations(reduce: boolean): void {
  document.documentElement.classList.toggle('reduce-animations', reduce)
}

// Freeze compositor-driven animations while pewpew isn't focused/visible so the
// GPU and memory clocks can drop while it sits idle in the background — the core
// of issue #185. CSS reads the `app-unfocused` class to hold the needs-input
// pulse (and any other infinite animation) on a steady frame.
function applyFocused(focused: boolean): void {
  document.documentElement.classList.toggle('app-unfocused', !focused)
}

let focusTrackingInstalled = false
function initFocusTracking(): void {
  if (focusTrackingInstalled) return
  focusTrackingInstalled = true
  const update = (): void => {
    applyFocused(document.hasFocus() && document.visibilityState === 'visible')
  }
  window.addEventListener('focus', update)
  window.addEventListener('blur', update)
  document.addEventListener('visibilitychange', update)
  update()
}

interface AnimationsStore {
  reduceAnimations: boolean
  loaded: boolean
  // Monotonic counter incremented on every actual state change. init() captures
  // it before its IPC await and bails if it changed, so a user toggle during a
  // slow getReduceAnimations() isn't clobbered by the fetched value. Mirrors the
  // theme store's race guard.
  mutationCount: number
  init: () => Promise<void>
  setReduceAnimations: (reduce: boolean) => void
  toggle: () => void
}

let broadcastListenerInstalled = false

export const useAnimationsStore = create<AnimationsStore>((set, get) => ({
  reduceAnimations: false,
  loaded: false,
  mutationCount: 0,
  init: async () => {
    // Focus tracking is window-local runtime state, not persisted config; wire
    // it up on every window regardless of the load guard below.
    initFocusTracking()
    if (get().loaded) return
    if (!broadcastListenerInstalled) {
      broadcastListenerInstalled = true
      window.api.onReduceAnimationsBroadcast((reduce) => {
        // A broadcast is newer cross-window state than an in-flight init()
        // getReduceAnimations() reply, so it must bump mutationCount even when
        // the value already matches the current (default) state. Otherwise a
        // stale reply passes init()'s mutationCount guard and clobbers this
        // window's value — with no way to correct it in a window that has no
        // local toggle (e.g. Swim Lanes). Only touch the DOM on a real change.
        if (get().reduceAnimations !== reduce) {
          applyReduceAnimations(reduce)
        }
        set({ reduceAnimations: reduce, mutationCount: get().mutationCount + 1 })
      })
    }
    const initialMutation = get().mutationCount
    set({ loaded: true })
    const reduce = await window.api.getReduceAnimations()
    if (get().mutationCount !== initialMutation) return
    if (reduce === get().reduceAnimations) return
    applyReduceAnimations(reduce)
    set({ reduceAnimations: reduce })
  },
  setReduceAnimations: (reduce) => {
    if (get().reduceAnimations === reduce) return
    applyReduceAnimations(reduce)
    set({ reduceAnimations: reduce, mutationCount: get().mutationCount + 1 })
    void window.api.saveReduceAnimations(reduce)
  },
  toggle: () => {
    get().setReduceAnimations(!get().reduceAnimations)
  },
}))
