import { useState, useEffect, useRef, useCallback, useEffectEvent, useReducer } from 'react'
import ProjectTree from './components/ProjectTree'
import SessionCanvas, { type ZoomOpenPayload } from './components/SessionCanvas'
import DetailPane from './components/DetailPane'
import StatusBar from './components/StatusBar'
import ManageHostsDialog from './components/ManageHostsDialog'
import ZoomOpenMorph from './components/ZoomOpenMorph'
import AddRemoteProjectDialog from './components/AddRemoteProjectDialog'
import ToastContainer from './components/ToastContainer'
import { useProjectsStore } from './stores/projects'
import { useSessionsStore } from './stores/sessions'
import { useHostsStore } from './stores/hosts'
import { useToastsStore } from './stores/toasts'
import { useThemeStore } from './stores/theme'
import { useAnimationsStore } from './stores/animations'

interface CreateProjectDialogProps {
  onCreate: (name: string) => Promise<void>
  onCancel: () => void
}

function CreateProjectDialog({ onCreate, onCancel }: CreateProjectDialogProps) {
  const [projectName, setProjectName] = useState('')
  const focusInput = useCallback((node: HTMLInputElement | null) => {
    node?.focus()
  }, [])

  const submit = async () => {
    const name = projectName.trim()
    if (!name) return
    await onCreate(name)
  }

  return (
    <div className="create-dialog">
      <input
        ref={focusInput}
        type="text"
        className="create-input"
        placeholder="Project name…"
        value={projectName}
        onChange={(e) => setProjectName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape') onCancel()
        }}
      />
      <div className="create-actions">
        <button className="create-btn" onClick={submit}>
          Create
        </button>
        <button className="create-btn cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

interface AppState {
  showCreateDialog: boolean
  sidebarWidth: number
  activeSessionId: string | null
  activeSessionName: string
  morphPayload: ZoomOpenPayload | null
}

function appStateReducer(state: AppState, update: Partial<AppState>): AppState {
  return { ...state, ...update }
}

export default function App() {
  const { scanProjects, filterReady, toggleFilterReady } = useProjectsStore()
  const openAddRemoteDialog = useProjectsStore((s) => s.openAddRemoteDialog)
  const { init: initSessions } = useSessionsStore()
  const hosts = useHostsStore((s) => s.hosts)
  const openHostsDialog = useHostsStore((s) => s.openDialog)
  const fetchHosts = useHostsStore((s) => s.fetchHosts)

  const [appState, setAppState] = useReducer(appStateReducer, {
    showCreateDialog: false,
    sidebarWidth: 250,
    activeSessionId: null,
    activeSessionName: '',
    morphPayload: null,
  })
  const { showCreateDialog, sidebarWidth, activeSessionId, activeSessionName, morphPayload } =
    appState

  const handleZoomOpen = useCallback((payload: ZoomOpenPayload) => {
    // Keep canvas rendered during the morph; mount DetailPane only on morph grown.
    setAppState({ morphPayload: payload })
  }, [])
  const resizing = useRef(false)
  const resizeStart = useRef({ x: 0, width: 0 })

  useEffect(() => {
    void useThemeStore.getState().init()
    void useAnimationsStore.getState().init()
  }, [])

  useEffect(() => {
    void fetchHosts()
  }, [fetchHosts])

  useEffect(() => {
    return initSessions()
  }, [initSessions])

  const openCreateProjectDialog = useCallback(() => {
    setAppState({ showCreateDialog: true })
  }, [])

  // Subscribe to open-detail IPC from tray/notifications
  useEffect(() => {
    return window.api.onOpenDetail((sessionId) => {
      const sessions = useSessionsStore.getState().sessions
      const session = sessions.find((s) => s.id === sessionId)
      if (session) {
        setAppState({
          activeSessionId: sessionId,
          activeSessionName: `${session.projectName}/${session.worktreeName}`,
        })
      }
    })
  }, [])

  // Subscribe to toast IPC from main (SSH failures, bootstrap errors, etc.)
  useEffect(() => {
    return window.api.onToast((event) => {
      useToastsStore.getState().enqueue(event)
    })
  }, [])

  // Load sidebar width
  useEffect(() => {
    window.api.getSidebarWidth().then((w) => setAppState({ sidebarWidth: w }))
  }, [])

  const handleGlobalKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'n') {
      e.preventDefault()
      openCreateProjectDialog()
    } else if (e.ctrlKey && e.shiftKey && e.key === 'R') {
      e.preventDefault()
      scanProjects()
    } else if (e.key === 'Escape') {
      // Modals handle Escape themselves; don't run global shortcuts when
      // one is open (avoids side-effect clearing of active session /
      // selection when dismissing a modal via Escape).
      if (useHostsStore.getState().dialogOpen) return
      if (useProjectsStore.getState().addRemoteDialogOpen) return
      if (morphPayload && !activeSessionId) {
        // Cancel zoom-open mid-morph: abort the transition and stay on canvas.
        setAppState({ morphPayload: null })
      } else if (activeSessionId) {
        setAppState({ activeSessionId: null })
      } else if (useSessionsStore.getState().selectedIds.size > 0) {
        useSessionsStore.getState().clearSelection()
      } else {
        setAppState({ showCreateDialog: false })
      }
    }
  })

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      handleGlobalKeyDown(e)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const createProject = async (name: string) => {
    await window.api.createProject(name)
    setAppState({ showCreateDialog: false })
    scanProjects()
  }

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      resizing.current = true
      resizeStart.current = { x: e.clientX, width: sidebarWidth }
    },
    [sidebarWidth]
  )

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!resizing.current) return
      const dx = e.clientX - resizeStart.current.x
      const newWidth = Math.max(150, Math.min(500, resizeStart.current.width + dx))
      setAppState({ sidebarWidth: newWidth })
    }

    const handleUp = () => {
      if (resizing.current) {
        resizing.current = false
        window.api.saveSidebarWidth(sidebarWidth)
      }
    }

    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    return () => {
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }
  }, [sidebarWidth])

  return (
    <div className="app-layout" style={{ gridTemplateColumns: `${sidebarWidth}px 4px 1fr` }}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <span>Projects</span>
          <div className="sidebar-header-actions">
            <button
              className={`filter-btn${filterReady ? ' active' : ''}`}
              onClick={toggleFilterReady}
              title={filterReady ? 'Showing setup projects only' : 'Show only setup projects'}
            >
              ●
            </button>
            <button
              className="refresh-btn"
              onClick={scanProjects}
              title="Refresh projects (Ctrl+Shift+R)"
            >
              ⟳
            </button>
          </div>
        </div>
        <div className="sidebar-content">
          <ProjectTree
            onOpenSession={(id, name) => {
              setAppState({ activeSessionId: id, activeSessionName: name })
            }}
          />
        </div>
        <div className="sidebar-footer">
          {showCreateDialog ? (
            <CreateProjectDialog
              onCreate={createProject}
              onCancel={() => setAppState({ showCreateDialog: false })}
            />
          ) : (
            <button className="new-project-btn" onClick={openCreateProjectDialog} title="Ctrl+N">
              + New project
            </button>
          )}
          <button
            className="new-project-btn hosts-btn"
            onClick={openHostsDialog}
            title="Manage SSH hosts"
          >
            🌐 Hosts ({hosts.length})
          </button>
          <button
            className="new-project-btn"
            onClick={openAddRemoteDialog}
            title="Register a remote git project"
          >
            📡 Remote project
          </button>
        </div>
      </aside>

      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        onMouseDown={handleResizeStart}
      />

      <main className="canvas">
        {activeSessionId ? (
          <DetailPane
            sessionId={activeSessionId}
            sessionName={activeSessionName}
            onClose={() => setAppState({ activeSessionId: null })}
          />
        ) : (
          <SessionCanvas
            onOpenSession={(id, name) => {
              setAppState({ activeSessionId: id, activeSessionName: name })
            }}
            onZoomOpen={handleZoomOpen}
            morphActive={morphPayload !== null}
          />
        )}
      </main>

      <ManageHostsDialog />
      <AddRemoteProjectDialog />
      <ToastContainer />
      {morphPayload && (
        <ZoomOpenMorph
          startRect={morphPayload.startRect}
          onGrown={() => {
            // If the user already opened a different session during the morph
            // window (e.g. clicked another card), keep that selection.
            setAppState({
              activeSessionId: activeSessionId ?? morphPayload.sessionId,
              activeSessionName: activeSessionName || morphPayload.sessionName,
            })
          }}
          onDone={() => setAppState({ morphPayload: null })}
        />
      )}

      <StatusBar />
    </div>
  )
}
