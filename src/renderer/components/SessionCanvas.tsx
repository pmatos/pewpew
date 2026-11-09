import { useEffect, useRef, useCallback, useMemo, useLayoutEffect, useReducer } from 'react'
import { useSessionsStore } from '../stores/sessions'
import { useProjectsStore } from '../stores/projects'
import { useCanvasStore } from '../stores/canvas'
import { useThemeStore } from '../stores/theme'
import SessionCluster from './SessionCluster'
import EdgeIndicators from './EdgeIndicators'
import BroadcastDialog from './BroadcastDialog'

const MIN_ZOOM = 0.3
const RESTING_MAX_ZOOM = 1.0
const ZOOM_SENSITIVITY = 0.001
const KEYBOARD_ZOOM_STEP = 0.1
const DOT_SPACING = 30
const DOT_RADIUS = 1.5

// Source of truth in SessionCluster.tsx — keep in sync.
const CARD_WIDTH = 240
const CARD_HEIGHT = 230

// Ceiling for wheel/keyboard zoom. Must exceed what zoom-to-open needs so the
// gesture can push a card past the 95% fill threshold.
function computeMaxZoom(viewportW: number, viewportH: number): number {
  if (viewportW <= 0 || viewportH <= 0) return RESTING_MAX_ZOOM
  return Math.max(viewportW / CARD_WIDTH, viewportH / CARD_HEIGHT) * 1.05
}

// Zoom-to-open: fire when card reaches this fraction of either viewport dimension,
// sustained for DWELL_MS (filters accidental wheel flicks).
const FILL_THRESHOLD = 0.95
const DWELL_MS = 120

// Cluster identity hues. Light-theme palette uses deeper, more saturated
// counterparts so dashed borders read as identity on white instead of dust.
const ACCENT_COLORS_DARK = [
  '#4ade80',
  '#60a5fa',
  '#f472b6',
  '#facc15',
  '#a78bfa',
  '#fb923c',
  '#2dd4bf',
  '#e879f9',
]

const ACCENT_COLORS_LIGHT = [
  '#15803d',
  '#1d4ed8',
  '#be185d',
  '#a16207',
  '#6d28d9',
  '#c2410c',
  '#0f766e',
  '#86198f',
]

function hashColor(path: string, theme: 'dark' | 'light'): string {
  const palette = theme === 'light' ? ACCENT_COLORS_LIGHT : ACCENT_COLORS_DARK
  let hash = 0
  for (let i = 0; i < path.length; i++) {
    hash = (hash + path.charCodeAt(i)) * 31
  }
  return palette[Math.abs(hash) % palette.length]
}

const CLUSTER_WIDTH = 510
const CLUSTER_GAP = 40

export interface ZoomOpenPayload {
  sessionId: string
  sessionName: string
  startRect: { left: number; top: number; width: number; height: number }
  thumbnail: string | undefined
}

interface CanvasProps {
  onOpenSession?: (id: string, name: string) => void
  onZoomOpen?: (payload: ZoomOpenPayload) => void
  morphActive?: boolean
}

interface CanvasViewState {
  zoom: number
  panX: number
  panY: number
  loaded: boolean
  dragging: boolean
  clusterPositions: Record<string, { x: number; y: number }>
  viewportSize: { width: number; height: number }
}

// The viewport div only exists once persisted state has loaded and at least one
// session is present; before that the canvas renders null or the empty
// placeholder, so effects that observe the viewport must key off this.
export function isViewportMounted(loaded: boolean, sessionCount: number): boolean {
  return loaded && sessionCount > 0
}

function canvasViewReducer(
  state: CanvasViewState,
  update: Partial<CanvasViewState>
): CanvasViewState {
  return { ...state, ...update }
}

export default function SessionCanvas(props: CanvasProps) {
  return useSessionCanvasElement(props)
}

function useSessionCanvasElement({ onOpenSession, onZoomOpen, morphActive }: CanvasProps) {
  const { sessions, thumbnails, toggleSelect, rangeSelect, clearSelection } = useSessionsStore()
  const broadcastDialogOpen = useSessionsStore((s) => s.broadcastDialogOpen)
  const theme = useThemeStore((s) => s.theme)
  const projects = useProjectsStore((s) => s.projects)
  const knownPaths = useMemo(() => new Set(projects.map((p) => p.path)), [projects])
  const viewportRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLCanvasElement>(null)

  const [view, updateView] = useReducer(canvasViewReducer, {
    zoom: 0.7,
    panX: 0,
    panY: 0,
    loaded: false,
    dragging: false,
    clusterPositions: {},
    viewportSize: { width: 0, height: 0 },
  })
  const { zoom, panX, panY, loaded, dragging, clusterPositions, viewportSize } = view
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 })
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const setPanToCluster = useCanvasStore((s) => s.setPanToCluster)
  const panXRef = useRef(panX)
  const panYRef = useRef(panY)
  const zoomRef = useRef(zoom)

  // Zoom-to-open state
  const thresholdCrossedAtRef = useRef<number | null>(null)
  const isAnimatingPanRef = useRef(false)
  const zoomOpenFiredRef = useRef(false)
  const prevMorphActiveRef = useRef(false)

  useLayoutEffect(() => {
    panXRef.current = panX
    panYRef.current = panY
    zoomRef.current = zoom
  }, [panX, panY, zoom])

  // Reset the zoom-open latch when a morph ends without the session opening
  // (cancel via Escape). If the session opens, SessionCanvas unmounts so this
  // effect never runs — the ref resets naturally on the next mount.
  useEffect(() => {
    const active = morphActive ?? false
    if (prevMorphActiveRef.current && !active) {
      zoomOpenFiredRef.current = false
      thresholdCrossedAtRef.current = null
    }
    prevMorphActiveRef.current = active
  }, [morphActive])

  // Group sessions by project
  const clusters = useMemo(() => {
    const map = new Map<string, typeof sessions>()
    for (const session of sessions) {
      const existing = map.get(session.projectPath) || []
      existing.push(session)
      map.set(session.projectPath, existing)
    }
    return map
  }, [sessions])

  const { positions: resolvedClusterPositions, hasDefaultedPositions } = useMemo(() => {
    const positions = { ...clusterPositions }
    let changed = false
    let idx = Object.keys(positions).length

    for (const projectPath of clusters.keys()) {
      if (!positions[projectPath]) {
        positions[projectPath] = {
          x: (idx % 3) * (CLUSTER_WIDTH + CLUSTER_GAP) + CLUSTER_GAP,
          y: Math.floor(idx / 3) * 400 + CLUSTER_GAP,
        }
        idx++
        changed = true
      }
    }

    return { positions, hasDefaultedPositions: changed }
  }, [clusters, clusterPositions])
  const clusterPositionsRef = useRef<Record<string, { x: number; y: number }>>({})

  useLayoutEffect(() => {
    clusterPositionsRef.current = resolvedClusterPositions
  }, [resolvedClusterPositions])

  // Load persisted state
  useEffect(() => {
    Promise.all([window.api.getCanvasState(), window.api.getClusterPositions()]).then(
      ([canvasState, positions]) => {
        const update: Partial<CanvasViewState> = { loaded: true }
        if (canvasState) {
          update.zoom = canvasState.zoom
          update.panX = canvasState.panX
          update.panY = canvasState.panY
        }
        if (positions) {
          update.clusterPositions = positions
        }
        updateView(update)
      }
    )
  }, [])

  // Persist default positions for new clusters.
  useEffect(() => {
    if (!loaded || !hasDefaultedPositions) return
    window.api.saveClusterPositions(resolvedClusterPositions)
  }, [hasDefaultedPositions, loaded, resolvedClusterPositions])

  // Register panToCluster in canvas store
  useEffect(() => {
    const panToClusterFn = (projectPath: string) => {
      const pos = resolvedClusterPositions[projectPath]
      if (!pos) return
      const viewport = viewportRef.current
      if (!viewport) return
      const rect = viewport.getBoundingClientRect()

      const targetPanX = -pos.x * zoomRef.current + rect.width / 2
      const targetPanY = -pos.y * zoomRef.current + rect.height / 2

      const startPanX = panXRef.current
      const startPanY = panYRef.current
      const startTime = performance.now()
      const duration = 350

      isAnimatingPanRef.current = true
      const animate = (now: number) => {
        const t = Math.min(1, (now - startTime) / duration)
        const ease = 1 - Math.pow(1 - t, 3)
        const newPanX = startPanX + (targetPanX - startPanX) * ease
        const newPanY = startPanY + (targetPanY - startPanY) * ease
        updateView({ panX: newPanX, panY: newPanY })
        if (t < 1) {
          requestAnimationFrame(animate)
        } else {
          isAnimatingPanRef.current = false
          // Clamp zoom to RESTING_MAX_ZOOM on persist. When clamping, recompute
          // pan for the clamped zoom so the target cluster stays at viewport
          // center — matches persistCanvas and avoids cluster landing off-screen.
          const saveZoom = Math.min(zoomRef.current, RESTING_MAX_ZOOM)
          const savePanX =
            zoomRef.current > RESTING_MAX_ZOOM
              ? -pos.x * RESTING_MAX_ZOOM + rect.width / 2
              : targetPanX
          const savePanY =
            zoomRef.current > RESTING_MAX_ZOOM
              ? -pos.y * RESTING_MAX_ZOOM + rect.height / 2
              : targetPanY
          window.api.saveCanvasState({ zoom: saveZoom, panX: savePanX, panY: savePanY })
        }
      }
      requestAnimationFrame(animate)
    }

    setPanToCluster(panToClusterFn)
  }, [resolvedClusterPositions, setPanToCluster])

  const viewportMounted = isViewportMounted(loaded, sessions.length)

  // Track viewport size. Effect must re-run once the viewport div mounts.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const updateSize = () => {
      const rect = viewport.getBoundingClientRect()
      updateView({ viewportSize: { width: rect.width, height: rect.height } })
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [viewportMounted])

  // Persist canvas with debounce. Clamp zoom to RESTING_MAX_ZOOM so a
  // mid-gesture extreme zoom is never restored on next launch. When clamping,
  // also recompute pan so the viewport-center world point stays fixed — otherwise
  // on remount the user lands in empty world space far from their content.
  const persistCanvas = useCallback(
    (z: number, px: number, py: number) => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        let saveZoom = z
        let savePanX = px
        let savePanY = py
        if (z > RESTING_MAX_ZOOM && viewportSize.width > 0 && viewportSize.height > 0) {
          const worldCx = (viewportSize.width / 2 - px) / z
          const worldCy = (viewportSize.height / 2 - py) / z
          saveZoom = RESTING_MAX_ZOOM
          savePanX = viewportSize.width / 2 - worldCx * RESTING_MAX_ZOOM
          savePanY = viewportSize.height / 2 - worldCy * RESTING_MAX_ZOOM
        }
        window.api.saveCanvasState({ zoom: saveZoom, panX: savePanX, panY: savePanY })
      }, 500)
    },
    [viewportSize.width, viewportSize.height]
  )

  // Draw dot grid
  useEffect(() => {
    const canvas = gridRef.current
    const viewport = viewportRef.current
    if (!canvas || !viewport) return

    const rect = viewport.getBoundingClientRect()
    canvas.width = rect.width
    canvas.height = rect.height

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const dotColor =
      getComputedStyle(document.documentElement).getPropertyValue('--dot-grid').trim() || '#2a2a4a'
    ctx.fillStyle = dotColor

    const spacing = DOT_SPACING * zoom
    const offsetX = ((panX % spacing) + spacing) % spacing
    const offsetY = ((panY % spacing) + spacing) % spacing

    for (let x = offsetX; x < canvas.width; x += spacing) {
      for (let y = offsetY; y < canvas.height; y += spacing) {
        ctx.beginPath()
        ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    // theme is intentionally in the dep array so the dot grid repaints when
    // the user switches between dark and light mode.
  }, [zoom, panX, panY, sessions.length, theme])

  // Resize observer
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(() => {
      const canvas = gridRef.current
      if (!canvas) return
      const rect = viewport.getBoundingClientRect()
      canvas.width = rect.width
      canvas.height = rect.height
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [viewportMounted])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return

      if (e.key === '0') {
        e.preventDefault()
        updateView({ zoom: 0.7, panX: 0, panY: 0 })
        persistCanvas(0.7, 0, 0)
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        const cap = computeMaxZoom(viewportSize.width, viewportSize.height)
        const next = Math.min(cap, zoomRef.current + KEYBOARD_ZOOM_STEP)
        updateView({ zoom: next })
        persistCanvas(next, panXRef.current, panYRef.current)
      } else if (e.key === '-') {
        e.preventDefault()
        const next = Math.max(MIN_ZOOM, zoomRef.current - KEYBOARD_ZOOM_STEP)
        updateView({ zoom: next })
        persistCanvas(next, panXRef.current, panYRef.current)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [panX, panY, persistCanvas, viewportSize.width, viewportSize.height])

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      const rect = viewportRef.current?.getBoundingClientRect()
      if (!rect) return

      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top

      const cap = computeMaxZoom(rect.width, rect.height)
      const prevZoom = zoomRef.current
      const prevPanX = panXRef.current
      const prevPanY = panYRef.current
      const zoomDelta = -e.deltaY * ZOOM_SENSITIVITY * prevZoom
      const newZoom = Math.max(MIN_ZOOM, Math.min(cap, prevZoom + zoomDelta))
      const newPanX = cx - (cx - prevPanX) * (newZoom / prevZoom)
      const newPanY = cy - (cy - prevPanY) * (newZoom / prevZoom)
      updateView({ zoom: newZoom, panX: newPanX, panY: newPanY })
      persistCanvas(newZoom, newPanX, newPanY)

      // Zoom-to-open detection (wheel-only path).
      // Guards: no modal, not mid-drag, no automated pan, not already fired.
      const armed =
        !broadcastDialogOpen && !dragging && !isAnimatingPanRef.current && !zoomOpenFiredRef.current
      if (!armed) {
        thresholdCrossedAtRef.current = null
        return
      }

      // Target card: whichever .session-card sits under the cursor.
      const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      const cardEl = hit?.closest('.session-card') as HTMLElement | null
      if (!cardEl) {
        thresholdCrossedAtRef.current = null
        return
      }

      // Threshold: either dimension of the rendered card >= FILL_THRESHOLD of viewport.
      // Measure the actual rendered rect — card height varies with chip wrap.
      const cardRect = cardEl.getBoundingClientRect()
      const filled =
        cardRect.width >= rect.width * FILL_THRESHOLD ||
        cardRect.height >= rect.height * FILL_THRESHOLD
      if (!filled) {
        thresholdCrossedAtRef.current = null
        return
      }

      // Dwell: commit only after DWELL_MS of sustained threshold crossing.
      const now = performance.now()
      if (thresholdCrossedAtRef.current === null) {
        thresholdCrossedAtRef.current = now
        return
      }
      if (now - thresholdCrossedAtRef.current < DWELL_MS) return

      // Fire.
      const sessionId = cardEl.dataset.sessionId
      if (!sessionId) return
      const sessionRec = sessions.find((s) => s.id === sessionId)
      if (!sessionRec) return
      zoomOpenFiredRef.current = true
      thresholdCrossedAtRef.current = null
      onZoomOpen?.({
        sessionId,
        sessionName: `${sessionRec.projectName}/${sessionRec.worktreeName}`,
        startRect: {
          left: cardRect.left,
          top: cardRect.top,
          width: cardRect.width,
          height: cardRect.height,
        },
        thumbnail: thumbnails[sessionId],
      })
    },
    [persistCanvas, broadcastDialogOpen, dragging, sessions, thumbnails, onZoomOpen]
  )

  const handleSelect = useCallback(
    (id: string, e: React.MouseEvent) => {
      if (e.shiftKey) {
        const clusterEntry = Array.from(clusters.entries()).find(([, clusterSessions]) =>
          clusterSessions.some((s) => s.id === id)
        )
        if (clusterEntry) {
          const orderedIds = clusterEntry[1].map((s) => s.id)
          rangeSelect(id, orderedIds)
        }
      } else {
        toggleSelect(id, e.ctrlKey || e.metaKey)
      }
    },
    [clusters, rangeSelect, toggleSelect]
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest('.session-cluster')) return

      clearSelection()
      updateView({ dragging: true })
      dragStart.current = { x: e.clientX, y: e.clientY, panX, panY }
    },
    [panX, panY, clearSelection]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return
      const dx = e.clientX - dragStart.current.x
      const dy = e.clientY - dragStart.current.y
      updateView({ panX: dragStart.current.panX + dx, panY: dragStart.current.panY + dy })
    },
    [dragging]
  )

  const handleMouseUp = useCallback(() => {
    if (dragging) {
      updateView({ dragging: false })
      persistCanvas(zoom, panX, panY)
    }
  }, [dragging, zoom, panX, panY, persistCanvas])

  const handleClusterDrag = useCallback((projectPath: string, pos: { x: number; y: number }) => {
    const next = { ...clusterPositionsRef.current, [projectPath]: pos }
    clusterPositionsRef.current = next
    updateView({ clusterPositions: next })
  }, [])

  const handleClusterDragEnd = useCallback(() => {
    window.api.saveClusterPositions(clusterPositionsRef.current)
  }, [])

  if (!loaded) return null

  if (sessions.length === 0) {
    return (
      <div className="canvas-empty">
        <span className="canvas-placeholder">No sessions</span>
      </div>
    )
  }

  const transform = `translate(${panX}px, ${panY}px) scale(${zoom})`

  return (
    <div
      className="canvas-viewport"
      ref={viewportRef}
      role="application"
      tabIndex={0}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: dragging ? 'grabbing' : 'default' }}
    >
      <canvas className="dot-grid" ref={gridRef} />
      <div className="canvas-content" style={{ transform, transformOrigin: '0 0' }}>
        {Array.from(clusters.entries()).map(([projectPath, clusterSessions]) => (
          <SessionCluster
            key={projectPath}
            projectPath={projectPath}
            projectName={clusterSessions[0].projectName}
            sessions={clusterSessions}
            thumbnails={thumbnails}
            accentColor={hashColor(projectPath, theme)}
            position={resolvedClusterPositions[projectPath] || { x: 0, y: 0 }}
            zoom={zoom}
            isOrphaned={!knownPaths.has(projectPath)}
            onDrag={handleClusterDrag}
            onDragEnd={handleClusterDragEnd}
            onOpenSession={onOpenSession}
            onSelect={handleSelect}
          />
        ))}
      </div>
      <EdgeIndicators
        clusters={Array.from(clusters.entries()).map(([projectPath, clusterSessions]) => ({
          projectPath,
          projectName: clusterSessions[0].projectName,
          position: resolvedClusterPositions[projectPath] || { x: 0, y: 0 },
          color: hashColor(projectPath, theme),
        }))}
        zoom={zoom}
        panX={panX}
        panY={panY}
        viewportWidth={viewportSize.width}
        viewportHeight={viewportSize.height}
      />
      <BroadcastDialog />
    </div>
  )
}
