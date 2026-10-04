import { useCallback, useEffect, useReducer, useRef } from 'react'
import { useProjectsStore, remoteWorktreeKey } from '../stores/projects'
import { useSessionsStore } from '../stores/sessions'
import { useHostsStore } from '../stores/hosts'
import ContextMenu, { type MenuItem } from './ContextMenu'
import {
  SessionDialog,
  resolveSessionDialogDefaults,
  type SessionDialogDefaults,
  type SessionDialogKind,
} from './SessionDialogs'

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

// Expansion state is keyed host-qualified (matching the React node key and the
// remote worktree cache) so two remote projects that share the same path on
// different hosts expand and fetch independently.
function expansionKey(hostId: string | null, path: string): string {
  return `${hostId ?? 'local'}:${path}`
}

interface TreeProps {
  onOpenSession?: (id: string, name: string) => void
}

interface OpenDialog {
  // Distinguishes consecutive opens of the same kind so the dialog remounts
  // with fresh state instead of keeping the previous project's input.
  id: number
  kind: SessionDialogKind
  path: string
  hostId: string | null
  defaults: SessionDialogDefaults
}

interface ProjectTreeUiState {
  expanded: Set<string>
  menu: MenuState | null
  creating: boolean
  dialog: OpenDialog | null
  bulkOpenConfirmThreshold: number
  toast: string | null
}

function projectTreeUiReducer(
  state: ProjectTreeUiState,
  update: Partial<ProjectTreeUiState>
): ProjectTreeUiState {
  return { ...state, ...update }
}

export default function ProjectTree(props: TreeProps) {
  return useProjectTreeElement(props)
}

function useProjectTreeElement({ onOpenSession }: TreeProps) {
  const { projects, loading, scanProjects, filterReady } = useProjectsStore()
  const removeRemoteProject = useProjectsStore((s) => s.removeRemoteProject)
  const removeLocalProject = useProjectsStore((s) => s.removeLocalProject)
  const remoteWorktreesCache = useProjectsStore((s) => s.remoteWorktrees)
  const remoteWorktreesStatus = useProjectsStore((s) => s.remoteWorktreesStatus)
  const fetchRemoteWorktrees = useProjectsStore((s) => s.fetchRemoteWorktrees)
  const { sessions } = useSessionsStore()
  const hosts = useHostsStore((s) => s.hosts)
  const [ui, setUi] = useReducer(projectTreeUiReducer, {
    expanded: new Set<string>(),
    menu: null,
    creating: false,
    dialog: null,
    bulkOpenConfirmThreshold: 20,
    toast: null,
  })
  const { expanded, menu, creating, dialog, bulkOpenConfirmThreshold, toast } = ui
  // Monotonic token: bumped on every open and close, so a slow defaults lookup
  // for a superseded open can't win, and callbacks from a dialog that has since
  // been replaced or closed can't touch the current one.
  const dialogRequestRef = useRef(0)
  const dialogId = dialog?.id

  const closeDialog = useCallback(() => {
    if (dialogRequestRef.current !== dialogId) return
    dialogRequestRef.current += 1
    setUi({ dialog: null, creating: false })
  }, [dialogId])

  const handleBusyChange = useCallback(
    (busy: boolean) => {
      if (dialogRequestRef.current === dialogId) setUi({ creating: busy })
    },
    [dialogId]
  )

  const showToast = (msg: string) => {
    setUi({ toast: msg })
    setTimeout(() => setUi({ toast: null }), 5000)
  }

  useEffect(() => {
    scanProjects()
  }, [scanProjects])

  useEffect(() => {
    let cancelled = false
    window.api.getBulkOpenConfirmThreshold().then((bulkOpenConfirmThreshold) => {
      if (cancelled) return
      setUi({ bulkOpenConfirmThreshold })
    })
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = (path: string) => {
    const next = new Set(expanded)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
    }
    setUi({ expanded: next })
  }

  // Expanding a remote project lazily lists its worktrees over SSH (and retries
  // on a prior error). Already-loaded entries are served from the cache.
  const toggleProject = (projectPath: string, hostId: string | null) => {
    const key = expansionKey(hostId, projectPath)
    if (hostId !== null && !expanded.has(key)) {
      const status = remoteWorktreesStatus[remoteWorktreeKey(hostId, projectPath)]
      if (status !== 'loading' && status !== 'loaded') {
        void fetchRemoteWorktrees(hostId, projectPath)
      }
    }
    toggle(key)
  }

  const handleContextMenu = (
    e: React.MouseEvent,
    projectPath: string,
    setupState: 'unsetup' | 'ready',
    hostId: string | null
  ) => {
    e.preventDefault()
    setUi({
      menu: { x: e.clientX, y: e.clientY, items: getMenuItems(projectPath, setupState, hostId) },
    })
  }

  const openDialog = async (
    kind: SessionDialogKind,
    projectPath: string,
    hostId: string | null
  ) => {
    if (creating) return
    const token = (dialogRequestRef.current += 1)
    const defaults = await resolveSessionDialogDefaults(window.api, {
      tool: 'claude',
      skipPermissions: false,
    })
    if (dialogRequestRef.current !== token) return
    setUi({ dialog: { id: token, kind, path: projectPath, hostId, defaults } })
  }

  const getMenuItems = (
    projectPath: string,
    setupState: 'unsetup' | 'ready',
    hostId: string | null
  ): MenuItem[] => {
    const items: MenuItem[] = []

    if (hostId !== null) {
      items.push({
        label: 'New session…',
        onClick: async () => {
          await openDialog('session', projectPath, hostId)
        },
      })
      items.push({
        label: 'New PR session…',
        onClick: () => {
          void openDialog('pr', projectPath, hostId)
        },
      })
      items.push({
        label: 'New issue session…',
        onClick: () => {
          void openDialog('issue', projectPath, hostId)
        },
      })
      items.push({
        label: 'Open sessions for all open PRs',
        disabled: creating,
        onClick: () => void openDialog('open-all-prs', projectPath, hostId),
      })
      items.push({
        label: 'Open sessions for all open issues…',
        disabled: creating,
        onClick: () => void openDialog('open-all-issues', projectPath, hostId),
      })
      const remoteWts = remoteWorktreesCache[remoteWorktreeKey(hostId, projectPath)] ?? []
      const remoteUnmirrored = remoteWts.filter(
        (wt) =>
          !wt.isMain &&
          !sessions.some((s) => s.worktreePath === wt.path && (s.hostId ?? null) === hostId)
      ).length
      items.push({
        label:
          remoteUnmirrored > 0
            ? `Mirror all worktrees (${remoteUnmirrored})`
            : 'Mirror all worktrees',
        onClick: async () => {
          // Unlike the local path, the remote mirror-all rejects when the host
          // is unreachable or `git worktree list` fails — surface it as a toast
          // instead of an unhandled rejection.
          try {
            const { result } = await window.api.mirrorAllWorktrees(projectPath, hostId)
            const { mirrored, failed } = result
            const parts: string[] = []
            if (mirrored.length > 0) parts.push(`Mirrored ${mirrored.length}`)
            if (failed.length > 0) parts.push(`${failed.length} failed`)
            if (parts.length > 0) showToast(parts.join(', '))
            void fetchRemoteWorktrees(hostId, projectPath)
          } catch (err) {
            showToast(`Mirror all failed: ${String(err)}`)
          }
        },
      })
      items.push({ label: '', separator: true, onClick: () => {} })
      items.push({
        label: 'Remove remote project',
        onClick: () => void removeRemoteProject(hostId, projectPath),
      })
      items.push({ label: '', separator: true, onClick: () => {} })
      items.push({
        label: 'Rescan',
        onClick: () => {
          void scanProjects()
          // scanProjects() does not touch the lazy remote-worktree cache, so
          // force-refresh it here if this project's worktrees were already
          // loaded — otherwise added/removed remote worktrees stay stale.
          if (remoteWorktreesStatus[remoteWorktreeKey(hostId, projectPath)]) {
            void fetchRemoteWorktrees(hostId, projectPath)
          }
        },
      })
      return items
    }

    if (setupState === 'unsetup') {
      items.push({
        label: 'Setup for pewpew',
        onClick: async () => {
          await window.api.setupProject(projectPath)
          scanProjects()
        },
      })
    } else {
      items.push({
        label: 'New session…',
        onClick: async () => {
          await openDialog('session', projectPath, null)
        },
      })
      items.push({
        label: 'New PR session…',
        onClick: () => {
          void openDialog('pr', projectPath, null)
        },
      })
      items.push({
        label: 'New issue session…',
        onClick: () => {
          void openDialog('issue', projectPath, null)
        },
      })
      items.push({
        label: 'Open sessions for all open PRs',
        disabled: creating,
        onClick: () => void openDialog('open-all-prs', projectPath, null),
      })
      items.push({
        label: 'Open sessions for all open issues…',
        disabled: creating,
        onClick: () => void openDialog('open-all-issues', projectPath, null),
      })

      const project = projects.find((p) => p.path === projectPath)
      const unmirroredCount =
        project?.worktrees.filter(
          (wt) => !wt.isMain && !sessions.some((s) => s.worktreePath === wt.path)
        ).length ?? 0
      items.push({
        label:
          unmirroredCount > 0
            ? `Mirror all worktrees (${unmirroredCount})`
            : 'Mirror all worktrees',
        disabled: unmirroredCount === 0,
        onClick: async () => {
          const { result, warning } = await window.api.mirrorAllWorktrees(projectPath)
          const { mirrored, failed } = result
          const parts: string[] = []
          if (mirrored.length > 0) parts.push(`Mirrored ${mirrored.length}`)
          if (failed.length > 0) parts.push(`${failed.length} failed`)
          if (parts.length > 0) showToast(parts.join(', '))
          if (warning === 'gitignore') {
            showToast(
              'Note: .claude/settings.local.json is not gitignored in this project — consider ignoring it.'
            )
          }
        },
      })
      items.push({
        label: 'Re-setup for pewpew',
        onClick: async () => {
          await window.api.setupProject(projectPath)
          scanProjects()
        },
      })
    }

    items.push({ label: '', separator: true, onClick: () => {} })
    items.push({
      label: 'Remove project',
      onClick: async () => {
        const ok = await removeLocalProject(projectPath)
        if (!ok) showToast('Failed to remove project')
      },
    })

    items.push({ label: '', separator: true, onClick: () => {} })

    items.push({
      label: 'Open in file manager',
      onClick: () => window.api.openInFileManager(projectPath),
    })

    items.push({
      label: 'Rescan',
      onClick: () => scanProjects(),
    })

    return items
  }

  if (loading && !dialog) {
    return <div className="project-loading">Scanning…</div>
  }

  const displayProjects = filterReady ? projects.filter((p) => p.setupState === 'ready') : projects

  if (displayProjects.length === 0 && !dialog) {
    return (
      <div className="project-empty">
        {filterReady
          ? 'No setup projects. Right-click a project to set it up, or disable the filter.'
          : 'No git repos found in scan directories. Use "+ New project" below to create one.'}
      </div>
    )
  }

  return (
    <div className="project-tree">
      {dialog && (
        <SessionDialog
          key={dialog.id}
          kind={dialog.kind}
          path={dialog.path}
          hostId={dialog.hostId}
          defaults={dialog.defaults}
          confirmThreshold={bulkOpenConfirmThreshold}
          onClose={closeDialog}
          onToast={showToast}
          onBusyChange={handleBusyChange}
        />
      )}
      {displayProjects.map((project) => {
        const isExpanded = expanded.has(expansionKey(project.hostId, project.path))
        const isRemote = project.hostId !== null
        const rwKey = isRemote ? remoteWorktreeKey(project.hostId as string, project.path) : ''
        const remoteWorktrees = isRemote ? remoteWorktreesCache[rwKey] : undefined
        const remoteStatus = isRemote ? remoteWorktreesStatus[rwKey] : undefined
        // Remote nodes are always expandable so the first expand can trigger the
        // SSH listing; local nodes expand only when they have extra worktrees.
        const worktrees = isRemote ? (remoteWorktrees ?? []) : project.worktrees
        const canExpand = isRemote || project.worktrees.length > 1
        const host = project.hostId ? hosts.find((h) => h.hostId === project.hostId) : null

        return (
          <div key={`${project.hostId ?? 'local'}:${project.path}`} className="project-node">
            <button
              type="button"
              className="project-row"
              onClick={() => canExpand && toggleProject(project.path, project.hostId)}
              onContextMenu={(e) =>
                handleContextMenu(e, project.path, project.setupState, project.hostId)
              }
            >
              <span className="project-toggle">{canExpand ? (isExpanded ? '▼' : '▶') : ' '}</span>
              <span className="project-name">{project.name}</span>
              {host && (
                <span className="host-pill" title={`Remote on ${host.alias}`}>
                  {host.label}
                </span>
              )}
              {project.hostId === null &&
                (project.setupState === 'ready' ? (
                  <span className="badge-ready" title="pewpew hooks installed">
                    ●
                  </span>
                ) : (
                  <span className="badge-unsetup" title="Not set up">
                    [Setup]
                  </span>
                ))}
            </button>

            {isExpanded && (
              <div className="worktree-list">
                {isRemote && remoteWorktrees === undefined && remoteStatus === 'loading' && (
                  <div className="worktree-item worktree-empty">Loading worktrees…</div>
                )}
                {isRemote && remoteStatus === 'error' && (
                  <div className="worktree-item worktree-empty">Failed to load worktrees</div>
                )}
                {worktrees.map((wt) => {
                  const matchingSession = sessions.find(
                    (s) => s.worktreePath === wt.path && (s.hostId ?? null) === project.hostId
                  )
                  const canMirror = !matchingSession && !wt.isMain
                  const worktreeContent = (
                    <>
                      <span className="worktree-label">
                        {wt.name}
                        {wt.branch && <span className="worktree-branch"> ({wt.branch})</span>}
                      </span>
                      {canMirror && (
                        <button
                          className="worktree-mirror-btn"
                          title="Mirror this worktree as a pewpew session"
                          onClick={async (e) => {
                            e.stopPropagation()
                            try {
                              const { warning } = await window.api.mirrorWorktree(
                                project.path,
                                wt.path,
                                project.hostId
                              )
                              if (warning === 'gitignore') {
                                showToast(
                                  'Note: .claude/settings.local.json is not gitignored in this project — consider ignoring it.'
                                )
                              }
                            } catch (err) {
                              showToast(`Mirror failed: ${String(err)}`)
                            }
                          }}
                        >
                          + Mirror
                        </button>
                      )}
                    </>
                  )
                  if (matchingSession && onOpenSession) {
                    return (
                      <button
                        key={wt.path}
                        type="button"
                        className="worktree-item clickable"
                        onClick={() => {
                          onOpenSession(
                            matchingSession.id,
                            `${matchingSession.projectName}/${matchingSession.worktreeName}`
                          )
                        }}
                      >
                        {worktreeContent}
                      </button>
                    )
                  }
                  return (
                    <div key={wt.path} className="worktree-item">
                      {worktreeContent}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setUi({ menu: null })}
        />
      )}

      {toast && <div className="project-tree-toast">{toast}</div>}
    </div>
  )
}
