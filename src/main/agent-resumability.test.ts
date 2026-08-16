import { describe, expect, it } from 'vitest'
import { CLAUDE_ENCODE_SHELL_SCRIPT, OMP_ENCODE_SHELL_SCRIPT } from './agent-state-paths'
import type { Host, Session } from '../shared/types'
import { canResumeLocal, canResumeRemote, resumeSourceForTool } from './agent-resumability'

type ResumeInput = Pick<Session, 'tool' | 'agentSessionId' | 'worktreePath'>

const HOST: Host = { hostId: 'h1', alias: 'devbox', label: 'Dev' }

interface ExecCall {
  argv: string[]
  timeoutMs?: number
}

// A fake remote exec that records every invocation and returns a canned result.
function fakeExec(result: { code: number; timedOut: boolean }): {
  exec: (host: Host, argv: string[], opts?: { timeoutMs?: number }) => Promise<typeof result>
  calls: ExecCall[]
} {
  const calls: ExecCall[] = []
  return {
    calls,
    exec: async (_host, argv, opts) => {
      calls.push({ argv, timeoutMs: opts?.timeoutMs })
      return result
    },
  }
}

function sessionLike(overrides: Partial<ResumeInput> = {}): ResumeInput {
  return { tool: 'claude', worktreePath: '/tmp/does-not-exist-xyz', ...overrides }
}

describe('resumeSourceForTool', () => {
  // The per-tool resume policy that previously lived — duplicated — in both the
  // local and remote resume dispatchers, and once drifted between them (the
  // remote branch hardcoded `--continue`). Pinned here as the single source of
  // truth so the two dispatchers can only ever agree.
  it('codex resumes off its captured agentSessionId', () => {
    expect(resumeSourceForTool('codex')).toBe('agent-session-id')
  })

  it('omp resumes off its conversation history', () => {
    expect(resumeSourceForTool('omp')).toBe('omp-history')
  })

  it('claude resumes off its conversation history', () => {
    expect(resumeSourceForTool('claude')).toBe('claude-history')
  })
})

describe('canResumeLocal', () => {
  it('codex can resume when an agentSessionId was captured', () => {
    expect(canResumeLocal(sessionLike({ tool: 'codex', agentSessionId: 'abc-123' }))).toBe(true)
  })

  it('codex cannot resume without an agentSessionId', () => {
    expect(canResumeLocal(sessionLike({ tool: 'codex', agentSessionId: undefined }))).toBe(false)
  })

  it('claude consults the injected claude history probe', () => {
    const seen: string[] = []
    const resume = canResumeLocal(sessionLike({ tool: 'claude', worktreePath: '/wt/a' }), {
      hasClaudeConversationHistory: (p) => {
        seen.push(p)
        return true
      },
      hasOmpConversationHistory: () => false,
    })
    expect(resume).toBe(true)
    expect(seen).toEqual(['/wt/a'])
  })

  it('omp consults the injected omp history probe, not the claude one', () => {
    const resume = canResumeLocal(sessionLike({ tool: 'omp', worktreePath: '/wt/b' }), {
      hasClaudeConversationHistory: () => {
        throw new Error('claude probe must not be consulted for omp')
      },
      hasOmpConversationHistory: (p) => p === '/wt/b',
    })
    expect(resume).toBe(true)
  })

  it('reports no history for a worktree with no conversation directory (real fs)', () => {
    expect(canResumeLocal(sessionLike({ tool: 'claude' }))).toBe(false)
    expect(canResumeLocal(sessionLike({ tool: 'omp' }))).toBe(false)
  })
})

describe('canResumeRemote', () => {
  it('codex resumes off its agentSessionId without probing the remote', async () => {
    const { exec, calls } = fakeExec({ code: 1, timedOut: false })
    const resume = await canResumeRemote(
      sessionLike({ tool: 'codex', agentSessionId: 'abc-123' }),
      HOST,
      exec
    )
    expect(resume).toBe(true)
    expect(calls).toEqual([])
  })

  it('codex cannot resume without an agentSessionId, still without probing', async () => {
    const { exec, calls } = fakeExec({ code: 0, timedOut: false })
    const resume = await canResumeRemote(sessionLike({ tool: 'codex' }), HOST, exec)
    expect(resume).toBe(false)
    expect(calls).toEqual([])
  })

  it('claude resumes when the remote history probe exits 0', async () => {
    const { exec } = fakeExec({ code: 0, timedOut: false })
    expect(await canResumeRemote(sessionLike({ tool: 'claude' }), HOST, exec)).toBe(true)
  })

  it('claude spawns fresh when the remote history probe exits 1', async () => {
    const { exec } = fakeExec({ code: 1, timedOut: false })
    expect(await canResumeRemote(sessionLike({ tool: 'claude' }), HOST, exec)).toBe(false)
  })

  it('omp resumes when the remote history probe exits 0', async () => {
    const { exec } = fakeExec({ code: 0, timedOut: false })
    expect(await canResumeRemote(sessionLike({ tool: 'omp' }), HOST, exec)).toBe(true)
  })

  it('does not resume when the probe times out, even on exit 0', async () => {
    const { exec } = fakeExec({ code: 0, timedOut: true })
    expect(await canResumeRemote(sessionLike({ tool: 'claude' }), HOST, exec)).toBe(false)
    expect(await canResumeRemote(sessionLike({ tool: 'omp' }), HOST, exec)).toBe(false)
  })

  it('does not resume when the exec rejects (SSH failure)', async () => {
    const exec = async (): Promise<{ code: number; timedOut: boolean }> => {
      throw new Error('ssh: connect to host failed')
    }
    expect(await canResumeRemote(sessionLike({ tool: 'claude' }), HOST, exec)).toBe(false)
    expect(await canResumeRemote(sessionLike({ tool: 'omp' }), HOST, exec)).toBe(false)
  })

  // Byte-pins the composed remote probe scripts at the seam between the shared
  // encode fragment (independently pinned in agent-state-paths.test.ts) and each
  // tool's `ls -A` tail. The tail literals are transcribed independently from
  // the original inline call sites, so a retyping error in production is caught.
  // The claude tail reads $HOME directly; the omp tail reads $h — a variable set
  // *inside* OMP_ENCODE_SHELL_SCRIPT — and that asymmetry is load-bearing.
  it('sends the exact composed claude probe under a 10s timeout', async () => {
    const { exec, calls } = fakeExec({ code: 0, timedOut: false })
    await canResumeRemote(sessionLike({ tool: 'claude', worktreePath: '/wt/a' }), HOST, exec)
    expect(calls).toEqual([
      {
        argv: [
          'sh',
          '-c',
          `${CLAUDE_ENCODE_SHELL_SCRIPT}; [ -n "$(ls -A "$HOME/.claude/projects/$enc" 2>/dev/null)" ]`,
          '_',
          '/wt/a',
        ],
        timeoutMs: 10000,
      },
    ])
  })

  it('sends the exact composed omp probe under a 10s timeout', async () => {
    const { exec, calls } = fakeExec({ code: 0, timedOut: false })
    await canResumeRemote(sessionLike({ tool: 'omp', worktreePath: '/wt/b' }), HOST, exec)
    expect(calls).toEqual([
      {
        argv: [
          'sh',
          '-c',
          `${OMP_ENCODE_SHELL_SCRIPT}; [ -n "$(ls -A "$h/.omp/agent/sessions/$enc" 2>/dev/null)" ]`,
          '_',
          '/wt/b',
        ],
        timeoutMs: 10000,
      },
    ])
  })
})
