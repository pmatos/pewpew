import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalPath,
  encodeClaudeSessionDirName,
  CLAUDE_ENCODE_SHELL_SCRIPT,
} from './agent-state-paths'

describe('encodeClaudeSessionDirName', () => {
  it('replaces every character outside [a-zA-Z0-9-] with a hyphen', () => {
    // Non-existent path → canonicalPath returns it verbatim, so the only
    // transformation under test is the character substitution. Expected value
    // is the spec applied by hand ('/', '_', '.', ':' each become '-'), not a
    // re-run of the implementation.
    expect(encodeClaudeSessionDirName('/nonexistent-root-xyz/a_b.c:d')).toBe(
      '-nonexistent-root-xyz-a-b-c-d'
    )
  })

  it('leaves alphanumerics and hyphens untouched', () => {
    expect(encodeClaudeSessionDirName('/Ab9-Cd0')).toBe('-Ab9-Cd0')
  })

  it('canonicalizes symlinks before encoding', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-enc-'))
    try {
      const target = join(root, 'real-worktree')
      mkdirSync(target)
      const link = join(root, 'link')
      symlinkSync(target, link)
      // The symlink path and its target differ byte-for-byte, yet both must
      // encode to the target's canonical form — proof canonicalization ran.
      expect(encodeClaudeSessionDirName(link)).toBe(encodeClaudeSessionDirName(target))
      expect(encodeClaudeSessionDirName(link)).toBe(
        canonicalPath(target).replace(/[^a-zA-Z0-9-]/g, '-')
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to the input path when it cannot be canonicalized', () => {
    const missing = join(tmpdir(), 'claude-enc-does-not-exist', 'wt')
    expect(encodeClaudeSessionDirName(missing)).toBe(missing.replace(/[^a-zA-Z0-9-]/g, '-'))
  })
})

describe('CLAUDE_ENCODE_SHELL_SCRIPT', () => {
  // Pin the exact bytes of the shared fragment. Independent source of truth:
  // the literal that sat inline in session-manager.ts / pty-manager.ts before
  // extraction. Crucially it ends at `-/g')` with NO trailing `; ` — call
  // sites supply the separator, exactly as OMP_ENCODE_SHELL_SCRIPT does. A
  // stray trailing separator here would double up at every call site.
  it('is the canonicalize-then-substitute fragment with no trailing separator', () => {
    expect(CLAUDE_ENCODE_SHELL_SCRIPT).toBe(
      `p=$(CDPATH= cd -P -- "$1" 2>/dev/null && pwd -P); [ -n "$p" ] || p="$1"; enc=$(printf '%s' "$p" | sed 's/[^a-zA-Z0-9-]/-/g')`
    )
    expect(CLAUDE_ENCODE_SHELL_SCRIPT.endsWith(`-/g')`)).toBe(true)
    expect(CLAUDE_ENCODE_SHELL_SCRIPT.endsWith('; ')).toBe(false)
  })

  // Parity with the Node encoder through a real shell — the same discipline
  // the omp encoder gets in session-manager.test.ts. Unlike omp's encoding,
  // claude's is not home-/tmp-relative, so there is no $HOME/$TMPDIR juggling:
  // it is just canonicalize (cd -P/pwd -P vs realpathSync) then sed vs replace.
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-parity-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const shellEncode = (target: string): string =>
    execFileSync('sh', ['-c', `${CLAUDE_ENCODE_SHELL_SCRIPT}; printf '%s' "$enc"`, '_', target], {
      encoding: 'utf-8',
    })

  it('matches encodeClaudeSessionDirName for real paths, including a colon', () => {
    const nested = join(root, 'proj:ect', 'wt-1')
    mkdirSync(nested, { recursive: true })
    for (const target of [root, nested]) {
      expect(shellEncode(target)).toBe(encodeClaudeSessionDirName(target))
    }
  })

  it('matches the Node encoder on a non-existent path (both fall back to input)', () => {
    const missing = join(root, 'no-such-sub', 'wt')
    expect(shellEncode(missing)).toBe(encodeClaudeSessionDirName(missing))
  })
})
