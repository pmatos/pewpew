import { useState, useEffect } from 'react'
import type { AgentTool, Session } from '../../shared/types'
import { useProjectsStore } from '../stores/projects'
import { useSessionsStore } from '../stores/sessions'
import { useHostsStore } from '../stores/hosts'
import { STATUS_CONFIG } from '../utils/status-config'
import ContextMenu, { type MenuItem } from './ContextMenu'

const TOOL_BADGE: Record<AgentTool, { label: string; letter: string }> = {
  claude: { label: 'Claude', letter: 'C' },
  codex: { label: 'Codex', letter: 'X' },
  omp: { label: 'oh-my-pi', letter: 'O' },
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

interface Props {
  session: Session
  thumbnail?: string
  style?: React.CSSProperties
  onOpenSession?: (id: string, name: string) => void
  onSelect?: (id: string, e: React.MouseEvent) => void
}

export default function SessionCard({ session, thumbnail, style, onOpenSession, onSelect }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [, setTick] = useState(0)

  const selectedIds = useSessionsStore((s) => s.selectedIds)
  const clearSelection = useSessionsStore((s) => s.clearSelection)
  const hosts = useHostsStore((s) => s.hosts)
  const isSelected = selectedIds.has(session.id)
  const selectedCount = selectedIds.size

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30000)
    return () => clearInterval(interval)
  }, [])
  const { className: statusClass, label } = STATUS_CONFIG[session.status]
  const host = session.hostId ? hosts.find((h) => h.hostId === session.hostId) : null
  const connectionState = session.connectionState ?? (host ? 'offline' : undefined)

  const sessionName = `${session.projectName}/${session.worktreeName}`

  const openOrSelectSession = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      onSelect?.(session.id, e)
      return
    }
    if (selectedCount > 0) {
      clearSelection()
    }
    // First click on a pending remote session opens the host's control
    // connection and probes tmux. DetailPane renders the cached preview +
    // spinner overlay while connectionState transitions to 'live' (or dead).
    if (session.hostId && connectionState === 'pending') {
      void window.api.reconnectSession(session.id).catch(() => undefined)
    }
    // Local sessions deferred during restoreSessions() also boot lazily so
    // startup doesn't spawn N concurrent agent processes (which OOM'd on
    // hosts with many sessions).
    if (!session.hostId && connectionState === 'pending') {
      void window.api.attachSession(session.id).catch(() => undefined)
    }
    if (onOpenSession && session.status !== 'dead' && session.status !== 'error') {
      onOpenSession(session.id, sessionName)
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    if (!isSelected && selectedCount > 0) {
      clearSelection()
    }
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const buildMenuItems = (): MenuItem[] => {
    if (isSelected && selectedCount > 1) {
      const ids = [...selectedIds]
      const sessions = useSessionsStore.getState().sessions
      const deadCount = ids.filter((id) => {
        const s = sessions.find((sess) => sess.id === id)
        return s?.status === 'dead' || s?.status === 'error'
      }).length
      return [
        {
          label: `Open ${selectedCount} as swimming lanes`,
          onClick: async () => {
            await window.api.openSwimLanes([...selectedIds])
            clearSelection()
          },
        },
        {
          label: `Send command to ${selectedCount} sessions`,
          onClick: () => useSessionsStore.getState().openBroadcastDialog(),
        },
        {
          label: `Kill ${selectedCount} sessions`,
          onClick: async () => {
            await window.api.killSessionBatch(ids)
            clearSelection()
          },
        },
        ...(deadCount > 0
          ? [
              {
                label: `Restart ${deadCount} dead session${deadCount > 1 ? 's' : ''}`,
                onClick: async () => {
                  await window.api.reviveSessionBatch(ids)
                  clearSelection()
                },
              },
            ]
          : []),
        {
          label: `Remove ${selectedCount} from canvas`,
          onClick: async () => {
            await window.api.removeSessionBatch(ids)
            clearSelection()
            useProjectsStore.getState().scanProjects()
          },
        },
      ]
    }
    const isRemoteNonLive =
      !!session.hostId && connectionState !== undefined && connectionState !== 'live'
    return [
      {
        label: session.status === 'dead' ? 'Restart terminal' : 'Open terminal',
        onClick: () => onOpenSession?.(session.id, sessionName),
      },
      ...(isRemoteNonLive && session.status !== 'dead'
        ? [
            {
              label: 'Reconnect',
              onClick: () => {
                void window.api.reconnectSession(session.id).catch(() => undefined)
              },
            },
          ]
        : []),
      {
        label: 'Kill session',
        onClick: () => {
          // Don't let a rejected IPC (e.g. remote SSH failure) become an
          // unhandled promise. The main-side error is already logged.
          void window.api.killSession(session.id).catch(() => undefined)
        },
      },
      {
        label: 'Remove from canvas',
        onClick: async () => {
          try {
            await window.api.removeSession(session.id)
          } catch {
            // Error already logged in main. Fall through to re-scan so the UI
            // reflects whatever actually survived (e.g. a failed remote remove
            // leaves the worktree, which scanProjects will still show).
          }
          useProjectsStore.getState().scanProjects()
        },
      },
    ]
  }

  const classes = [
    'session-card',
    session.status === 'needs_input' ? 'needs-input' : '',
    isSelected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      className={classes}
      data-session-id={session.id}
      onClick={openOrSelectSession}
      onContextMenu={handleContextMenu}
      style={style}
    >
      <div className="session-card-thumb">
        {(() => {
          const preview = thumbnail ?? session.lastKnownState?.text
          if (!preview) return null
          const stale = !thumbnail && connectionState !== 'live'
          return <pre className={`session-card-text-thumb${stale ? ' stale' : ''}`}>{preview}</pre>
        })()}
        {host && (
          <div className="session-card-host-overlay" title={`${host.label}: ${connectionState}`}>
            <span className="host-pill">{host.label}</span>
            <span className={`connection-dot connection-${connectionState}`} />
          </div>
        )}
      </div>
      <div className="session-card-body">
        <div className="session-card-header">{sessionName}</div>
        <div className="session-card-chips">
          <span className="session-card-chip chip-branch" title={`branch: ${session.branch}`}>
            <span className="chip-icon">⎇</span>
            {session.branch}
          </span>
          {session.issueNumber !== undefined && (
            <span className="session-card-chip chip-issue" title={`issue #${session.issueNumber}`}>
              issue #{session.issueNumber}
            </span>
          )}
          {session.prNumber !== undefined && (
            <span className="session-card-chip chip-pr" title={`PR #${session.prNumber}`}>
              PR #{session.prNumber}
            </span>
          )}
          {session.prIsFork && (
            <span
              className="session-card-chip chip-fork"
              title={
                session.prHeadRepo
                  ? `fork PR — head in ${session.prHeadRepo} (pushes won't update the PR)`
                  : "fork PR — head in a forked repo (pushes won't update the PR)"
              }
            >
              <span className="chip-icon">⑂</span>
              fork
            </span>
          )}
        </div>
        <div className="session-card-status">
          <span className={`status-dot ${statusClass}`} />
          <span>{label}</span>
          <span
            className={`tool-badge tool-${session.tool}`}
            title={TOOL_BADGE[session.tool].label}
          >
            {TOOL_BADGE[session.tool].letter}
          </span>
          {host && connectionState && <span className="connection-label">{connectionState}</span>}
        </div>
        <div className="session-card-time">{timeAgo(session.lastActivity)}</div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={buildMenuItems()} onClose={() => setMenu(null)} />
      )}
    </button>
  )
}
