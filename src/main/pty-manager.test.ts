import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  dialog: {
    showErrorBox: () => undefined,
  },
}))

const state = {
  tmuxAvailable: true,
  bwrapAvailable: true,
  tmuxArgvCalls: [] as string[][],
  remoteArgvCalls: [] as string[][],
  mkdirCalls: [] as string[],
}

function fakePty() {
  return {
    onData: () => undefined,
    onExit: () => undefined,
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
  }
}

vi.mock('child_process', () => ({
  execFileSync: (file: string, args: string[]) => {
    if (file === 'which') {
      const [bin] = args
      if (bin === 'tmux' && !state.tmuxAvailable) throw new Error('not found')
      if (bin === 'bwrap' && !state.bwrapAvailable) throw new Error('not found')
      return ''
    }
    if (file === 'tmux' && args[0] === 'new-session') {
      state.tmuxArgvCalls.push(args)
      return ''
    }
    return ''
  },
  // hook-installer.ts (imported transitively for OMP_HOOK_SCRIPT) does
  // `promisify(execFile)` at module load time — never actually invoked by
  // these tests, but it must exist or the import throws.
  execFile: () => undefined,
}))

vi.mock('fs', () => ({
  existsSync: () => true,
  mkdirSync: (path: string) => {
    state.mkdirCalls.push(path)
  },
}))

vi.mock('node-pty', () => ({
  spawn: () => fakePty(),
}))

vi.mock('./host-connection', () => ({
  exec: async (_host: unknown, argv: string[]) => {
    state.remoteArgvCalls.push(argv)
    return { stdout: '', stderr: '', code: 0, timedOut: false }
  },
  retainHostConnection: () => undefined,
  releaseHostConnection: () => undefined,
  spawnAttach: () => fakePty(),
}))

import { homedir } from 'os'
import { buildAgentArgs, createPty, createRemotePty } from './pty-manager'
import { buildSandboxArgs } from './agent-sandbox'
import { OMP_HOOK_SCRIPT } from './hook-installer'
import type { Host } from '../shared/types'

const PROJECT = '/home/dev/project'
const WORKTREE = '/home/dev/project/.claude/worktrees/wt1'

// Fixed prefix before `...agentArgs` in the composed `tmux new-session` argv
// passed to execFileSync('tmux', [...]):
// ['new-session', '-d', '-s', tmuxSession, '-c', cwd, '-x', '120', '-y', '30', ...agentArgs]
const agentArgsFromCall = (argv: string[]): string[] => argv.slice(10)

// Same, but for the remote argv passed to execRemote(host, [...]), which
// includes the leading 'tmux' element itself (one more than the local case).
const remoteAgentArgsFromCall = (argv: string[]): string[] => argv.slice(11)

describe('buildAgentArgs', () => {
  it('defaults to claude with --dangerously-skip-permissions', () => {
    expect(buildAgentArgs()).toEqual(['claude', '--dangerously-skip-permissions'])
  })

  it('claude with continueSession appends --continue', () => {
    expect(buildAgentArgs({ tool: 'claude', continueSession: true })).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--continue',
    ])
  })

  it('codex without resume uses bypass flag only', () => {
    expect(buildAgentArgs({ tool: 'codex' })).toEqual([
      'codex',
      '--dangerously-bypass-approvals-and-sandbox',
    ])
  })

  it('codex with continueSession + agentSessionId emits resume <id>', () => {
    expect(
      buildAgentArgs({
        tool: 'codex',
        continueSession: true,
        agentSessionId: 'abc-123',
      })
    ).toEqual(['codex', 'resume', 'abc-123', '--dangerously-bypass-approvals-and-sandbox'])
  })

  it('codex with continueSession but no agentSessionId falls back to fresh spawn', () => {
    expect(buildAgentArgs({ tool: 'codex', continueSession: true })).toEqual([
      'codex',
      '--dangerously-bypass-approvals-and-sandbox',
    ])
  })

  it('uses agentPath as argv[0] when provided (claude)', () => {
    expect(buildAgentArgs({ agentPath: '/u/.local/bin/claude' })).toEqual([
      '/u/.local/bin/claude',
      '--dangerously-skip-permissions',
    ])
  })

  it('uses agentPath as argv[0] when provided (codex resume)', () => {
    expect(
      buildAgentArgs({
        tool: 'codex',
        continueSession: true,
        agentSessionId: 'abc-123',
        agentPath: '/u/.npm/codex',
      })
    ).toEqual(['/u/.npm/codex', 'resume', 'abc-123', '--dangerously-bypass-approvals-and-sandbox'])
  })

  it('omp without continueSession uses --auto-approve and the default local hook path', () => {
    expect(buildAgentArgs({ tool: 'omp' })).toEqual([
      'omp',
      '--auto-approve',
      '--hook',
      OMP_HOOK_SCRIPT,
    ])
  })

  it('omp with continueSession appends --continue (no session id needed)', () => {
    expect(buildAgentArgs({ tool: 'omp', continueSession: true })).toEqual([
      'omp',
      '--auto-approve',
      '--hook',
      OMP_HOOK_SCRIPT,
      '--continue',
    ])
  })

  it('uses agentPath as argv[0] when provided (omp)', () => {
    expect(buildAgentArgs({ tool: 'omp', agentPath: '/u/.bun/bin/omp' })).toEqual([
      '/u/.bun/bin/omp',
      '--auto-approve',
      '--hook',
      OMP_HOOK_SCRIPT,
    ])
  })

  it('omp uses notifyHookPath override when provided (remote sessions)', () => {
    expect(
      buildAgentArgs({
        tool: 'omp',
        notifyHookPath: '/home/dev/.config/pewpew/hooks/omp-notify.ts',
      })
    ).toEqual(['omp', '--auto-approve', '--hook', '/home/dev/.config/pewpew/hooks/omp-notify.ts'])
  })
})

describe('createPty', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

  beforeEach(() => {
    state.tmuxAvailable = true
    state.bwrapAvailable = true
    state.tmuxArgvCalls = []
    state.mkdirCalls = []
    warnSpy.mockClear()
  })

  it('prepends the bwrap sandbox prefix to the composed tmux argv when available', () => {
    createPty('s1', WORKTREE, { tool: 'claude', projectPath: PROJECT })
    const argv = agentArgsFromCall(state.tmuxArgvCalls[0])
    const expectedPrefix = buildSandboxArgs(PROJECT, WORKTREE, {
      enabled: true,
      extraWritablePaths: [`${homedir()}/.claude`],
    })
    expect(argv).toEqual([...expectedPrefix, ...buildAgentArgs({ tool: 'claude' })])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('creates the tool-specific state dir and opens it as an extra writable path', () => {
    createPty('s1', WORKTREE, { tool: 'omp', projectPath: PROJECT })
    expect(state.mkdirCalls).toContain(`${homedir()}/.omp`)
    const argv = agentArgsFromCall(state.tmuxArgvCalls[0])
    // The extra writable path is bound after the project's own `.git`/`.git/hooks`
    // binds, so search for '--bind' starting past the last fixed occurrence.
    const bindIdx = argv.indexOf('--bind', argv.indexOf(`${PROJECT}/.git/hooks`))
    expect(argv.slice(bindIdx, bindIdx + 3)).toEqual([
      '--bind',
      `${homedir()}/.omp`,
      `${homedir()}/.omp`,
    ])
  })

  it('omits the sandbox prefix and warns when bwrap is unavailable', () => {
    state.bwrapAvailable = false
    createPty('s1', WORKTREE, { tool: 'claude', projectPath: PROJECT })
    const argv = agentArgsFromCall(state.tmuxArgvCalls[0])
    expect(argv).toEqual(buildAgentArgs({ tool: 'claude' }))
    expect(argv).not.toContain('bwrap')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bwrap not found'))
  })

  it('skips sandboxing entirely (and never creates a state dir) when no projectPath is given', () => {
    createPty('s1', WORKTREE, { tool: 'claude' })
    const argv = agentArgsFromCall(state.tmuxArgvCalls[0])
    expect(argv).toEqual(buildAgentArgs({ tool: 'claude' }))
    expect(state.mkdirCalls).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('createRemotePty', () => {
  const host = { hostId: 'h1', alias: 'dev', label: 'Dev' } as Host

  beforeEach(() => {
    state.remoteArgvCalls = []
  })

  it('includes the sandbox prefix only when sandboxAvailable is exactly true', async () => {
    await createRemotePty('s1', WORKTREE, host, {
      tool: 'claude',
      projectPath: PROJECT,
      sandboxAvailable: true,
    })
    const argv = remoteAgentArgsFromCall(state.remoteArgvCalls[0])
    const expectedPrefix = buildSandboxArgs(PROJECT, WORKTREE, { enabled: true })
    expect(argv).toEqual([...expectedPrefix, ...buildAgentArgs({ tool: 'claude' })])
  })

  it('omits the sandbox prefix when sandboxAvailable is not set (today, no remote call site sets it)', async () => {
    await createRemotePty('s1', WORKTREE, host, { tool: 'claude', projectPath: PROJECT })
    const argv = remoteAgentArgsFromCall(state.remoteArgvCalls[0])
    expect(argv).toEqual(buildAgentArgs({ tool: 'claude' }))
    expect(argv).not.toContain('bwrap')
  })

  it('omits the sandbox prefix when no projectPath is given, regardless of sandboxAvailable', async () => {
    await createRemotePty('s1', WORKTREE, host, {
      tool: 'claude',
      sandboxAvailable: true,
    })
    const argv = remoteAgentArgsFromCall(state.remoteArgvCalls[0])
    expect(argv).toEqual(buildAgentArgs({ tool: 'claude' }))
  })
})
