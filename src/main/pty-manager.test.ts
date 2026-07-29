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
  // Controls what resolveRemoteGitDir returns (empty → fallback to
  // `<project>/.git`).
  remoteGitDir: '' as string,
  // Controls what resolveRemoteAgentStateDir returns (undefined → sandbox
  // disabled, since a missing state bind would make the agent's first write
  // hit EROFS under --ro-bind / /).
  remoteStateDir: '/home/dev/.claude/projects/encoded-wt1' as string | undefined,
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
      return ''
    }
    // isSandboxAvailable() no longer checks `which bwrap` — it runs a real
    // (minimal) bwrap invocation, so the fake has to answer to `bwrap` itself.
    if (file === 'bwrap') {
      if (!state.bwrapAvailable) throw new Error('not found')
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
    // resolveRemoteAgentStateDir: `sh -c <script> _ <worktreePath>` — the
    // script prints the state dir path after mkdir'ing it. Return a fixed
    // path so sandboxing can be enabled; tests that need it disabled set
    // state.remoteStateDir to undefined.
    if (argv[0] === 'sh' && typeof argv[2] === 'string') {
      const script = argv[2]
      if (
        script.includes('.claude/projects') ||
        script.includes('.codex') ||
        script.includes('.omp/agent/sessions')
      ) {
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
  retainHostConnection: () => undefined,
  releaseHostConnection: () => undefined,
  spawnAttach: () => fakePty(),
}))

import { homedir } from 'os'
import { join } from 'path'
import {
  buildAgentArgs,
  createPty,
  createRemotePty,
  __resetSandboxProbeCacheForTesting,
} from './pty-manager'
import { buildSandboxArgs } from './agent-sandbox'
import { OMP_HOOK_SCRIPT } from './hook-installer'
import { canonicalPath, encodeOmpSessionDirName } from './agent-state-paths'
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
    // isSandboxAvailable() memoizes a successful real-bwrap probe; without
    // resetting it here, the first test to see bwrapAvailable=true would
    // permanently mask every later test simulating bwrap being unusable.
    __resetSandboxProbeCacheForTesting()
    warnSpy.mockClear()
  })

  it('prepends the bwrap sandbox prefix to the composed tmux argv when available', () => {
    createPty('s1', WORKTREE, { tool: 'claude', projectPath: PROJECT })
    const argv = agentArgsFromCall(state.tmuxArgvCalls[0])
    const claudeStateDir = join(
      homedir(),
      '.claude',
      'projects',
      canonicalPath(WORKTREE).replace(/[^a-zA-Z0-9-]/g, '-')
    )
    const expectedPrefix = buildSandboxArgs(PROJECT, WORKTREE, {
      enabled: true,
      extraWritablePaths: [claudeStateDir],
    })
    expect(argv).toEqual([...expectedPrefix, ...buildAgentArgs({ tool: 'claude' })])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('creates the tool-specific per-worktree state dir and opens only that as an extra writable path', () => {
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
    const argv = agentArgsFromCall(state.tmuxArgvCalls[0])
    // The extra writable path is bound after the project's own `.git`/`.git/hooks`
    // binds, so search for '--bind-try' starting past the last fixed occurrence.
    // Extra paths use --bind-try so a missing source can't crash bwrap's spawn.
    const bindIdx = argv.indexOf('--bind-try', argv.indexOf(`${PROJECT}/.git/hooks`))
    expect(argv.slice(bindIdx, bindIdx + 3)).toEqual(['--bind-try', ompStateDir, ompStateDir])
  })

  it('omits the sandbox prefix and warns when bwrap is unavailable', () => {
    state.bwrapAvailable = false
    createPty('s1', WORKTREE, { tool: 'claude', projectPath: PROJECT })
    const argv = agentArgsFromCall(state.tmuxArgvCalls[0])
    expect(argv).toEqual(buildAgentArgs({ tool: 'claude' }))
    expect(argv).not.toContain('bwrap')
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('bwrap missing or unable to sandbox')
    )
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
  const STATE_DIR = '/home/dev/.claude/projects/encoded-wt1'
  const REMOTE_SOCKET_DIR = '/tmp/pewpew-remote'
  const REMOTE_SOCKET = `${REMOTE_SOCKET_DIR}/hook.sock`

  beforeEach(() => {
    state.remoteArgvCalls = []
    state.remoteGitDir = ''
    state.remoteStateDir = STATE_DIR
  })

  // The tmux new-session call is the one whose argv starts with 'tmux' — the
  // git/state-dir resolution calls precede it and pollute remoteArgvCalls.
  function tmuxCall(): string[] {
    return state.remoteArgvCalls.find((argv) => argv[0] === 'tmux') ?? []
  }

  it('includes the sandbox prefix with state and stable hook socket directory when sandboxAvailable is true', async () => {
    await createRemotePty('s1', WORKTREE, host, {
      tool: 'claude',
      projectPath: PROJECT,
      sandboxAvailable: true,
      remoteSocketPath: REMOTE_SOCKET,
    })
    const argv = remoteAgentArgsFromCall(tmuxCall())
    const expectedPrefix = buildSandboxArgs(PROJECT, WORKTREE, {
      enabled: true,
      extraWritablePaths: [STATE_DIR, REMOTE_SOCKET_DIR],
      gitDir: `${PROJECT}/.git`,
    })
    expect(argv).toEqual([...expectedPrefix, ...buildAgentArgs({ tool: 'claude' })])
  })

  it('uses the resolved gitDir when the remote reports a gitfile root', async () => {
    state.remoteGitDir = '/home/dev/real-repo/.git'
    await createRemotePty('s1', WORKTREE, host, {
      tool: 'claude',
      projectPath: PROJECT,
      sandboxAvailable: true,
    })
    const argv = remoteAgentArgsFromCall(tmuxCall())
    expect(argv).toContain('--bind')
    expect(argv).toContain('/home/dev/real-repo/.git')
    expect(argv).not.toContain(`${PROJECT}/.git`)
  })

  it('disables sandboxing when the remote state dir cannot be resolved', async () => {
    state.remoteStateDir = undefined
    await createRemotePty('s1', WORKTREE, host, {
      tool: 'claude',
      projectPath: PROJECT,
      sandboxAvailable: true,
    })
    const argv = remoteAgentArgsFromCall(tmuxCall())
    expect(argv).toEqual(buildAgentArgs({ tool: 'claude' }))
    expect(argv).not.toContain('bwrap')
  })

  it('omits the sandbox prefix when sandboxAvailable is not set', async () => {
    await createRemotePty('s1', WORKTREE, host, { tool: 'claude', projectPath: PROJECT })
    const argv = remoteAgentArgsFromCall(tmuxCall())
    expect(argv).toEqual(buildAgentArgs({ tool: 'claude' }))
    expect(argv).not.toContain('bwrap')
  })

  it('omits the sandbox prefix when no projectPath is given, regardless of sandboxAvailable', async () => {
    await createRemotePty('s1', WORKTREE, host, {
      tool: 'claude',
      sandboxAvailable: true,
    })
    const argv = remoteAgentArgsFromCall(tmuxCall())
    expect(argv).toEqual(buildAgentArgs({ tool: 'claude' }))
  })
})
