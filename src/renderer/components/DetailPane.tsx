import { useEffect, useState, useCallback, useEffectEvent } from 'react'
import Terminal from './Terminal'
import ReviewOverlay from './ReviewOverlay'
import { useSessionsStore } from '../stores/sessions'
import { useHostsStore } from '../stores/hosts'
import { isRestartable } from '../../shared/types'

interface Props {
  sessionId: string
  sessionName: string
  onClose: () => void
}

export default function DetailPane({ sessionId, sessionName, onClose }: Props) {
  const session = useSessionsStore((s) => s.sessions.find((s) => s.id === sessionId))
  const hosts = useHostsStore((s) => s.hosts)
  const host = session?.hostId ? hosts.find((h) => h.hostId === session.hostId) : null
  const isDead = session?.status === 'dead'
  const canRestart = !!session && !isDead && isRestartable(session)
  const connectionState = session?.connectionState
  const isRemote = !!session?.hostId
  const isPending = isRemote && connectionState === 'pending'
  const isConnecting = isRemote && connectionState === 'connecting'
  const isAuthFailed = isRemote && connectionState === 'auth-failed'
  const isUnreachable = isRemote && connectionState === 'unreachable'
  // 'offline' covers post-prepareRemoteHost reconnect failures (probe /
  // reattach / bootstrap errors) that aren't auth- or network-classified.
  // Without this branch the user sees an inert Terminal pane with no Retry.
  const isOffline = isRemote && connectionState === 'offline'
  const showReconnectOverlay = !isDead && (isPending || isAuthFailed || isUnreachable || isOffline)
  const [reviving, setReviving] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  // Monotonic flip count — each toggle increments by 1, rotating +180deg.
  // Using a counter (instead of a boolean) keeps the rotation going in the
  // same direction on return instead of reversing.
  const [flipCount, setFlipCount] = useState(0)
  const reviewOpen = flipCount % 2 === 1

  const refocusTerminal = useCallback(() => {
    setTimeout(() => {
      const term = document.querySelector<HTMLElement>(
        '.detail-pane-terminal .xterm-helper-textarea'
      )
      term?.focus()
    }, 420)
  }, [])

  const closeReview = useCallback(() => {
    setFlipCount((c) => (c % 2 === 1 ? c + 1 : c))
    refocusTerminal()
  }, [refocusTerminal])

  // Review is Claude-only for now. Codex's diff/review flow is deferred to a
  // separate slice (see issue #50). Gating both the trigger and the overlay
  // keeps codex sessions out of the flip path entirely.
  const reviewEnabled = !session || session.tool === 'claude'

  const handleDocumentKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'r' && reviewEnabled) {
      e.preventDefault()
      e.stopPropagation()
      setFlipCount((c) => {
        const next = c + 1
        if (next % 2 === 0) {
          // Flipping back to terminal — refocus after animation
          refocusTerminal()
        }
        return next
      })
      return
    }

    if (e.key === 'Escape') {
      if (reviewOpen) {
        e.preventDefault()
        e.stopPropagation()
        closeReview()
        return
      }
      const target = e.target as HTMLElement
      const isTerminalFocused = target.closest('.terminal-container')
      if (!isTerminalFocused) {
        e.stopPropagation()
        onClose()
      }
    }
  })

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      handleDocumentKeyDown(e)
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [])

  // Local sessions deferred by restoreSessions() materialize their pty on
  // first open. SessionCard.openOrSelectSession also fires this, but the
  // pane can be opened via the `sessions:open-detail` IPC or keyboard, so
  // we cover that path here too. attachLocalSession is idempotent.
  useEffect(() => {
    if (!isRemote && connectionState === 'pending') {
      void window.api.attachSession(sessionId).catch(() => undefined)
    }
  }, [sessionId, isRemote, connectionState])

  const handleRevive = async () => {
    setReviving(true)
    try {
      await window.api.reviveSession(sessionId)
    } catch {
      // Main logs the failure; re-enable the button below.
    } finally {
      setReviving(false)
    }
  }

  const handleReconnect = async () => {
    setReconnecting(true)
    try {
      await window.api.reconnectSession(sessionId)
    } catch {
      // Error surfaces via the session's connectionState update; swallow so we
      // can re-enable the button.
    } finally {
      setReconnecting(false)
    }
  }

  return (
    <div className="detail-pane">
      <div className="detail-pane-header">
        <button
          className="detail-pane-close"
          onClick={onClose}
          aria-label="Back to canvas"
          title="Back to canvas"
        >
          ←
        </button>
        <span className="detail-pane-title">{sessionName}</span>
        {canRestart && (
          <button
            className="detail-pane-restart"
            onClick={handleRevive}
            disabled={reviving}
            title="Resume this session in its worktree"
          >
            {reviving ? 'Restarting…' : 'Restart session'}
          </button>
        )}
        {host && (
          <span className="detail-pane-host">
            {host.label} - {session?.connectionState ?? 'offline'}
          </span>
        )}
      </div>
      <div className="detail-pane-terminal">
        {isDead ? (
          <div className="dead-session-overlay">
            <div className="dead-session-content">
              <div className="dead-session-icon">&#x1f480;</div>
              <h3>Session terminated</h3>
              <p>
                This session&apos;s terminal was lost (e.g. after a reboot). You can restart a new
                terminal in the same worktree.
              </p>
              <button className="dead-session-restart" onClick={handleRevive} disabled={reviving}>
                {reviving ? 'Restarting…' : 'Restart terminal'}
              </button>
            </div>
          </div>
        ) : showReconnectOverlay ? (
          <div
            className={`dead-session-overlay connection-overlay connection-overlay--${connectionState}`}
          >
            <div className="dead-session-content">
              {isPending && (
                <>
                  <h3>Connecting to {host?.label ?? 'host'}</h3>
                  <p>Probing the remote tmux session.</p>
                </>
              )}
              {isAuthFailed && (
                <>
                  <h3>Authentication failed</h3>
                  <p>
                    SSH authentication to {host?.label ?? 'the host'} was rejected. Fix your
                    credentials and click Retry.
                  </p>
                </>
              )}
              {isUnreachable && (
                <>
                  <h3>Host unreachable</h3>
                  <p>
                    {host?.label ?? 'The host'} did not respond. Check your network or VPN, then
                    click Retry.
                  </p>
                </>
              )}
              {isOffline && (
                <>
                  <h3>Reconnect failed</h3>
                  <p>
                    The session could not be reattached on {host?.label ?? 'the host'}. Click Retry
                    to try again.
                  </p>
                </>
              )}
              <button
                className="dead-session-restart"
                onClick={handleReconnect}
                disabled={reconnecting || isConnecting}
              >
                {reconnecting || isConnecting ? 'Connecting…' : isPending ? 'Connect' : 'Retry'}
              </button>
            </div>
          </div>
        ) : isConnecting ? (
          <div className="dead-session-overlay connection-overlay connection-overlay--connecting">
            <div className="dead-session-content">
              <h3>Reconnecting…</h3>
              <p>Re-attaching the terminal.</p>
            </div>
          </div>
        ) : (
          <div className="flip-container">
            <div className="flip-inner" style={{ transform: `rotateY(${flipCount * 180}deg)` }}>
              <div className="flip-front">
                <Terminal sessionId={sessionId} />
              </div>
              <div className="flip-back">
                {reviewOpen && reviewEnabled && (
                  <ReviewOverlay sessionId={sessionId} onClose={closeReview} />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
