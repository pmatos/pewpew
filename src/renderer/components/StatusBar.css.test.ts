import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// jsdom cannot resolve flexbox layout or `auto` margins, so the status-bar
// toggle grouping is verified at the CSS-cascade seam instead: which selector
// actually resolves `margin-left: auto`. Two `margin-left: auto` items on the
// same flex row split the free space between them, stranding the anim toggle in
// the middle (issue: it drifts far from the theme toggle). Only the first-in-DOM
// toggle should carry the auto margin so both cluster at the right edge.
const cssPath = fileURLToPath(new URL('../styles/global.css', import.meta.url))
// Strip comments before parsing — like a real CSS parser, they must not bleed
// into selector text or declaration bodies.
const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function baseSelector(sel: string): string {
  return sel.trim().split(':')[0].trim()
}

// Resolve `margin-left` for a single class selector by walking every rule block
// in source order (equal specificity → last write wins) and keeping the last
// declaration from a block that targets exactly that class.
function resolveMarginLeft(className: string): string | undefined {
  const blocks = css.matchAll(/([^{}]+)\{([^{}]*)\}/g)
  let resolved: string | undefined
  for (const [, selectorList, body] of blocks) {
    const targetsClass = selectorList.split(',').some((sel) => baseSelector(sel) === className)
    if (!targetsClass) continue
    const match = body.match(/(?:^|;)\s*margin-left\s*:\s*([^;]+?)\s*(?:;|$)/)
    if (match) resolved = match[1].trim()
  }
  return resolved
}

describe('status bar toggle layout', () => {
  it('pushes the whole toggle group right via the anim toggle only', () => {
    expect(resolveMarginLeft('.anim-toggle-btn')).toBe('auto')
  })

  it('does not give the theme toggle its own auto margin', () => {
    // A second auto margin here is what splits the row and strands the anim
    // toggle in the middle.
    expect(resolveMarginLeft('.theme-toggle-btn')).not.toBe('auto')
  })
})
