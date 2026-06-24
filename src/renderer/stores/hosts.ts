import { create } from 'zustand'
import { useProjectsStore } from './projects'
import type { Host, HostId, TestConnectionResult } from '../../shared/types'

interface HostsState {
  hosts: Host[]
  loading: boolean
  dialogOpen: boolean
  editingHostId: HostId | null
  addingNew: boolean
  testing: Record<HostId, boolean>
  testResults: Record<HostId, TestConnectionResult | undefined>
  error: string | null
  fetchHosts: () => Promise<void>
  openDialog: () => void
  closeDialog: () => void
  startEdit: (hostId: HostId) => void
  startAdd: () => void
  cancelEdit: () => void
  addHost: (alias: string, label: string) => Promise<void>
  updateHost: (hostId: HostId, alias: string, label: string) => Promise<void>
  deleteHost: (hostId: HostId) => Promise<void>
  testHost: (hostId: HostId) => Promise<void>
  clearError: () => void
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return String(e)
}

export const useHostsStore = create<HostsState>((set, get) => ({
  hosts: [],
  loading: false,
  dialogOpen: false,
  editingHostId: null,
  addingNew: false,
  testing: {},
  testResults: {},
  error: null,

  fetchHosts: async () => {
    set({ loading: true })
    try {
      const hosts = await window.api.listHosts()
      set({ hosts, loading: false })
    } catch (e) {
      set({ error: errorMessage(e), loading: false })
    }
  },

  openDialog: () => {
    set({ dialogOpen: true, error: null })
    void get().fetchHosts()
  },

  closeDialog: () => {
    set({
      dialogOpen: false,
      editingHostId: null,
      addingNew: false,
      error: null,
      testResults: {},
    })
  },

  startEdit: (hostId) => set({ editingHostId: hostId, addingNew: false, error: null }),
  startAdd: () => set({ addingNew: true, editingHostId: null, error: null }),
  cancelEdit: () => set({ addingNew: false, editingHostId: null, error: null }),

  addHost: async (alias, label) => {
    try {
      const host = await window.api.addHost(alias, label)
      set({ addingNew: false, error: null })
      await get().fetchHosts()
      // Immediately probe the new host so the user sees connectivity + missing
      // tools (e.g. socat) right after setting it up, not when a session fails.
      void get().testHost(host.hostId)
    } catch (e) {
      set({ error: errorMessage(e) })
      throw e
    }
  },

  updateHost: async (hostId, alias, label) => {
    try {
      await window.api.updateHost(hostId, alias, label)
      set({ editingHostId: null, error: null })
      await get().fetchHosts()
    } catch (e) {
      set({ error: errorMessage(e) })
      throw e
    }
  },

  deleteHost: async (hostId) => {
    try {
      await window.api.deleteHost(hostId)
      set({ error: null })
      await get().fetchHosts()
      // Cascade deletes the host's remote projects in the main process; the
      // renderer's projects view caches the previous list, so without an
      // explicit rescan stale entries with the deleted hostId stay visible
      // until the next session/scan event and "New Session" on one of them
      // would fail with "Unknown host".
      await useProjectsStore.getState().scanProjects()
    } catch (e) {
      set({ error: errorMessage(e) })
    }
  },

  testHost: async (hostId) => {
    set((s) => ({ testing: { ...s.testing, [hostId]: true } }))
    try {
      const result = await window.api.testHostConnection(hostId)
      set((s) => ({
        testing: { ...s.testing, [hostId]: false },
        testResults: { ...s.testResults, [hostId]: result },
      }))
    } catch (e) {
      set((s) => ({
        testing: { ...s.testing, [hostId]: false },
        testResults: {
          ...s.testResults,
          [hostId]: { ok: false, reason: 'unknown', message: errorMessage(e) },
        },
      }))
    }
  },

  clearError: () => set({ error: null }),
}))
