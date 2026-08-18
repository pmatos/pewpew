import { describe, expect, it } from 'vitest'
import { OMP_ENCODE_SHELL_SCRIPT } from './agent-state-paths'
import { buildRemoteAgentStateScript, parseRemoteAgentState } from './remote-agent-state'

// Expected bytes are the exact literals that sat inline in pty-manager before
// extraction (independent source of truth) — not re-derived from the builder.
describe('buildRemoteAgentStateScript', () => {
  it('builds the codex script that mkdirs and prints the whole ~/.codex dir', () => {
    expect(buildRemoteAgentStateScript('codex')).toBe(
      'd="$HOME/.codex"; mkdir -p "$d" && printf "%s" "$d"'
    )
  })

  it('builds the omp script through the shared encoder seam, keyed on the encoded worktree', () => {
    const script = buildRemoteAgentStateScript('omp')
    expect(script.startsWith(`${OMP_ENCODE_SHELL_SCRIPT}; `)).toBe(true)
    expect(
      script.endsWith('d="$HOME/.omp/agent/sessions/$enc"; mkdir -p "$d" && printf "%s" "$d"')
    ).toBe(true)
  })
})

describe('parseRemoteAgentState', () => {
  it('binds the single printed line as the writable path', () => {
    expect(parseRemoteAgentState({ stdout: '/home/dev/.codex', code: 0, timedOut: false })).toEqual(
      { writablePaths: ['/home/dev/.codex'] }
    )
  })

  it('filters stdout to lines that look like absolute paths, dropping shell noise', () => {
    const withNoise = {
      stdout: 'mkdir: cannot stat X\n/home/dev/.omp/agent/sessions/enc',
      code: 0,
      timedOut: false,
    }
    expect(parseRemoteAgentState(withNoise)).toEqual({
      writablePaths: ['/home/dev/.omp/agent/sessions/enc'],
    })
  })

  it('returns undefined when the probe timed out, even with otherwise-valid output', () => {
    expect(
      parseRemoteAgentState({ stdout: '/home/dev/.codex', code: 0, timedOut: true })
    ).toBeUndefined()
  })

  it('returns undefined on a non-zero exit code', () => {
    expect(
      parseRemoteAgentState({ stdout: '/home/dev/.codex', code: 1, timedOut: false })
    ).toBeUndefined()
  })

  it('returns undefined when no line survives the absolute-path filter', () => {
    expect(
      parseRemoteAgentState({ stdout: 'permission denied\n', code: 0, timedOut: false })
    ).toBeUndefined()
  })
})
