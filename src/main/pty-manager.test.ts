import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  dialog: {
    showErrorBox: () => undefined,
  },
}))

const state = {
  tmuxAvailable: true,
  bwrapAvailable: true,
  tmuxCalls: [] as string[][],
  // Which tmux servers (by -L name, or 'default') answer has-session.
  liveTmuxServers: new Set<string>(['pewpew']),
  tmuxListOutput: {} as Record<string, string>,
  remoteArgvCalls: [] as string[][],
  mkdirCalls: [] as string[],
  // Controls what resolveRemoteGitDir returns (empty → fallback to
  // `<project>/.git`).
  remoteGitDir: '' as string,
  // Controls what resolveRemoteAgentStateDir returns (undefined → sandbox
  // disabled, since a missing state bind would make the agent's first write
  // hit EROFS under --ro-bind / /). Only codex/omp ever call it — claude is
  // never sandboxed.
  remoteStateDir: '/home/dev/.omp/agent/sessions/encoded-wt1' as string | undefined,
  // Every fakePty ever handed to production code, in spawn order, so a test can
  // drive the handlers pty-manager registered on it.
  ptys: [] as FakePty[],
  retainCalls: [] as string[],
  releaseCalls: [] as string[],
  broadcasts: [] as Array<[string, unknown]>,
  captureOutput: '',
}

interface FakePty {
  onData: (fn: (data: string) => void) => void
  onExit: (fn: () => void) => void
  write: () => void
  resize: () => void
  kill: () => void
  emitData: (data: string) => void
  emitExit: () => void
  killed: boolean
}

// Handlers accumulate in arrays rather than single slots: host-connection's
// spawnAttach registers its own onExit on the same pty in production, so a
// single-slot fake would bake in an assumption that is false there.
function fakePty(): FakePty {
  const dataHandlers: Array<(data: string) => void> = []
  const exitHandlers: Array<() => void> = []
  const p: FakePty = {
    onData: (fn) => {
      dataHandlers.push(fn)
    },
    onExit: (fn) => {
      exitHandlers.push(fn)
    },
    write: () => undefined,
    resize: () => undefined,
    kill: () => {
      p.killed = true
    },
    emitData: (data) => {
      for (const fn of dataHandlers) fn(data)
    },
    emitExit: () => {
      for (const fn of exitHandlers) fn()
    },
    killed: false,
  }
  state.ptys.push(p)
  return p
}

const lastPty = (): FakePty => {
  const p = state.ptys[state.ptys.length - 1]
  if (!p) throw new Error('no pty was spawned')
  return p
}

vi.mock('child_process', () => ({
  execFileSync: (file: string, args: string[]) => {
    if (file === 'which') {
      const [bin] = args
      if (bin === 'tmux' && !state.tmuxAvailable) throw new Error('not found')
      return ''
    }
    // isSandboxAvailable() no longer checks `which bwrap` — it runs a real
    // (minimal) bwrap invocation, so the fake has to answer to `bwrap` itself.
    if (file === 'bwrap') {
      if (!state.bwrapAvailable) throw new Error('not found')
      return ''
    }
    if (file === 'tmux') {
      state.tmuxCalls.push(args)
      const server = args[0] === '-L' ? args[1] : 'default'
      if (args.includes('has-session') && !state.liveTmuxServers.has(server)) {
        throw new Error('no server running')
      }
      if (args.includes('list-sessions')) return state.tmuxListOutput[server] ?? ''
      if (args.includes('capture-pane')) return state.captureOutput
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
  realpathSync: (path: string) => path,
}))

vi.mock('node-pty', () => ({
  spawn: () => fakePty(),
}))

vi.mock('./host-connection', () => ({
  exec: async (_host: unknown, argv: string[]) => {
    state.remoteArgvCalls.push(argv)
    // resolveRemoteGitDir: `git -C <projectPath> rev-parse --git-common-dir`
    if (argv[0] === 'git' && argv.includes('--git-common-dir')) {
      return { stdout: state.remoteGitDir ?? '', stderr: '', code: 0, timedOut: false }
    }
    // resolveRemoteAgentStateDir (codex/omp only — claude is never
    // sandboxed): `sh -c <script> _ <worktreePath>` — the script prints the
    // writable dir path after mkdir'ing it. Return a fixed path so
    // sandboxing can be enabled; tests that need it disabled set
    // state.remoteStateDir to undefined.
    if (argv[0] === 'sh' && typeof argv[2] === 'string') {
      const script = argv[2]
      if (script.includes('.codex') || script.includes('.omp/agent/sessions')) {
        const dir = state.remoteStateDir
        return {
          stdout: dir ?? '',
          stderr: '',
          code: dir ? 0 : 1,
          timedOut: false,
        }
      }
    }
    return { stdout: '', stderr: '', code: 0, timedOut: false }
  },
  retainHostConnection: (hostId: string) => {
    state.retainCalls.push(hostId)
  },
  releaseHostConnection: (hostId: string) => {
    state.releaseCalls.push(hostId)
  },
  spawnAttach: () => fakePty(),
}))

vi.mock('./window-registry', () => ({
  broadcastToAll: (channel: string, payload: unknown) => {
    state.broadcasts.push([channel, payload])
  },
}))

import { homedir } from 'os'
import { join } from 'path'
import {
  buildAgentArgs,
  createPty,
  captureThumbnails,
  createRemotePty,
  destroyPty,
  destroyRemotePty,
  detachPty,
  discoverTmuxSessions,
  hasPty,
  hasTmuxSession,
  reattachPty,
  reattachRemotePty,
  setUnexpectedExitListener,
  stopPtyManager,
  TMUX_SOCKET,
  __resetSandboxProbeCacheForTesting,
} from './pty-manager'
import type { PtyPlacement } from './pty-manager'
import { buildSandboxArgs } from './agent-sandbox'
import { OMP_HOOK_SCRIPT } from './hook-installer'
import { canonicalPath, encodeOmpSessionDirName } from './agent-state-paths'
import type { Host } from '../shared/types'

const PROJECT = '/home/dev/project'
const WORKTREE = '/home/dev/project/.claude/worktrees/wt1'

// Fixed prefix before `...agentArgs` in the composed `tmux new-session` argv
// passed to execFileSync('tmux', [...]):
// ['-L', 'pewpew', 'new-session', '-d', '-s', tmuxSession, '-c', cwd, '-x', '120', '-y', '30',
//  'env', '-u', 'TMUX', '-u', 'TMUX_PANE', ...agentArgs]
const AGENT_ENV_SCRUB = ['env', '-u', 'TMUX', '-u', 'TMUX_PANE']
const newSessionCall = (): string[] =>
  state.tmuxCalls.find((argv) => argv.includes('new-session')) ?? []
const LOCAL_TMUX_PREFIX_LEN = 12
const agentArgsFromCall = (argv: string[]): string[] =>
  argv.slice(LOCAL_TMUX_PREFIX_LEN + AGENT_ENV_SCRUB.length)

// Same, but for the remote argv passed to execRemote(host, [...]), which
// includes the leading 'tmux' element itself (one more than the local case).
const remoteAgentArgsFromCall = (argv: string[]): string[] => argv.slice(11)

beforeEach(() => {
  state.ptys = []
  state.retainCalls = []
  state.releaseCalls = []
  state.broadcasts = []
  state.captureOutput = ''
})

describe('buildAgentArgs', () => {
  it('defaults to claude with --permission-mode auto', () => {
    expect(buildAgentArgs()).toEqual(['claude', '--permission-mode', 'auto'])
  })

  it('claude with continueSession appends --continue', () => {
    expect(buildAgentArgs({ tool: 'claude', continueSession: true })).toEqual([
      'claude',
      '--permission-mode',
      'auto',
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
      '--permission-mode',
      'auto',
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
    state.tmuxCalls = []
    state.liveTmuxServers = new Set(['pewpew'])
    state.tmuxListOutput = {}
    state.mkdirCalls = []
    // isSandboxAvailable() memoizes a successful real-bwrap probe; without
    // resetting it here, the first test to see bwrapAvailable=true would
    // permanently mask every later test simulating bwrap being unusable.
    __resetSandboxProbeCacheForTesting()
    warnSpy.mockClear()
  })

  it('runs local tmux calls on the dedicated pewpew socket', () => {
    createPty('s1', WORKTREE, { tool: 'claude' })
    reattachPty('s1')
    expect(hasTmuxSession('s1')).toBe(true)
    destroyPty('s1')
    expect(state.tmuxCalls.length).toBeGreaterThan(0)
    for (const argv of state.tmuxCalls) {
      expect(argv.slice(0, 2)).toEqual(['-L', TMUX_SOCKET])
    }
  })

  it('keeps managing a session still alive on the default server (pre-dedicated-socket upgrade)', async () => {
    state.liveTmuxServers = new Set(['default'])
    expect(hasTmuxSession('legacy')).toBe(true)
    state.tmuxCalls = []

    reattachPty('legacy')
    await captureThumbnails()
    destroyPty('legacy')

    const attachAndKill = state.tmuxCalls.filter(
      (argv) => argv.includes('capture-pane') || argv.includes('kill-session')
    )
    expect(attachAndKill.length).toBe(3)
    for (const argv of attachAndKill) {
      expect(argv[0]).not.toBe('-L')
    }
  })

  it('kills on both servers, without probing first, when no pty entry is registered', () => {
    state.liveTmuxServers = new Set()
    state.tmuxCalls = []

    destroyPty('orphan')

    expect(state.tmuxCalls.some((argv) => argv.includes('has-session'))).toBe(false)
    const kills = state.tmuxCalls.filter((argv) => argv.includes('kill-session'))
    expect(kills.map((argv) => argv[0])).toEqual(['-L', 'kill-session'])
  })

  it('reports no tmux session when neither server has it', () => {
    state.liveTmuxServers = new Set()
    expect(hasTmuxSession('gone')).toBe(false)
  })

  it('discovers pewpew sessions from both the dedicated and the default server', () => {
    state.tmuxListOutput = {
      pewpew: 'pewpew-a1\nnotes\n',
      default: 'pewpew-b2\npewpew-a1\nwork\n',
    }
    expect(discoverTmuxSessions().sort()).toEqual(['a1', 'b2'])
  })

  it('unsets TMUX/TMUX_PANE for the agent so its own bare tmux calls miss pewpew’s server', () => {
    createPty('s1', WORKTREE, { tool: 'claude' })
    expect(newSessionCall().join(' ')).toContain(AGENT_ENV_SCRUB.join(' '))
  })

  it('never sandboxes claude, even when bwrap is available, and never probes or warns about it', () => {
    createPty('s1', WORKTREE, { tool: 'claude', projectPath: PROJECT })
    const argv = agentArgsFromCall(newSessionCall())
    expect(argv).toEqual(buildAgentArgs({ tool: 'claude' }))
    expect(argv).not.toContain('bwrap')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("still creates the per-worktree ~/.claude/projects/<encoded> dir as session-manager's resume marker, even though claude is never sandboxed", () => {
    createPty('s1', WORKTREE, { tool: 'claude', projectPath: PROJECT })
    const claudeStateDir = join(
      homedir(),
      '.claude',
      'projects',
      canonicalPath(WORKTREE).replace(/[^a-zA-Z0-9-]/g, '-')
    )
    expect(state.mkdirCalls).toContain(claudeStateDir)
  })

  it('creates the tool-specific per-worktree state dir and opens only that as an extra writable path (omp)', () => {
    createPty('s1', WORKTREE, { tool: 'omp', projectPath: PROJECT })
    const ompStateDir = join(
      homedir(),
      '.omp',
      'agent',
      'sessions',
      encodeOmpSessionDirName(WORKTREE)
    )
    expect(state.mkdirCalls).toContain(ompStateDir)
    // Not the whole ~/.omp dir — only this worktree's own session subdirectory.
    expect(state.mkdirCalls).not.toContain(join(homedir(), '.omp'))
    // omp doesn't touch ~/.claude at all — that's claude-specific bookkeeping.
    expect(state.mkdirCalls).not.toContain(join(homedir(), '.claude'))
    const argv = agentArgsFromCall(newSessionCall())
    // The extra writable path is bound after the project's own `.git`/`.git/hooks`
    // binds, so search for '--bind-try' starting past the last fixed occurrence.
    // Extra paths use --bind-try so a missing source can't crash bwrap's spawn.
    const bindIdx = argv.indexOf('--bind-try', argv.indexOf(`${PROJECT}/.git/hooks`))
    expect(argv.slice(bindIdx, bindIdx + 3)).toEqual(['--bind-try', ompStateDir, ompStateDir])
  })

  it('omits the sandbox prefix and warns when bwrap is unavailable (omp)', () => {
    state.bwrapAvailable = false
    createPty('s1', WORKTREE, { tool: 'omp', projectPath: PROJECT })
    const argv = agentArgsFromCall(newSessionCall())
    expect(argv).toEqual(buildAgentArgs({ tool: 'omp' }))
    expect(argv).not.toContain('bwrap')
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('bwrap missing or unable to sandbox')
    )
  })

  it('skips sandboxing entirely (and never creates a state dir) when no projectPath is given', () => {
    createPty('s1', WORKTREE, { tool: 'claude' })
    const argv = agentArgsFromCall(newSessionCall())
    expect(argv).toEqual(buildAgentArgs({ tool: 'claude' }))
    expect(state.mkdirCalls).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('createRemotePty', () => {
  const host = { hostId: 'h1', alias: 'dev', label: 'Dev' } as Host
  const OMP_STATE_DIR = '/home/dev/.omp/agent/sessions/encoded-wt1'
  const REMOTE_SOCKET_DIR = '/tmp/pewpew-remote'
  const REMOTE_SOCKET = `${REMOTE_SOCKET_DIR}/hook.sock`

  beforeEach(() => {
    state.remoteArgvCalls = []
    state.remoteGitDir = ''
    state.remoteStateDir = OMP_STATE_DIR
  })

  // The tmux new-session call is the one whose argv starts with 'tmux' — the
  // git/state-dir resolution calls precede it and pollute remoteArgvCalls.
  function tmuxCall(): string[] {
    return state.remoteArgvCalls.find((argv) => argv[0] === 'tmux') ?? []
  }

  it('never sandboxes claude remotely, even when sandboxAvailable is true, and skips the state-dir SSH round trip entirely', async () => {
    await createRemotePty('s1', WORKTREE, host, {
      tool: 'claude',
      projectPath: PROJECT,
      sandboxAvailable: true,
      remoteSocketPath: REMOTE_SOCKET,
    })
    const argv = remoteAgentArgsFromCall(tmuxCall())
    expect(argv).toEqual(buildAgentArgs({ tool: 'claude' }))
    expect(argv).not.toContain('bwrap')
    expect(state.remoteArgvCalls.some((argv) => argv[0] === 'sh')).toBe(false)
  })

  it('includes the sandbox prefix with state and stable hook socket directory when sandboxAvailable is true (omp)', async () => {
    await createRemotePty('s1', WORKTREE, host, {
      tool: 'omp',
      projectPath: PROJECT,
      sandboxAvailable: true,
      remoteSocketPath: REMOTE_SOCKET,
    })
    const argv = remoteAgentArgsFromCall(tmuxCall())
    const expectedPrefix = buildSandboxArgs(PROJECT, WORKTREE, {
      enabled: true,
      extraWritablePaths: [OMP_STATE_DIR],
      extraReadOnlyPaths: [REMOTE_SOCKET_DIR],
      gitDir: `${PROJECT}/.git`,
    })
    expect(argv).toEqual([...expectedPrefix, ...buildAgentArgs({ tool: 'omp' })])
  })

  it('uses the resolved gitDir when the remote reports a gitfile root (omp)', async () => {
    state.remoteGitDir = '/home/dev/real-repo/.git'
    await createRemotePty('s1', WORKTREE, host, {
      tool: 'omp',
      projectPath: PROJECT,
      sandboxAvailable: true,
    })
    const argv = remoteAgentArgsFromCall(tmuxCall())
    expect(argv).toContain('--bind')
    expect(argv).toContain('/home/dev/real-repo/.git')
    expect(argv).not.toContain(`${PROJECT}/.git`)
  })

  it('disables sandboxing when the remote state dir cannot be resolved (omp)', async () => {
    state.remoteStateDir = undefined
    await createRemotePty('s1', WORKTREE, host, {
      tool: 'omp',
      projectPath: PROJECT,
      sandboxAvailable: true,
    })
    const argv = remoteAgentArgsFromCall(tmuxCall())
    expect(argv).toEqual(buildAgentArgs({ tool: 'omp' }))
    expect(argv).not.toContain('bwrap')
  })

  it('omits the sandbox prefix when sandboxAvailable is not set (omp)', async () => {
    await createRemotePty('s1', WORKTREE, host, { tool: 'omp', projectPath: PROJECT })
    const argv = remoteAgentArgsFromCall(tmuxCall())
    expect(argv).toEqual(buildAgentArgs({ tool: 'omp' }))
    expect(argv).not.toContain('bwrap')
  })

  it('skips the remote state-dir SSH round trip entirely when sandboxAvailable is not set (omp)', async () => {
    await createRemotePty('s1', WORKTREE, host, { tool: 'omp', projectPath: PROJECT })
    // Not just "its result is discarded" — the `sh -c` call that mkdir's a
    // real directory under the remote home must never be issued when the
    // sandbox won't be used on this host at all.
    expect(state.remoteArgvCalls.some((argv) => argv[0] === 'sh')).toBe(false)
  })

  it('omits the sandbox prefix when no projectPath is given, regardless of sandboxAvailable', async () => {
    await createRemotePty('s1', WORKTREE, host, {
      tool: 'omp',
      sandboxAvailable: true,
    })
    const argv = remoteAgentArgsFromCall(tmuxCall())
    expect(argv).toEqual(buildAgentArgs({ tool: 'omp' }))
  })
})

// The registration epilogue every spawn path shares. Nothing here was
// observable before: fakePty() used to stub onData/onExit as no-ops, and
// reattachPty/reattachRemotePty had no tests at all.
describe('pty registration', () => {
  const host = { hostId: 'h1', alias: 'dev', label: 'Dev' } as Host

  afterEach(() => {
    for (const id of ['reg-lc', 'reg-rc', 'reg-lr', 'reg-rr', 'reg-td', 'reg-replay']) {
      detachPty(id)
    }
    setUnexpectedExitListener(null)
    stopPtyManager()
  })

  // The lease matrix. A remote pty holds the host's SSH connection for its
  // lifetime and is the only path back to releaseHostConnection; a local one
  // holds nothing. Forgetting either half is silent today.
  it('a local pty retains nothing and releases nothing when it exits on its own', () => {
    createPty('reg-lc', WORKTREE, { tool: 'claude' })
    expect(state.retainCalls).toEqual([])

    lastPty().emitExit()

    expect(state.releaseCalls).toEqual([])
  })

  it('a remote pty retains on registration and releases exactly once when it exits', async () => {
    await createRemotePty('reg-rc', WORKTREE, host, { tool: 'claude' })
    expect(state.retainCalls).toEqual(['h1'])
    expect(state.releaseCalls).toEqual([])

    lastPty().emitExit()
    expect(state.releaseCalls).toEqual(['h1'])

    lastPty().emitExit()
    expect(state.releaseCalls).toEqual(['h1'])
  })

  it('a local reattach retains nothing and releases nothing when it exits', () => {
    reattachPty('reg-lr')
    expect(state.retainCalls).toEqual([])

    lastPty().emitExit()

    expect(state.releaseCalls).toEqual([])
  })

  it('a remote reattach retains, and releases exactly once when it exits', async () => {
    await reattachRemotePty('reg-rr', host)
    expect(state.retainCalls).toEqual(['h1'])

    lastPty().emitExit()

    expect(state.releaseCalls).toEqual(['h1'])
  })

  it('releases exactly once when teardown beats the exit handler to it', async () => {
    await reattachRemotePty('reg-td', host)
    const ptyProcess = lastPty()

    await destroyRemotePty('reg-td', host)
    expect(state.releaseCalls).toEqual(['h1'])

    ptyProcess.emitExit()
    expect(state.releaseCalls).toEqual(['h1'])
  })

  // The other half of the epilogue: output is wired into the coalescing buffer,
  // and an exit that did not go through teardown reports the session as dead.
  it('streams pty output to every window through the coalescing flush', () => {
    vi.useFakeTimers()
    try {
      createPty('reg-replay', WORKTREE, { tool: 'claude' })
      lastPty().emitData('hello')
      expect(state.broadcasts).toEqual([])

      vi.advanceTimersByTime(16)

      expect(state.broadcasts).toEqual([['pty:data', { sessionId: 'reg-replay', data: 'hello' }]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays captured scrollback ahead of live output on reattach', () => {
    state.captureOutput = 'prior output'
    vi.useFakeTimers()
    try {
      reattachPty('reg-replay')
      lastPty().emitData(' and live')

      vi.advanceTimersByTime(16)

      expect(state.broadcasts).toEqual([
        ['pty:data', { sessionId: 'reg-replay', data: 'prior output and live' }],
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports an exit that did not go through teardown as an unexpected exit', () => {
    const exited: string[] = []
    setUnexpectedExitListener((id) => exited.push(id))

    createPty('reg-lc', WORKTREE, { tool: 'claude' })
    lastPty().emitExit()

    expect(exited).toEqual(['reg-lc'])
    expect(hasPty('reg-lc')).toBe(false)
  })

  it('stays silent when the entry was already torn down', () => {
    const exited: string[] = []
    setUnexpectedExitListener((id) => exited.push(id))

    createPty('reg-lc', WORKTREE, { tool: 'claude' })
    const ptyProcess = lastPty()
    detachPty('reg-lc')

    ptyProcess.emitExit()

    expect(exited).toEqual([])
  })
})

// The placement union is the whole point of the interface: a registration site
// states where the pty lives, and the lease rule follows from that rather than
// from a line it has to remember. These assertions are checked by `tsc`, not at
// runtime — each @ts-expect-error is itself an error if the code below compiles.
describe('PtyPlacement', () => {
  const host = { hostId: 'h1', alias: 'dev', label: 'Dev' } as Host

  it('cannot describe a pty that is both local and remote, or neither', () => {
    const local: PtyPlacement = { kind: 'local', tmuxSocket: TMUX_SOCKET }
    const remote: PtyPlacement = { kind: 'remote', host }
    expect([local.kind, remote.kind]).toEqual(['local', 'remote'])

    // @ts-expect-error a remote placement has no tmux socket of its own
    const mixed: PtyPlacement = { kind: 'remote', host, tmuxSocket: TMUX_SOCKET }
    // @ts-expect-error a remote placement without a host is not a placement
    const hostless: PtyPlacement = { kind: 'remote' }
    // @ts-expect-error a local placement does not hold a host connection
    const leaky: PtyPlacement = { kind: 'local', tmuxSocket: TMUX_SOCKET, host }
    // @ts-expect-error a pty is always somewhere
    const nowhere: PtyPlacement = {}

    expect([mixed, hostless, leaky, nowhere]).toHaveLength(4)
  })
})
