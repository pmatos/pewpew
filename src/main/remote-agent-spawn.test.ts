import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Host } from '../shared/types'

// Shared, ordered log so "hooks before pty" is a single assertion across the
// two mocked modules.
const calls: string[] = []
const hookInstallMock = vi.hoisted(() => vi.fn())
let revParseStdout = 'feature/x\n'
let ptyOptions: Record<string, unknown> | undefined

vi.mock('./remote-command', () => ({
  expectRemoteOk: vi.fn(async (_host: Host, _argv: string[]) => {
    calls.push('rev-parse')
    return revParseStdout
  }),
}))

vi.mock('./pty-manager', () => ({
  createRemotePty: vi.fn(
    async (_id: string, _cwd: string, _host: Host, options?: Record<string, unknown>) => {
      calls.push('createRemotePty')
      ptyOptions = options
      return true
    }
  ),
}))

vi.mock('./agent-hook-lifecycle', () => ({
  createRemoteAgentHookLifecycle: () => ({
    installBeforeSpawn: hookInstallMock,
    installProjectHooks: vi.fn(),
  }),
}))

import { spawnRemoteAgent } from './remote-agent-spawn'

const host = { hostId: 'h1', alias: 'dev', label: 'Dev' } as unknown as Host

const prepared = {
  notifyScriptPath: '/remote/notify.sh',
  ompHookScriptPath: '/remote/omp-notify-v1.ts',
  remoteSocketPath: '/tmp/remote.sock',
  sandboxAvailable: true,
}

function baseArgs() {
  return {
    id: 'sess1234',
    host,
    tool: 'claude' as const,
    worktreePath: '/remote/wt',
    projectPath: '/remote/proj',
    agentPath: '/usr/bin/claude',
    branchFallback: 'HEAD',
    prepared,
  }
}

beforeEach(() => {
  calls.length = 0
  revParseStdout = 'feature/x\n'
  ptyOptions = undefined
  hookInstallMock.mockReset()
  hookInstallMock.mockImplementation(async () => {
    calls.push('installAgentHooks')
  })
})

describe('spawnRemoteAgent', () => {
  it('installs the agent hooks strictly before spawning the pty', async () => {
    await spawnRemoteAgent(baseArgs())
    expect(calls.indexOf('installAgentHooks')).toBeLessThan(calls.indexOf('createRemotePty'))
  })

  it('passes createRemotePty exactly the mapped options (ompHookScriptPath → notifyHookPath)', async () => {
    await spawnRemoteAgent(baseArgs())
    expect(ptyOptions).toEqual({
      tool: 'claude',
      agentPath: '/usr/bin/claude',
      projectPath: '/remote/proj',
      notifyHookPath: prepared.ompHookScriptPath,
      remoteSocketPath: prepared.remoteSocketPath,
      sandboxAvailable: prepared.sandboxAvailable,
    })
    // Fresh spawns must never carry resume fields.
    expect(ptyOptions).not.toHaveProperty('continueSession')
    expect(ptyOptions).not.toHaveProperty('agentSessionId')
  })

  it('trims the resolved branch when rev-parse returns one', async () => {
    revParseStdout = '  feature/x  \n'
    const { branch } = await spawnRemoteAgent(baseArgs())
    expect(branch).toBe('feature/x')
  })

  it('falls back to branchFallback when rev-parse is empty', async () => {
    revParseStdout = '\n'
    const { branch } = await spawnRemoteAgent({ ...baseArgs(), branchFallback: 'my-branch' })
    expect(branch).toBe('my-branch')
  })

  it('returns whether the pty was sandboxed', async () => {
    const { sandboxed } = await spawnRemoteAgent(baseArgs())
    expect(sandboxed).toBe(true)
  })

  it('does not spawn the pty if hook installation fails', async () => {
    hookInstallMock.mockRejectedValueOnce(new Error('hook install failed'))
    await expect(spawnRemoteAgent(baseArgs())).rejects.toThrow('hook install failed')
    expect(calls).not.toContain('createRemotePty')
  })
})
