import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Host } from '../shared/types'
import type { PreparedRemoteHost } from './remote-host-runtime'
import {
  createExistingSessionTerminalStarter,
  type StartupSession,
} from './existing-session-terminal'

const host: Host = { hostId: 'h1', alias: 'devbox', label: 'Dev' }

function fixture() {
  const session: StartupSession = {
    id: 's1',
    tool: 'codex',
    worktreePath: '/project/worktree',
    projectPath: '/project',
    skipPermissions: true,
    agentSessionId: 'conversation-1',
    connectionState: 'pending',
    sandboxed: true,
  }
  const events: string[] = []
  let preparedScope = false
  const prepared: PreparedRemoteHost = {
    agentPaths: { codex: '/bin/codex' },
    notifyScriptPath: '/hooks/notify.sh',
    ompHookScriptPath: '/hooks/omp.ts',
    remoteSocketPath: '/hooks/ipc.sock',
    sandboxAvailable: true,
  }
  const local = {
    hasPty: vi.fn(() => {
      events.push('pty')
      expect(session.connectionState).toBeUndefined()
      return false
    }),
    hasTmuxSession: vi.fn(() => {
      events.push('tmux')
      return false
    }),
    reattachPty: vi.fn(() => {
      events.push('attach')
    }),
    canResume: vi.fn(() => {
      events.push('resume')
      return true
    }),
    worktreeExists: vi.fn(() => {
      events.push('exists')
      return true
    }),
    hooks: {
      installBeforeSpawn: vi.fn(async () => {
        events.push('hooks')
      }),
    },
    createPty: vi.fn(() => {
      events.push('spawn')
      return false
    }),
  }
  const remoteHooks = {
    installBeforeSpawn: vi.fn(async () => {
      events.push('hooks')
    }),
  }
  const remote = {
    runtime: {
      async withPreparedHost<T>(
        target: Host,
        run: (value: PreparedRemoteHost) => Promise<T>
      ): Promise<T> {
        expect(target).toBe(host)
        events.push('prepare')
        preparedScope = true
        try {
          return await run(prepared)
        } finally {
          preparedScope = false
          events.push('release')
        }
      },
    },
    hasTmuxSession: vi.fn(async () => {
      events.push('tmux')
      return false
    }),
    reattachPty: vi.fn(async () => {
      expect(preparedScope).toBe(true)
      events.push('attach')
    }),
    canResume: vi.fn(async () => {
      events.push('resume')
      return true
    }),
    exec: vi.fn(async () => {
      events.push('exists')
      return { code: 0, timedOut: false, stdout: '', stderr: '' }
    }),
    hooks: vi.fn(() => remoteHooks),
    createPty: vi.fn(async () => {
      expect(preparedScope).toBe(true)
      events.push('spawn')
      return false
    }),
  }
  return {
    starter: createExistingSessionTerminalStarter({ local, remote }),
    session,
    local,
    remote,
    remoteHooks,
    prepared,
    events,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('existing Session terminal startup', () => {
  it('clears pending before local revive and keeps an attached PTY without replacing sandbox state', async () => {
    const { starter, session, local, events } = fixture()
    local.hasPty.mockReturnValue(true)
    await starter.startLocal(session, 'revive')
    expect(session.connectionState).toBeUndefined()
    expect(session.sandboxed).toBe(true)
    expect(local.hasTmuxSession).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it.each(['revive', 'pending-attach'] as const)(
    'local %s reattaches tmux without history or hooks',
    async (intent) => {
      const { starter, session, local, events } = fixture()
      local.hasTmuxSession.mockImplementation(() => {
        events.push('tmux')
        return true
      })
      await starter.startLocal(session, intent)
      expect(events).toEqual(intent === 'revive' ? ['pty', 'tmux', 'attach'] : ['tmux', 'attach'])
      expect(local.reattachPty).toHaveBeenCalledWith(session.id)
      expect(session.sandboxed).toBe(true)
      expect(session.connectionState).toBe(intent === 'revive' ? undefined : 'pending')
    }
  )

  it.each(['revive', 'pending-attach'] as const)(
    'local %s owns preparation order and complete spawn inputs',
    async (intent) => {
      const { starter, session, local, events } = fixture()
      await starter.startLocal(session, intent)
      expect(events).toEqual(
        intent === 'revive'
          ? ['pty', 'tmux', 'resume', 'exists', 'hooks', 'spawn']
          : ['tmux', 'resume', 'hooks', 'spawn']
      )
      expect(local.canResume).toHaveBeenCalledWith(session)
      expect(local.hooks.installBeforeSpawn).toHaveBeenCalledWith('codex', session.worktreePath)
      expect(local.createPty).toHaveBeenCalledWith('s1', session.worktreePath, {
        continueSession: true,
        tool: 'codex',
        skipPermissions: true,
        agentSessionId: 'conversation-1',
        projectPath: '/project',
      })
      expect(session.sandboxed).toBe(false)
    }
  )

  it('warns and starts fresh locally when there is no prior conversation', async () => {
    const { starter, session, local } = fixture()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    local.canResume.mockReturnValue(false)
    await starter.startLocal(session, 'revive')
    expect(warning).toHaveBeenCalledWith(
      'Session s1 (codex) has no prior conversation; spawning fresh instead of resuming'
    )
    expect(local.createPty).toHaveBeenCalledWith(
      's1',
      session.worktreePath,
      expect.objectContaining({ continueSession: false })
    )
  })

  it('does not reinstall hooks into a missing local worktree during revive', async () => {
    const { starter, session, local } = fixture()
    local.worktreeExists.mockReturnValue(false)
    await starter.startLocal(session, 'revive')
    expect(local.hooks.installBeforeSpawn).not.toHaveBeenCalled()
    expect(local.createPty).toHaveBeenCalledOnce()
  })

  it('propagates the original local revival hook error without spawning', async () => {
    const { starter, session, local } = fixture()
    const error = new Error('hook failure')
    local.hooks.installBeforeSpawn.mockRejectedValue(error)
    await expect(starter.startLocal(session, 'revive')).rejects.toBe(error)
    expect(local.createPty).not.toHaveBeenCalled()
    expect(session.sandboxed).toBe(true)
  })

  it('logs a pending-attach hook error and still spawns', async () => {
    const { starter, session, local } = fixture()
    const error = new Error('hook failure')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    local.hooks.installBeforeSpawn.mockRejectedValue(error)
    await starter.startLocal(session, 'pending-attach')
    expect(log).toHaveBeenCalledWith('Session s1: failed to reinstall hooks before attach', error)
    expect(local.createPty).toHaveBeenCalledOnce()
  })

  it('reattaches remote tmux inside the lease even when the agent is no longer available', async () => {
    const { starter, session, remote, prepared, events } = fixture()
    prepared.agentPaths = {}
    remote.hasTmuxSession.mockImplementation(async () => {
      events.push('tmux')
      return true
    })
    await starter.startRemote(session, host)
    expect(events).toEqual(['prepare', 'tmux', 'attach', 'release'])
    expect(remote.reattachPty).toHaveBeenCalledWith('s1', host)
    expect(remote.canResume).not.toHaveBeenCalled()
    expect(remote.exec).not.toHaveBeenCalled()
    expect(remote.hooks).not.toHaveBeenCalled()
    expect(session.sandboxed).toBe(true)
  })

  it('checks remote agent availability before history and worktree probes', async () => {
    const { starter, session, prepared, events } = fixture()
    prepared.agentPaths = {}
    await expect(starter.startRemote(session, host)).rejects.toThrow(
      'codex is not installed on host Dev'
    )
    expect(events).toEqual(['prepare', 'tmux', 'release'])
  })

  it('owns remote fresh-spawn order, prepared-host inputs, and warning text', async () => {
    const { starter, session, remote, remoteHooks, prepared, events } = fixture()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    remote.canResume.mockResolvedValue(false)
    await starter.startRemote(session, host)
    expect(events).toEqual(['prepare', 'tmux', 'exists', 'hooks', 'spawn', 'release'])
    expect(warning).toHaveBeenCalledWith(
      'Session s1 (codex) has no prior conversation on host devbox; spawning fresh instead of resuming'
    )
    expect(remote.canResume).toHaveBeenCalledWith(session, host)
    expect(remote.exec).toHaveBeenCalledWith(host, ['test', '-d', session.worktreePath], {
      timeoutMs: 10000,
    })
    expect(remote.hooks).toHaveBeenCalledWith({ host, notifyScriptPath: prepared.notifyScriptPath })
    expect(remoteHooks.installBeforeSpawn).toHaveBeenCalledWith('codex', session.worktreePath)
    expect(remote.createPty).toHaveBeenCalledWith('s1', session.worktreePath, host, {
      continueSession: false,
      tool: 'codex',
      skipPermissions: true,
      agentSessionId: 'conversation-1',
      agentPath: '/bin/codex',
      projectPath: '/project',
      notifyHookPath: prepared.ompHookScriptPath,
      remoteSocketPath: prepared.remoteSocketPath,
      sandboxAvailable: prepared.sandboxAvailable,
    })
    expect(session.sandboxed).toBe(false)
  })

  it('skips hooks for an absent remote worktree and still attempts spawn', async () => {
    const { starter, session, remote, remoteHooks, events } = fixture()
    remote.exec.mockResolvedValue({ code: 1, timedOut: false, stdout: '', stderr: '' })
    await starter.startRemote(session, host)
    expect(remoteHooks.installBeforeSpawn).not.toHaveBeenCalled()
    expect(events).toEqual(['prepare', 'tmux', 'resume', 'spawn', 'release'])
  })

  it.each([
    {
      code: 1,
      timedOut: true,
      stdout: '',
      stderr: '',
      message: 'Timed out checking whether /project/worktree exists on host devbox',
    },
    {
      code: 255,
      timedOut: false,
      stdout: '',
      stderr: 'Connection refused',
      message:
        'Failed to check whether /project/worktree exists on host devbox: Connection refused',
    },
    {
      code: 127,
      timedOut: false,
      stdout: 'missing ssh',
      stderr: '',
      message: 'Failed to check whether /project/worktree exists on host devbox: missing ssh',
    },
    {
      code: 2,
      timedOut: false,
      stdout: '',
      stderr: '',
      message: 'Failed to check whether /project/worktree exists on host devbox: exit 2',
    },
  ])(
    'aborts remote startup and releases the lease on worktree probe failure $code/$timedOut',
    async ({ message, ...result }) => {
      const { starter, session, remote, remoteHooks, events } = fixture()
      remote.exec.mockResolvedValue(result)
      await expect(starter.startRemote(session, host)).rejects.toThrow(message)
      expect(remoteHooks.installBeforeSpawn).not.toHaveBeenCalled()
      expect(remote.createPty).not.toHaveBeenCalled()
      expect(events.at(-1)).toBe('release')
    }
  )

  it.each(['hooks', 'spawn'] as const)(
    'releases the lease and preserves the original remote %s failure',
    async (stage) => {
      const { starter, session, remote, remoteHooks, events } = fixture()
      const error = new Error(stage)
      if (stage === 'hooks') remoteHooks.installBeforeSpawn.mockRejectedValue(error)
      else remote.createPty.mockRejectedValue(error)
      await expect(starter.startRemote(session, host)).rejects.toBe(error)
      expect(events.at(-1)).toBe('release')
      expect(session.sandboxed).toBe(true)
      if (stage === 'hooks') expect(remote.createPty).not.toHaveBeenCalled()
    }
  )
})
