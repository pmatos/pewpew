import { create } from 'zustand'
import type { Project, Worktree } from '../../shared/types'

export type RemoteWorktreesStatus = 'loading' | 'loaded' | 'error'

export function remoteWorktreeKey(hostId: string, path: string): string {
  return `${hostId} ${path}`
}

interface ProjectsState {
  projects: Project[]
  loading: boolean
  filterReady: boolean
  addRemoteDialogOpen: boolean
  addRemoteError: string | null
  addRemoteSubmitting: boolean
  // Remote worktrees are fetched lazily over SSH (on node expand), keyed by
  // remoteWorktreeKey(hostId, path). This cache survives scanProjects(), which
  // only replaces `projects`.
  remoteWorktrees: Record<string, Worktree[]>
  remoteWorktreesStatus: Record<string, RemoteWorktreesStatus>
  scanProjects: () => Promise<void>
  fetchRemoteWorktrees: (hostId: string, path: string) => Promise<void>
  toggleFilterReady: () => void
  openAddRemoteDialog: () => void
  closeAddRemoteDialog: () => void
  clearAddRemoteError: () => void
  addRemoteProject: (input: { hostId: string; path: string }) => Promise<void>
  removeRemoteProject: (hostId: string, path: string) => Promise<void>
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return String(e)
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  loading: false,
  filterReady: false,
  addRemoteDialogOpen: false,
  addRemoteError: null,
  addRemoteSubmitting: false,
  remoteWorktrees: {},
  remoteWorktreesStatus: {},
  toggleFilterReady: () => set((state) => ({ filterReady: !state.filterReady })),
  scanProjects: async () => {
    set({ loading: true })
    try {
      const projects = await window.api.scanProjects()
      set({ projects, loading: false })
    } catch (err) {
      console.error('scanProjects failed:', err)
      set({ loading: false })
    }
  },
  fetchRemoteWorktrees: async (hostId, path) => {
    const key = remoteWorktreeKey(hostId, path)
    set((state) => ({
      remoteWorktreesStatus: { ...state.remoteWorktreesStatus, [key]: 'loading' },
    }))
    try {
      const worktrees = await window.api.listRemoteWorktrees(hostId, path)
      set((state) => ({
        remoteWorktrees: { ...state.remoteWorktrees, [key]: worktrees },
        remoteWorktreesStatus: { ...state.remoteWorktreesStatus, [key]: 'loaded' },
      }))
    } catch (e) {
      console.error('listRemoteWorktrees failed:', e)
      set((state) => ({
        remoteWorktreesStatus: { ...state.remoteWorktreesStatus, [key]: 'error' },
      }))
    }
  },
  openAddRemoteDialog: () =>
    set({ addRemoteDialogOpen: true, addRemoteError: null, addRemoteSubmitting: false }),
  closeAddRemoteDialog: () =>
    set({ addRemoteDialogOpen: false, addRemoteError: null, addRemoteSubmitting: false }),
  clearAddRemoteError: () => set({ addRemoteError: null }),
  addRemoteProject: async (input) => {
    set({ addRemoteSubmitting: true, addRemoteError: null })
    try {
      await window.api.addRemoteProject(input)
      set({ addRemoteSubmitting: false, addRemoteDialogOpen: false, addRemoteError: null })
      await get().scanProjects()
    } catch (e) {
      set({ addRemoteSubmitting: false, addRemoteError: errorMessage(e) })
    }
  },
  removeRemoteProject: async (hostId, path) => {
    try {
      await window.api.removeRemoteProject(hostId, path)
      await get().scanProjects()
    } catch (e) {
      console.error('removeRemoteProject failed:', e)
    }
  },
}))
