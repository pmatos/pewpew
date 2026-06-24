import { useEffect, useReducer, useRef } from 'react'
import { useProjectsStore, remoteWorktreeKey } from '../stores/projects'
import { useSessionsStore } from '../stores/sessions'
import { useHostsStore } from '../stores/hosts'
import ContextMenu, { type MenuItem } from './ContextMenu'
import type { AgentTool, OpenSessionsSummary } from '../../shared/types'
import { parsePrSpec } from '../utils/pr-spec-parser'

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

interface ProjectTreeUiState {
  expanded: Set<string>
  menu: MenuState | null
  pendingSessionPath: string | null
  pendingSessionHostId: string | null
  sessionNameInput: string
  defaultTool: AgentTool
  pendingTool: AgentTool
  creating: boolean
  baseFromOrigin: boolean
  createError: string | null
  pendingPrPath: string | null
  pendingPrHostId: string | null
  pendingPrTool: AgentTool
  prNumberInput: string
  prError: string | null
  pendingIssuePath: string | null
  pendingIssueHostId: string | null
  issueLabels: string[] | null
  issueLabelsError: string | null
  selectedIssueLabel: string
  issueConfirmCount: number | null
  issueError: string | null
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
  const remoteWorktreesCache = useProjectsStore((s) => s.remoteWorktrees)
  const remoteWorktreesStatus = useProjectsStore((s) => s.remoteWorktreesStatus)
  const fetchRemoteWorktrees = useProjectsStore((s) => s.fetchRemoteWorktrees)
  const { sessions } = useSessionsStore()
  const hosts = useHostsStore((s) => s.hosts)
  const [ui, setUi] = useReducer(projectTreeUiReducer, {
    expanded: new Set<string>(),
    menu: null,
    pendingSessionPath: null,
    pendingSessionHostId: null,
    sessionNameInput: '',
    defaultTool: 'claude',
    pendingTool: 'claude',
    creating: false,
    baseFromOrigin: false,
    createError: null,
    pendingPrPath: null,
    pendingPrHostId: null,
    pendingPrTool: 'claude',
    prNumberInput: '',
    prError: null,
    pendingIssuePath: null,
    pendingIssueHostId: null,
    issueLabels: null,
    issueLabelsError: null,
    selectedIssueLabel: '',
    issueConfirmCount: null,
    issueError: null,
    bulkOpenConfirmThreshold: 20,
    toast: null,
  })
  const {
    expanded,
    menu,
    pendingSessionPath,
    pendingSessionHostId,
    sessionNameInput,
    defaultTool,
    pendingTool,
    creating,
    baseFromOrigin,
    createError,
    pendingPrPath,
    pendingPrHostId,
    pendingPrTool,
    prNumberInput,
    prError,
    pendingIssuePath,
    pendingIssueHostId,
    issueLabels,
    issueLabelsError,
    selectedIssueLabel,
    issueConfirmCount,
    issueError,
    bulkOpenConfirmThreshold,
    toast,
  } = ui
  const sessionNameInputRef = useRef<HTMLInputElement>(null)
  const prNumberInputRef = useRef<HTMLInputElement>(null)

  const showToast = (msg: string) => {
    setUi({ toast: msg })
    setTimeout(() => setUi({ toast: null }), 5000)
  }

  useEffect(() => {
    scanProjects()
  }, [scanProjects])

  useEffect(() => {
    let cancelled = false
    window.api.getDefaultTool().then((tool) => {
      if (cancelled) return
      setUi({ defaultTool: tool })
      // Don't touch pendingTool here — the New Session menu-item handler is
      // the only path that opens the dialog and it re-seeds pendingTool from
      // defaultTool at click time. Mutating pendingTool from this async
      // callback would race against any user toggle made between the click
      // and getDefaultTool resolving.
    })
    window.api.getBulkOpenConfirmThreshold().then((n) => {
      if (cancelled) return
      setUi({ bulkOpenConfirmThreshold: n })
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

  const openNewSessionDialog = async (projectPath: string, hostId: string | null) => {
    const update: Partial<ProjectTreeUiState> = {
      createError: null,
      sessionNameInput: '',
      pendingTool: defaultTool,
      pendingSessionPath: projectPath,
      pendingSessionHostId: hostId,
    }
    try {
      const worktreeBase = await window.api.getWorktreeBase()
      update.baseFromOrigin = worktreeBase === 'origin-default'
    } catch {
      update.baseFromOrigin = false
    }
    setUi(update)
    setTimeout(() => sessionNameInputRef.current?.focus(), 0)
  }

  const openPrSessionDialog = (projectPath: string, hostId: string | null) => {
    setUi({
      pendingPrPath: projectPath,
      pendingPrHostId: hostId,
      pendingPrTool: defaultTool,
      prNumberInput: '',
      prError: null,
    })
    setTimeout(() => prNumberInputRef.current?.focus(), 0)
  }

  const describeCreateError = (err: unknown): string => {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('no-origin-remote')) return 'This project has no origin remote.'
    if (message.includes('no-origin-default-branch')) {
      return "Could not determine origin's default branch."
    }
    return message.replace(/^Error:\s*/, '') || 'Failed to create session.'
  }

  const formatPrSpecSummary = (result: OpenSessionsSummary): string => {
    const parts: string[] = []
    if (result.created.length > 0) {
      parts.push(
        `Opened ${result.created.length} PR session${result.created.length === 1 ? '' : 's'}`
      )
    }
    if (result.reused.length > 0) parts.push(`linked ${result.reused.length} existing`)
    if (result.skipped.length > 0) parts.push(`skipped ${result.skipped.length}`)
    if (result.failed.length > 0) parts.push(`${result.failed.length} failed`)
    return parts.length > 0 ? parts.join(', ') : 'No PR sessions created'
  }

  const formatPrSpecErrors = (result: OpenSessionsSummary): string => {
    const lines = result.failed.map((f) => `#${f.number}: ${f.error}`)
    return ['No PR sessions opened.', ...lines].join('\n')
  }

  const formatOpenAllSummary = (result: OpenSessionsSummary, label: 'PR' | 'issue'): string => {
    const parts: string[] = []
    const sessionLabel = label === 'PR' ? 'PR session' : 'issue session'
    const itemLabel = label === 'PR' ? 'PR' : 'issue'
    if (result.created.length > 0) {
      parts.push(
        `Opened ${result.created.length} ${sessionLabel}${result.created.length === 1 ? '' : 's'}`
      )
    }
    if (result.reused.length > 0) parts.push(`linked ${result.reused.length} existing`)
    if (result.skipped.length > 0) parts.push(`skipped ${result.skipped.length}`)
    if (result.failed.length > 0) parts.push(`${result.failed.length} failed`)
    return parts.length > 0
      ? parts.join(', ')
      : `No open ${itemLabel === 'PR' ? 'PRs' : 'issues'} to open`
  }

  const handleOpenAllPrs = async (projectPath: string, hostId: string | null) => {
    if (creating) return
    setUi({ creating: true })
    try {
      const result = await window.api.openSessionsForOpenPrs(projectPath, hostId)
      showToast(typeof result === 'string' ? result : formatOpenAllSummary(result, 'PR'))
    } catch (err) {
      showToast(`Failed to open PR sessions: ${String(err)}`)
    } finally {
      setUi({ creating: false })
    }
  }

  const openIssuesDialog = (projectPath: string, hostId: string | null) => {
    setUi({
      pendingIssuePath: projectPath,
      pendingIssueHostId: hostId,
      issueLabels: null,
      issueLabelsError: null,
      selectedIssueLabel: '',
      issueConfirmCount: null,
      issueError: null,
    })
    window.api
      .listRepoLabels(projectPath, hostId)
      .then((result) => {
        if (typeof result === 'string') {
          setUi({ issueLabels: [], issueLabelsError: result })
        } else {
          setUi({ issueLabels: result })
        }
      })
      .catch((err) => {
        setUi({ issueLabels: [], issueLabelsError: String(err) })
      })
  }

  const closeIssuesDialog = () => {
    setUi({
      pendingIssuePath: null,
      pendingIssueHostId: null,
      issueLabels: null,
      issueLabelsError: null,
      selectedIssueLabel: '',
      issueConfirmCount: null,
      issueError: null,
    })
  }

  const proceedOpenIssues = async (projectPath: string, hostId: string | null, label: string) => {
    if (creating) return
    setUi({ creating: true, issueError: null })
    try {
      const result = await window.api.openSessionsForOpenIssues(projectPath, hostId, label || null)
      showToast(typeof result === 'string' ? result : formatOpenAllSummary(result, 'issue'))
      closeIssuesDialog()
    } catch (err) {
      setUi({ issueError: `Failed to open issue sessions: ${String(err)}` })
    } finally {
      setUi({ creating: false })
    }
  }

  const handleSubmitIssues = async () => {
    if (!pendingIssuePath || creating) return
    const projectPath = pendingIssuePath
    const hostId = pendingIssueHostId
    const label = selectedIssueLabel
    setUi({ creating: true, issueError: null })
    let count: number | string
    try {
      count = await window.api.countOpenIssues(projectPath, hostId, label || null)
    } catch (err) {
      setUi({ creating: false, issueError: `Failed to count open issues: ${String(err)}` })
      return
    }
    setUi({ creating: false })
    if (typeof count === 'string') {
      setUi({ issueError: count })
      return
    }
    if (count === 0) {
      showToast(label ? `No open issues match "${label}"` : 'No open issues to open')
      closeIssuesDialog()
      return
    }
    if (count > bulkOpenConfirmThreshold) {
      setUi({ issueConfirmCount: count })
      return
    }
    await proceedOpenIssues(projectPath, hostId, label)
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
          await openNewSessionDialog(projectPath, hostId)
        },
      })
      items.push({
        label: 'New PR session…',
        onClick: () => {
          openPrSessionDialog(projectPath, hostId)
        },
      })
      items.push({
        label: 'Open sessions for all open PRs',
        disabled: creating,
        onClick: () => void handleOpenAllPrs(projectPath, hostId),
      })
      items.push({
        label: 'Open sessions for all open issues…',
        disabled: creating,
        onClick: () => openIssuesDialog(projectPath, hostId),
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
          await openNewSessionDialog(projectPath, null)
        },
      })
      items.push({
        label: 'New PR session…',
        onClick: () => {
          openPrSessionDialog(projectPath, null)
        },
      })
      items.push({
        label: 'Open sessions for all open PRs',
        disabled: creating,
        onClick: () => void handleOpenAllPrs(projectPath, null),
      })
      items.push({
        label: 'Open sessions for all open issues…',
        disabled: creating,
        onClick: () => openIssuesDialog(projectPath, null),
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
      label: 'Open in file manager',
      onClick: () => window.api.openInFileManager(projectPath),
    })

    items.push({
      label: 'Rescan',
      onClick: () => scanProjects(),
    })

    return items
  }

  if (loading) {
    return <div className="project-loading">Scanning…</div>
  }

  const displayProjects = filterReady ? projects.filter((p) => p.setupState === 'ready') : projects

  if (displayProjects.length === 0) {
    return (
      <div className="project-empty">
        {filterReady
          ? 'No setup projects. Right-click a project to set it up, or disable the filter.'
          : 'No git repos found in scan directories. Use "+ New project" below to create one.'}
      </div>
    )
  }

  const handleCreateSession = async () => {
    if (!pendingSessionPath || creating) return
    setUi({ creating: true, createError: null })
    try {
      const name = sessionNameInput.trim() || undefined
      await window.api.createSession(pendingSessionPath, name, pendingSessionHostId, {
        tool: pendingTool,
        baseRef: baseFromOrigin ? 'origin-default' : 'local',
      })
      setUi({ pendingSessionPath: null, pendingSessionHostId: null, sessionNameInput: '' })
    } catch (err) {
      setUi({ createError: describeCreateError(err) })
    } finally {
      setUi({ creating: false })
    }
  }

  const handleCreatePrSession = async () => {
    if (!pendingPrPath || creating) return
    const parsed = parsePrSpec(prNumberInput)
    if ('error' in parsed) {
      setUi({ prError: parsed.error })
      return
    }
    setUi({ creating: true, prError: null })
    try {
      const result = await window.api.createPrSessions(
        pendingPrPath,
        parsed.numbers,
        pendingPrHostId,
        { tool: pendingPrTool }
      )
      if (typeof result === 'string') {
        setUi({ prError: result })
        return
      }
      if (parsed.numbers.length === 1) {
        if (result.failed.length === 1) {
          setUi({ prError: result.failed[0].error })
          return
        }
        if (result.skipped.length === 1) {
          setUi({ prError: `PR #${result.skipped[0]} already has a session.` })
          return
        }
        setUi({ pendingPrPath: null, pendingPrHostId: null, prNumberInput: '' })
        return
      }
      // Multiple PRs: if nothing was opened or linked, keep the dialog open and
      // surface the per-PR reasons instead of a fleeting count-only toast.
      if (result.created.length === 0 && result.reused.length === 0) {
        setUi({ prError: formatPrSpecErrors(result) })
        return
      }
      showToast(formatPrSpecSummary(result))
      setUi({ pendingPrPath: null, pendingPrHostId: null, prNumberInput: '' })
    } catch (err) {
      setUi({ prError: describeCreateError(err) })
    } finally {
      setUi({ creating: false })
    }
  }

  return (
    <div className="project-tree">
      {pendingSessionPath && (
        <div className="session-name-dialog">
          <div className="session-name-label">Session name (optional):</div>
          <input
            ref={sessionNameInputRef}
            type="text"
            className="create-input"
            placeholder="Leave empty for auto-name…"
            value={sessionNameInput}
            onChange={(e) => setUi({ sessionNameInput: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateSession()
              if (e.key === 'Escape') {
                setUi({ pendingSessionPath: null, pendingSessionHostId: null, createError: null })
              }
            }}
          />
          <div className="session-name-label">Tool:</div>
          <div className="tool-picker">
            <label>
              <input
                type="radio"
                name="tool"
                value="claude"
                checked={pendingTool === 'claude'}
                onChange={() => setUi({ pendingTool: 'claude' })}
              />
              Claude
            </label>
            <label>
              <input
                type="radio"
                name="tool"
                value="codex"
                checked={pendingTool === 'codex'}
                onChange={() => setUi({ pendingTool: 'codex' })}
              />
              Codex
            </label>
          </div>
          <label className="session-base-checkbox">
            <input
              type="checkbox"
              checked={baseFromOrigin}
              onChange={(e) => {
                setUi({ baseFromOrigin: e.target.checked, createError: null })
              }}
            />
            <span>Branch from origin/&lt;default&gt;</span>
          </label>
          {createError && <div className="pr-error">{createError}</div>}
          <div className="create-actions">
            <button className="create-btn" onClick={handleCreateSession} disabled={creating}>
              {creating ? 'Creating…' : 'Create'}
            </button>
            <button
              className="create-btn cancel"
              onClick={() => {
                setUi({ pendingSessionPath: null, pendingSessionHostId: null, createError: null })
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {pendingPrPath && (
        <div className="session-name-dialog">
          <div className="session-name-label">PR number(s):</div>
          <input
            ref={prNumberInputRef}
            type="text"
            className="create-input"
            placeholder="e.g. 42 or 1,2,22-28"
            value={prNumberInput}
            onChange={(e) => setUi({ prNumberInput: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreatePrSession()
              if (e.key === 'Escape') {
                setUi({ pendingPrPath: null, pendingPrHostId: null, prError: null })
              }
            }}
          />
          <div className="session-name-label">Tool:</div>
          <div className="tool-picker">
            <label>
              <input
                type="radio"
                name="pr-tool"
                value="claude"
                checked={pendingPrTool === 'claude'}
                onChange={() => setUi({ pendingPrTool: 'claude' })}
              />
              Claude
            </label>
            <label>
              <input
                type="radio"
                name="pr-tool"
                value="codex"
                checked={pendingPrTool === 'codex'}
                onChange={() => setUi({ pendingPrTool: 'codex' })}
              />
              Codex
            </label>
          </div>
          {prError && <div className="pr-error">{prError}</div>}
          <div className="create-actions">
            <button className="create-btn" onClick={handleCreatePrSession} disabled={creating}>
              {creating ? 'Creating…' : 'Create'}
            </button>
            <button
              className="create-btn cancel"
              onClick={() => {
                setUi({ pendingPrPath: null, pendingPrHostId: null, prError: null })
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {pendingIssuePath && (
        <div className="session-name-dialog">
          {issueConfirmCount === null ? (
            <>
              <div className="session-name-label">Label filter:</div>
              {issueLabels === null ? (
                <div className="session-name-label">Loading labels…</div>
              ) : (
                <select
                  className="create-input"
                  value={selectedIssueLabel}
                  onChange={(e) => setUi({ selectedIssueLabel: e.target.value })}
                >
                  <option value="">All open issues</option>
                  {issueLabels.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
              {issueLabelsError && (
                <div className="pr-error">Could not load labels: {issueLabelsError}</div>
              )}
              {issueError && <div className="pr-error">{issueError}</div>}
              <div className="create-actions">
                <button
                  type="button"
                  className="create-btn"
                  onClick={handleSubmitIssues}
                  disabled={creating || issueLabels === null}
                >
                  {creating ? 'Working…' : 'Open sessions'}
                </button>
                <button type="button" className="create-btn cancel" onClick={closeIssuesDialog}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="session-name-label">
                This will open up to {issueConfirmCount} issue session
                {issueConfirmCount === 1 ? '' : 's'}
                {selectedIssueLabel ? ` labelled "${selectedIssueLabel}"` : ''}. Continue?
              </div>
              {issueError && <div className="pr-error">{issueError}</div>}
              <div className="create-actions">
                <button
                  type="button"
                  className="create-btn"
                  onClick={() =>
                    void proceedOpenIssues(pendingIssuePath, pendingIssueHostId, selectedIssueLabel)
                  }
                  disabled={creating}
                >
                  {creating ? 'Opening…' : `Open ${issueConfirmCount}`}
                </button>
                <button type="button" className="create-btn cancel" onClick={closeIssuesDialog}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
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
