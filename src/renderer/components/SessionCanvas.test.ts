import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
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
// indicators when the first sessions are created in an empty app. Resizing the
// grid canvas also clears its bitmap, so the grid must redraw on size changes.
// jsdom is not available here, so the effect dependency lists are checked by
// parsing the component source.
const sourcePath = fileURLToPath(new URL('./SessionCanvas.tsx', import.meta.url))
const sourceFile = ts.createSourceFile(
  sourcePath,
  readFileSync(sourcePath, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)

interface EffectInfo {
  body: string
  deps: string[]
}

function collectEffects(): EffectInfo[] {
  const effects: EffectInfo[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useEffect'
    ) {
      const [callback, deps] = node.arguments
      effects.push({
        body: callback ? callback.getText(sourceFile) : '',
        deps:
          deps && ts.isArrayLiteralExpression(deps)
            ? deps.elements.map((el) => el.getText(sourceFile))
            : [],
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return effects
}

describe('viewport effects', () => {
  const effects = collectEffects()

  it('attaches a single resize observer that re-runs when the viewport mounts', () => {
    const observers = effects.filter((e) => e.body.includes('new ResizeObserver'))
    expect(observers).toHaveLength(1)
    expect(observers[0]?.deps).toEqual(['viewportMounted'])
  })

  it('redraws the dot grid whenever the viewport size changes', () => {
    const grid = effects.filter((e) => e.body.includes('getContext'))
    expect(grid).toHaveLength(1)
    expect(grid[0]?.deps).toEqual(
      expect.arrayContaining(['viewportSize.width', 'viewportSize.height'])
    )
  })

  it('derives viewportMounted from isViewportMounted', () => {
    expect(sourceFile.text).toContain(
      'const viewportMounted = isViewportMounted(loaded, sessions.length)'
    )
  })
})
