import { describe, expect, it } from 'vitest'
import { CLAUDE_ENCODE_SHELL_SCRIPT, OMP_ENCODE_SHELL_SCRIPT } from './agent-state-paths'
import { buildRemoteAgentStateScript, parseRemoteAgentState } from './remote-agent-state'

// Expected bytes are the exact literals that sat inline in pty-manager before
// extraction (independent source of truth) — not re-derived from the builder.
describe('buildRemoteAgentStateScript', () => {
  it('builds the codex script that mkdirs and prints the whole ~/.codex dir', () => {
    expect(buildRemoteAgentStateScript('codex', [])).toBe(
      'd="$HOME/.codex"; mkdir -p "$d" && printf "%s" "$d"'
    )
  })

  it('builds the omp script through the shared encoder seam, keyed on the encoded worktree', () => {
    const script = buildRemoteAgentStateScript('omp', [])
    expect(script.startsWith(`${OMP_ENCODE_SHELL_SCRIPT}; `)).toBe(true)
    expect(
      script.endsWith('d="$HOME/.omp/agent/sessions/$enc"; mkdir -p "$d" && printf "%s" "$d"')
    ).toBe(true)
  })

  // The claude branch is the two-line printf whose ORDER ($d then $c) the parser
  // relies on to read ~/.claude as dirs[1]. Byte-pinned exactly (mirrors the
  // pty-manager.test.ts createRemotePty byte-pin), with the RO-dirs middle
  // asserted from a small fixture so the roDirNames parameter is exercised.
  it.each(['claude', undefined] as const)(
    'builds the two-line claude sandbox-prep script (tool=%s), interpolating the RO-dir fixture',
    (tool) => {
      const script = buildRemoteAgentStateScript(tool, ['foo', 'bar'])
      const expectedPrefix =
        `${CLAUDE_ENCODE_SHELL_SCRIPT}; ` +
        `d="$HOME/.claude/projects/$enc"; c="$HOME/.claude"; ` +
        `mkdir -p "$d" "$c" && { `
      expect(script.startsWith(expectedPrefix)).toBe(true)
      expect(script).toContain('for x in foo bar; do mkdir -p "$c/$x" 2>/dev/null; done; ')
      expect(script.endsWith('printf "%s\\n%s" "$d" "$c"; }')).toBe(true)
    }
  )
})

describe('parseRemoteAgentState', () => {
  const claudeTwoLine = {
    stdout: '/home/dev/.claude/projects/enc\n/home/dev/.claude',
    code: 0,
    timedOut: false,
  }

  it('binds ~/.claude as claudeDir from the second printed line for the claude tool', () => {
    expect(parseRemoteAgentState('claude', claudeTwoLine)).toEqual({
      writablePaths: ['/home/dev/.claude/projects/enc', '/home/dev/.claude'],
      claudeDir: '/home/dev/.claude',
    })
  })

  it('leaves claudeDir undefined for codex, whose script prints a single writable dir', () => {
    expect(
      parseRemoteAgentState('codex', { stdout: '/home/dev/.codex', code: 0, timedOut: false })
    ).toEqual({ writablePaths: ['/home/dev/.codex'], claudeDir: undefined })
  })

  it('leaves claudeDir undefined for omp, whose script prints a single writable dir', () => {
    expect(
      parseRemoteAgentState('omp', {
        stdout: '/home/dev/.omp/agent/sessions/enc',
        code: 0,
        timedOut: false,
      })
    ).toEqual({ writablePaths: ['/home/dev/.omp/agent/sessions/enc'], claudeDir: undefined })
  })

  it('filters stdout to lines that look like absolute paths, dropping shell noise', () => {
    const withNoise = {
      stdout: 'mkdir: cannot stat X\n/home/dev/.claude/projects/enc\n/home/dev/.claude',
      code: 0,
      timedOut: false,
    }
    expect(parseRemoteAgentState('claude', withNoise)).toEqual({
      writablePaths: ['/home/dev/.claude/projects/enc', '/home/dev/.claude'],
      claudeDir: '/home/dev/.claude',
    })
  })

  it('returns undefined when the probe timed out, even with otherwise-valid output', () => {
    expect(parseRemoteAgentState('claude', { ...claudeTwoLine, timedOut: true })).toBeUndefined()
  })

  it('returns undefined on a non-zero exit code', () => {
    expect(parseRemoteAgentState('claude', { ...claudeTwoLine, code: 1 })).toBeUndefined()
  })

  it('returns undefined when no line survives the absolute-path filter', () => {
    expect(
      parseRemoteAgentState('claude', { stdout: 'permission denied\n', code: 0, timedOut: false })
    ).toBeUndefined()
  })
})
