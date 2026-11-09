import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isViewportMounted } from './SessionCanvas'

describe('isViewportMounted', () => {
  it('is false until persisted canvas state has loaded', () => {
    expect(isViewportMounted(false, 0)).toBe(false)
    expect(isViewportMounted(false, 4)).toBe(false)
  })

  it('is false while the empty-canvas placeholder is shown', () => {
    expect(isViewportMounted(true, 0)).toBe(false)
  })

  it('is true once state has loaded and a session exists', () => {
    expect(isViewportMounted(true, 1)).toBe(true)
  })
})

// The viewport div is not mounted while the canvas is empty, so an observer
// effect that runs once (or only on `loaded`) finds a null ref, never attaches,
// and leaves the viewport size at 0x0. That hides the off-screen edge
// indicators when the first sessions are created in an empty app. jsdom is not
// available here, so the effect dependency lists are checked at the source seam.
const sourcePath = fileURLToPath(new URL('./SessionCanvas.tsx', import.meta.url))
const source = readFileSync(sourcePath, 'utf8')

function effectDeps(body: string): string[] {
  const effects = [...source.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, (\[[^\]]*\])\)/g)]
  return effects.filter(([, code]) => code.includes(body)).map(([, , deps]) => deps)
}

describe('viewport observers', () => {
  it('re-run when the viewport mounts, not only on first render or load', () => {
    const observerEffects = effectDeps('new ResizeObserver')
    expect(observerEffects).toHaveLength(2)
    for (const deps of observerEffects) {
      expect(deps).toBe('[viewportMounted]')
    }
  })

  it('derives viewportMounted from isViewportMounted', () => {
    expect(source).toContain('const viewportMounted = isViewportMounted(loaded, sessions.length)')
  })
})
