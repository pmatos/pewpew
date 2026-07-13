import { useEffect, useState, useCallback, useEffectEvent } from 'react'
import type { Session } from '../shared/types'
import BroadcastBar from './components/BroadcastBar'
import LaneHeader from './components/LaneHeader'
import Terminal from './components/Terminal'
import ReviewOverlay from './components/ReviewOverlay'
import { useThemeStore } from './stores/theme'
import { useAnimationsStore } from './stores/animations'

function parseSessionIds(): string[] {
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('sessions')
  return raw ? raw.split(',').filter(Boolean) : []
}

export default function SwimLanesApp() {
  const [sessionIds] = useState(parseSessionIds)
  const [sessions, setSessions] = useState<Session[]>([])
  const [focusedLane, setFocusedLane] = useState<string | null>(null)
  // Per-lane monotonic flip count: each toggle increments by 1, rotating +180deg.
  // Keeps the return flip in the same direction as the opening flip.
  const [laneFlipCounts, setLaneFlipCounts] = useState<Map<string, number>>(new Map())

  useEffect(() => {
    void useThemeStore.getState().init()
    void useAnimationsStore.getState().init()
  }, [])

  useEffect(() => {
    window.api.getSessions().then((all) => {
      setSessions(all.filter((s) => sessionIds.includes(s.id)))
    })

    const unsub = window.api.onSessionsUpdated((all) => {
      setSessions((all as Session[]).filter((s) => sessionIds.includes(s.id)))
    })

    return unsub
  }, [sessionIds])

  // Local sessions deferred by restoreSessions() materialize their pty on
  // first open (mirrors DetailPane). Without this, swim lanes opened from
  // multi-selected restored sessions render inert empty terminals because
  // there's no tmux/pty yet. attachLocalSession is idempotent on the main
  // side, so re-firing across sessions updates is safe.
  useEffect(() => {
    for (const s of sessions) {
      if (!s.hostId && s.connectionState === 'pending') {
        void window.api.attachSession(s.id).catch(() => undefined)
      }
    }
  }, [sessions])

  const toggleReview = useCallback((laneId: string) => {
    setLaneFlipCounts((prev) => {
      const next = new Map(prev)
      const count = (prev.get(laneId) ?? 0) + 1
      next.set(laneId, count)
      if (count % 2 === 0) {
        // Flipping back to terminal — refocus after animation
        setTimeout(() => {
          const term = document.querySelector<HTMLElement>(
            `[data-lane-id="${laneId}"] .xterm-helper-textarea`
          )
          term?.focus()
        }, 420)
      }
      return next
    })
  }, [])

  const handleReviewShortcut = useEffectEvent((e: KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'r') {
      e.preventDefault()
      e.stopPropagation()
      if (focusedLane) {
        toggleReview(focusedLane)
      }
    }
  })

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      handleReviewShortcut(e)
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [])

  const handleRevive = async (id: string) => {
    try {
      await window.api.reviveSession(id)
    } catch {
      // Error already logged in main; the swim-lane UI has no toast yet,
      // but we swallow the rejection here to avoid an unhandled promise.
    }
  }

  return (
    <div className="swim-lanes-app">
      <BroadcastBar sessionIds={sessionIds} />
      <div className="lanes-container">
        {sessionIds.map((id) => {
          const session = sessions.find((s) => s.id === id)
          const isDead = session?.status === 'dead' || session?.status === 'error'
          const flipCount = laneFlipCounts.get(id) ?? 0
          const isReviewOpen = flipCount % 2 === 1

          return (
            <div
              key={id}
              className="lane"
              data-lane-id={id}
              role="group"
              tabIndex={0}
              onClick={() => setFocusedLane(id)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setFocusedLane(id)
                }
              }}
            >
              <LaneHeader session={session} focused={focusedLane === id} />
              <div className="lane-terminal">
                {isDead ? (
                  <div className="dead-session-overlay">
                    <div className="dead-session-content">
                      <div className="dead-session-icon">&#x1f480;</div>
                      <h3>Session terminated</h3>
                      <p>Terminal was lost. You can restart it in the same worktree.</p>
                      <button className="dead-session-restart" onClick={() => handleRevive(id)}>
                        Restart terminal
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flip-container">
                    <div
                      className="flip-inner"
                      style={{ transform: `rotateY(${flipCount * 180}deg)` }}
                    >
                      <div className="flip-front">
                        <Terminal sessionId={id} />
                      </div>
                      <div className="flip-back">
                        {isReviewOpen && (
                          <ReviewOverlay sessionId={id} onClose={() => toggleReview(id)} />
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
