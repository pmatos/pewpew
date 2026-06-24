/// <reference types="vite/client" />

import type {
  AgentTool,
  CreateSessionOptions,
  DiffMode,
  Host,
  OpenSessionsSummary,
  Project,
  RemoteProject,
  ReviewBranchesResult,
  ReviewDefaultBranchResult,
  ReviewDiffResult,
  Session,
  TestConnectionResult,
  Theme,
  ToastEvent,
  Worktree,
  WorktreeBase,
} from '../shared/types'

declare global {
  interface Window {
    api: {
      scanProjects: () => Promise<Project[]>
      setupProject: (path: string) => Promise<void>
      createProject: (name: string) => Promise<void>
      openInFileManager: (path: string) => Promise<void>
      onHookEvent: (callback: (event: { method: string; params: unknown }) => void) => () => void
      createSession: (
        projectPath: string,
        name?: string,
        hostId?: string | null,
        options?: CreateSessionOptions
      ) => Promise<Session>
      createPrSession: (
        projectPath: string,
        prNumber: number,
        hostId?: string | null,
        options?: CreateSessionOptions
      ) => Promise<Session | string>
      createPrSessions: (
        projectPath: string,
        prNumbers: number[],
        hostId?: string | null,
        options?: CreateSessionOptions
      ) => Promise<OpenSessionsSummary | string>
      openSessionsForOpenPrs: (
        projectPath: string,
        hostId?: string | null
      ) => Promise<OpenSessionsSummary | string>
      openSessionsForOpenIssues: (
        projectPath: string,
        hostId?: string | null
      ) => Promise<OpenSessionsSummary | string>
      mirrorWorktree: (
        projectPath: string,
        worktreePath: string,
        hostId?: string | null
      ) => Promise<{ session: Session; warning?: 'gitignore' }>
      mirrorAllWorktrees: (
        projectPath: string,
        hostId?: string | null
      ) => Promise<{
        result: { mirrored: Session[]; failed: { path: string; error: string }[] }
        warning?: 'gitignore'
      }>
      getSessions: () => Promise<Session[]>
      killSession: (id: string) => Promise<void>
      reviveSession: (id: string) => Promise<void>
      reconnectSession: (id: string) => Promise<void>
      attachSession: (id: string) => Promise<void>
      removeWorktree: (id: string) => Promise<void>
      removeSession: (id: string) => Promise<void>
      killSessionBatch: (ids: string[]) => Promise<void>
      reviveSessionBatch: (ids: string[]) => Promise<void>
      removeSessionBatch: (ids: string[]) => Promise<void>
      ptyWriteBatch: (ids: string[], data: string) => Promise<void>
      onSessionsUpdated: (callback: (sessions: Session[]) => void) => () => void
      onOpenDetail: (callback: (sessionId: string) => void) => () => void
      getCanvasState: () => Promise<{ zoom: number; panX: number; panY: number }>
      saveCanvasState: (state: { zoom: number; panX: number; panY: number }) => Promise<void>
      getClusterPositions: () => Promise<Record<string, { x: number; y: number }>>
      saveClusterPositions: (positions: Record<string, { x: number; y: number }>) => Promise<void>
      getSidebarWidth: () => Promise<number>
      saveSidebarWidth: (width: number) => Promise<void>
      getUiScale: () => Promise<number>
      getDefaultTool: () => Promise<AgentTool>
      getWorktreeBase: () => Promise<WorktreeBase>
      getTheme: () => Promise<Theme>
      saveTheme: (theme: Theme) => Promise<void>
      onThemeBroadcast: (callback: (theme: Theme) => void) => () => void
      onTextThumbnails: (callback: (data: Record<string, string>) => void) => () => void
      pickDirectory: () => Promise<string | null>
      relocateProject: (oldPath: string, newPath: string) => Promise<{ migratedCount: number }>
      pinProjectPath: (path: string) => Promise<void>
      ptyWrite: (sessionId: string, data: string) => Promise<void>
      ptyResize: (sessionId: string, cols: number, rows: number) => Promise<void>
      ptyDestroy: (sessionId: string) => Promise<void>
      ptyGetScrollback: (sessionId: string) => Promise<string>
      onPtyData: (callback: (data: { sessionId: string; data: string }) => void) => () => void
      openSwimLanes: (sessionIds: string[]) => Promise<void>
      getReviewDiff: (
        sessionId: string,
        mode: DiffMode,
        baseBranch?: string
      ) => Promise<ReviewDiffResult>
      getReviewBranches: (sessionId: string) => Promise<ReviewBranchesResult>
      getReviewDefaultBranch: (sessionId: string) => Promise<ReviewDefaultBranchResult>
      listHosts: () => Promise<Host[]>
      addHost: (alias: string, label: string) => Promise<Host>
      updateHost: (hostId: string, alias: string, label: string) => Promise<Host>
      deleteHost: (hostId: string) => Promise<void>
      testHostConnection: (hostId: string) => Promise<TestConnectionResult>
      addRemoteProject: (input: { hostId: string; path: string }) => Promise<RemoteProject>
      removeRemoteProject: (hostId: string, path: string) => Promise<void>
      listRemoteWorktrees: (hostId: string, path: string) => Promise<Worktree[]>
      onToast: (callback: (event: ToastEvent) => void) => () => void
    }
  }
}
