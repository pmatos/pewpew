import { useSessionsStore } from '../stores/sessions'
import { useCanvasStore } from '../stores/canvas'
import { useThemeStore } from '../stores/theme'
import { useAnimationsStore } from '../stores/animations'

export default function StatusBar() {
  const { sessions } = useSessionsStore()
  const panToCluster = useCanvasStore((s) => s.panToCluster)
  const theme = useThemeStore((s) => s.theme)
  const toggleTheme = useThemeStore((s) => s.toggle)
  const reduceAnimations = useAnimationsStore((s) => s.reduceAnimations)
  const toggleAnimations = useAnimationsStore((s) => s.toggle)

  const running = sessions.filter((s) => s.status === 'running').length
  const needsInput = sessions.filter((s) => s.status === 'needs_input')
  const completed = sessions.filter((s) => s.status === 'completed').length

  const nextTheme = theme === 'dark' ? 'light' : 'dark'

  return (
    <footer className="statusbar">
      <div className="statusbar-counts">
        {sessions.length} session{sessions.length !== 1 ? 's' : ''}
        {running > 0 && <span className="status-count running"> | {running} running</span>}
        {needsInput.length > 0 && (
          <span className="status-count attention"> | {needsInput.length} needs input</span>
        )}
        {completed > 0 && <span className="status-count"> | {completed} completed</span>}
      </div>
      {needsInput.length > 0 && (
        <div className="statusbar-jumps">
          {needsInput.map((s) => (
            <button
              key={s.id}
              className="quick-jump-btn"
              onClick={() => panToCluster?.(s.projectPath)}
              title={`Jump to ${s.projectName}/${s.worktreeName}`}
            >
              {s.projectName}/{s.worktreeName}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="anim-toggle-btn"
        onClick={toggleAnimations}
        title={
          reduceAnimations
            ? 'Animations reduced — click to enable'
            : 'Reduce animations (lowers idle GPU/power)'
        }
        aria-label={reduceAnimations ? 'Enable animations' : 'Reduce animations'}
        aria-pressed={reduceAnimations}
      >
        {reduceAnimations ? '✧' : '✦'}
      </button>
      <button
        type="button"
        className="theme-toggle-btn"
        onClick={toggleTheme}
        title={`Switch to ${nextTheme} mode`}
        aria-label={`Switch to ${nextTheme} mode`}
      >
        {theme === 'dark' ? '☾' : '☀'}
      </button>
    </footer>
  )
}
