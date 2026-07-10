import { contextBridge, ipcRenderer } from 'electron'
import type { AgentTool, CreateSessionOptions, Theme, ToastEvent } from '../shared/types'

contextBridge.exposeInMainWorld('api', {
  scanProjects: () => ipcRenderer.invoke('projects:scan'),
  setupProject: (path: string) => ipcRenderer.invoke('projects:setup', path),
  createProject: (name: string) => ipcRenderer.invoke('projects:create', name),
  openInFileManager: (path: string) => ipcRenderer.invoke('projects:open-file-manager', path),
  onHookEvent: (callback: (event: { method: string; params: unknown }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { method: string; params: unknown }
    ) => callback(data)
    ipcRenderer.on('hook:event', handler)
    return () => ipcRenderer.removeListener('hook:event', handler)
  },
  createSession: (
    projectPath: string,
    name?: string,
    hostId?: string | null,
    options?: CreateSessionOptions
  ) => ipcRenderer.invoke('sessions:create', projectPath, name, hostId ?? null, options),
  createPrSession: (
    projectPath: string,
    prNumber: number,
    hostId?: string | null,
    options?: CreateSessionOptions
  ) => ipcRenderer.invoke('sessions:create-pr', projectPath, prNumber, hostId ?? null, options),
  createPrSessions: (
    projectPath: string,
    prNumbers: number[],
    hostId?: string | null,
    options?: CreateSessionOptions
  ) => ipcRenderer.invoke('sessions:create-prs', projectPath, prNumbers, hostId ?? null, options),
  openSessionsForOpenPrs: (projectPath: string, hostId?: string | null, repo?: string | null) =>
    ipcRenderer.invoke('sessions:open-all-prs', projectPath, hostId ?? null, repo ?? null),
  openSessionsForOpenIssues: (
    projectPath: string,
    hostId?: string | null,
    label?: string | null,
    repo?: string | null
  ) =>
    ipcRenderer.invoke(
      'sessions:open-all-issues',
      projectPath,
      hostId ?? null,
      label ?? null,
      repo ?? null
    ),
  countOpenIssues: (
    projectPath: string,
    hostId?: string | null,
    label?: string | null,
    repo?: string | null
  ) =>
    ipcRenderer.invoke(
      'sessions:count-open-issues',
      projectPath,
      hostId ?? null,
      label ?? null,
      repo ?? null
    ),
  listRepoLabels: (projectPath: string, hostId?: string | null, repo?: string | null) =>
    ipcRenderer.invoke('repo:list-labels', projectPath, hostId ?? null, repo ?? null),
  getRepoChoices: (projectPath: string, hostId?: string | null) =>
    ipcRenderer.invoke('repo:choices', projectPath, hostId ?? null),
  mirrorWorktree: (projectPath: string, worktreePath: string, hostId?: string | null) =>
    ipcRenderer.invoke('sessions:mirror', projectPath, worktreePath, hostId ?? null),
  mirrorAllWorktrees: (projectPath: string, hostId?: string | null) =>
    ipcRenderer.invoke('sessions:mirror-all', projectPath, hostId ?? null),
  getSessions: () => ipcRenderer.invoke('sessions:list'),
  killSession: (id: string) => ipcRenderer.invoke('sessions:kill', id),
  reviveSession: (id: string) => ipcRenderer.invoke('sessions:revive', id),
  reconnectSession: (id: string) => ipcRenderer.invoke('sessions:reconnect', id),
  attachSession: (id: string) => ipcRenderer.invoke('sessions:attach', id),
  removeWorktree: (id: string) => ipcRenderer.invoke('sessions:remove-worktree', id),
  removeSession: (id: string) => ipcRenderer.invoke('sessions:remove', id),
  killSessionBatch: (ids: string[]) => ipcRenderer.invoke('sessions:kill-batch', ids),
  reviveSessionBatch: (ids: string[]) => ipcRenderer.invoke('sessions:revive-batch', ids),
  removeSessionBatch: (ids: string[]) => ipcRenderer.invoke('sessions:remove-batch', ids),
  ptyWriteBatch: (ids: string[], data: string) => ipcRenderer.invoke('pty:write-batch', ids, data),
  onSessionsUpdated: (callback: (sessions: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown[]) => callback(data)
    ipcRenderer.on('sessions:updated', handler)
    return () => ipcRenderer.removeListener('sessions:updated', handler)
  },
  onOpenDetail: (callback: (sessionId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId)
    ipcRenderer.on('sessions:open-detail', handler)
    return () => ipcRenderer.removeListener('sessions:open-detail', handler)
  },
  getCanvasState: () => ipcRenderer.invoke('config:get-canvas'),
  saveCanvasState: (state: { zoom: number; panX: number; panY: number }) =>
    ipcRenderer.invoke('config:save-canvas', state),
  getClusterPositions: () => ipcRenderer.invoke('config:get-clusters'),
  saveClusterPositions: (positions: Record<string, { x: number; y: number }>) =>
    ipcRenderer.invoke('config:save-clusters', positions),
  getSidebarWidth: () => ipcRenderer.invoke('config:get-sidebar-width'),
  saveSidebarWidth: (width: number) => ipcRenderer.invoke('config:save-sidebar-width', width),
  getUiScale: () => ipcRenderer.invoke('config:get-ui-scale'),
  getDefaultTool: () => ipcRenderer.invoke('config:get-default-tool') as Promise<AgentTool>,
  getBulkOpenConfirmThreshold: () =>
    ipcRenderer.invoke('config:get-bulk-open-confirm-threshold') as Promise<number>,
  getWorktreeBase: () => ipcRenderer.invoke('config:get-worktree-base'),
  getTheme: () => ipcRenderer.invoke('config:get-theme') as Promise<Theme>,
  saveTheme: (theme: Theme) => ipcRenderer.invoke('config:save-theme', theme),
  onThemeBroadcast: (callback: (theme: Theme) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, theme: Theme) => callback(theme)
    ipcRenderer.on('theme:changed', handler)
    return () => ipcRenderer.removeListener('theme:changed', handler)
  },
  onTextThumbnails: (callback: (data: Record<string, string>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: Record<string, string>) =>
      callback(data)
    ipcRenderer.on('thumbnails:text-updated', handler)
    return () => ipcRenderer.removeListener('thumbnails:text-updated', handler)
  },
  pickDirectory: () => ipcRenderer.invoke('projects:pick-directory'),
  relocateProject: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke('projects:relocate', oldPath, newPath),
  pinProjectPath: (path: string) => ipcRenderer.invoke('projects:pin-path', path),
  ptyWrite: (sessionId: string, data: string) => ipcRenderer.invoke('pty:write', sessionId, data),
  ptyResize: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke('pty:resize', sessionId, cols, rows),
  ptyDestroy: (sessionId: string) => ipcRenderer.invoke('pty:destroy', sessionId),
  ptyGetScrollback: (sessionId: string) => ipcRenderer.invoke('pty:scrollback', sessionId),
  onPtyData: (callback: (data: { sessionId: string; data: string }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { sessionId: string; data: string }
    ) => callback(data)
    ipcRenderer.on('pty:data', handler)
    return () => ipcRenderer.removeListener('pty:data', handler)
  },
  openSwimLanes: (sessionIds: string[]) => ipcRenderer.invoke('swim-lanes:open', sessionIds),
  getReviewDiff: (sessionId: string, mode: string, baseBranch?: string) =>
    ipcRenderer.invoke('review:get-diff', sessionId, mode, baseBranch),
  getReviewBranches: (sessionId: string) => ipcRenderer.invoke('review:list-branches', sessionId),
  getReviewDefaultBranch: (sessionId: string) =>
    ipcRenderer.invoke('review:get-default-branch', sessionId),
  listHosts: () => ipcRenderer.invoke('hosts:list'),
  addHost: (alias: string, label: string) => ipcRenderer.invoke('hosts:add', alias, label),
  updateHost: (hostId: string, alias: string, label: string) =>
    ipcRenderer.invoke('hosts:update', hostId, alias, label),
  deleteHost: (hostId: string) => ipcRenderer.invoke('hosts:delete', hostId),
  testHostConnection: (hostId: string) => ipcRenderer.invoke('hosts:test-connection', hostId),
  addRemoteProject: (input: { hostId: string; path: string }) =>
    ipcRenderer.invoke('projects:add-remote', input),
  removeRemoteProject: (hostId: string, path: string) =>
    ipcRenderer.invoke('projects:remove-remote', hostId, path),
  listRemoteWorktrees: (hostId: string, path: string) =>
    ipcRenderer.invoke('projects:list-remote-worktrees', hostId, path),
  onToast: (callback: (event: ToastEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ToastEvent) => callback(data)
    ipcRenderer.on('toast:show', handler)
    return () => ipcRenderer.removeListener('toast:show', handler)
  },
})
