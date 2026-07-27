import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SCRIPT = join(__dirname, '../../hooks/worktree-guard.sh')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'guard-root-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

interface Decision {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string }
}

function run(payload: unknown, guardRoot = root): Decision | null {
  const out = execFileSync('bash', [SCRIPT, guardRoot], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
  })
  const trimmed = out.trim()
  return trimmed ? (JSON.parse(trimmed) as Decision) : null
}

function writePayload(filePath: string): unknown {
  return { tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' } }
}

describe('worktree-guard.sh', () => {
  it('allows a write inside the worktree root', () => {
    const decision = run(writePayload(join(root, 'inside.txt')))
    expect(decision).toBeNull()
  })

  it('allows a write to a not-yet-existing nested path inside the worktree', () => {
    const decision = run(writePayload(join(root, 'a', 'b', 'c.txt')))
    expect(decision).toBeNull()
  })

  it('allows a write to the root path itself', () => {
    const decision = run(writePayload(root))
    expect(decision).toBeNull()
  })

  it('denies a write outside the worktree', () => {
    const outside = mkdtempSync(join(tmpdir(), 'guard-outside-'))
    try {
      const decision = run(writePayload(join(outside, 'escape.txt')))
      expect(decision?.hookSpecificOutput?.permissionDecision).toBe('deny')
      expect(decision?.hookSpecificOutput?.permissionDecisionReason).toContain(
        'outside the session worktree'
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('denies a write to the parent directory of the worktree', () => {
    const parent = join(root, '..')
    const decision = run(writePayload(join(parent, 'escape.txt')))
    expect(decision?.hookSpecificOutput?.permissionDecision).toBe('deny')
  })

  it('does not let a sibling directory that merely shares the root as a prefix through', () => {
    const sibling = `${root}-evil`
    mkdirSync(sibling, { recursive: true })
    try {
      const decision = run(writePayload(join(sibling, 'file.txt')))
      expect(decision?.hookSpecificOutput?.permissionDecision).toBe('deny')
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('denies escaping through a symlink inside the worktree', () => {
    const outside = mkdtempSync(join(tmpdir(), 'guard-symlink-target-'))
    try {
      symlinkSync(outside, join(root, 'link'))
      const decision = run(writePayload(join(root, 'link', 'escape.txt')))
      expect(decision?.hookSpecificOutput?.permissionDecision).toBe('deny')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('denies writes to a new file whose parent is a symlink pointing outside', () => {
    const outside = mkdtempSync(join(tmpdir(), 'guard-symlink-target2-'))
    try {
      symlinkSync(outside, join(root, 'out-link'))
      const decision = run(writePayload(join(root, 'out-link', 'new', 'deep.txt')))
      expect(decision?.hookSpecificOutput?.permissionDecision).toBe('deny')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('handles the NotebookEdit notebook_path field', () => {
    const outside = mkdtempSync(join(tmpdir(), 'guard-nb-'))
    try {
      const decision = run({
        tool_name: 'NotebookEdit',
        tool_input: { notebook_path: join(outside, 'nb.ipynb'), new_source: 'x' },
      })
      expect(decision?.hookSpecificOutput?.permissionDecision).toBe('deny')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('allows a MultiEdit inside the worktree', () => {
    const decision = run({
      tool_name: 'MultiEdit',
      tool_input: { file_path: join(root, 'multi.txt'), edits: [] },
    })
    expect(decision).toBeNull()
  })

  it('denies edits to the worktree settings.local.json itself', () => {
    mkdirSync(join(root, '.claude'), { recursive: true })
    const settingsPath = join(root, '.claude', 'settings.local.json')
    writeFileSync(settingsPath, '{}')
    const decision = run({
      tool_name: 'Edit',
      tool_input: { file_path: settingsPath, old_string: '{}', new_string: '{"hooks":{}}' },
    })
    expect(decision?.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(decision?.hookSpecificOutput?.permissionDecisionReason).toContain('own settings file')
  })

  it('is a no-op for tools without a file_path or notebook_path', () => {
    const decision = run({ tool_name: 'Bash', tool_input: { command: 'echo hi' } })
    expect(decision).toBeNull()
  })

  it('fails open when no root argument is given', () => {
    const out = execFileSync('bash', [SCRIPT], {
      input: JSON.stringify(writePayload('/etc/passwd')),
      encoding: 'utf-8',
    })
    expect(out.trim()).toBe('')
  })

  it('fails open on malformed JSON input', () => {
    const out = execFileSync('bash', [SCRIPT, root], {
      input: '{not valid json',
      encoding: 'utf-8',
    })
    expect(out.trim()).toBe('')
  })
})
