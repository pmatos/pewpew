import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Host } from '../shared/types'

// Shared, ordered log so "hooks before pty" is a single assertion across the
// two mocked modules.
const calls: string[] = []
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

vi.mock('./hook-installer', () => ({
  installRemoteHooks: vi.fn(async () => {
    calls.push('installRemoteHooks')
  }),
  installRemoteCodexHooks: vi.fn(async () => {
    calls.push('installRemoteCodexHooks')
    return {}
  }),
  ensureRemoteCodexHooksFeatureFlag: vi.fn(async () => {
    calls.push('ensureRemoteCodexHooksFeatureFlag')
  }),
  rollbackRemoteCodexHooks: vi.fn(async () => {
    calls.push('rollbackRemoteCodexHooks')
  }),
  commitRemoteCodexHooks: vi.fn(async () => {
    calls.push('commitRemoteCodexHooks')
  }),
}))

vi.mock('./host-connection', () => ({
  exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, timedOut: false })),
}))

import { spawnRemoteAgent, installRemoteAgentHooks } from './remote-agent-spawn'

const host = { hostId: 'h1', alias: 'dev', label: 'Dev' } as unknown as Host

const prepared = {
  notifyScriptPath: '/remote/notify.sh',
  guardScriptPath: '/remote/guard.sh',
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
})

describe('spawnRemoteAgent', () => {
  it('installs the agent hooks strictly before spawning the pty', async () => {
    await spawnRemoteAgent(baseArgs())
    expect(calls.indexOf('installRemoteHooks')).toBeLessThan(calls.indexOf('createRemotePty'))
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
    const { installRemoteHooks } = await import('./hook-installer')
    vi.mocked(installRemoteHooks).mockRejectedValueOnce(new Error('hook install failed'))
    await expect(spawnRemoteAgent(baseArgs())).rejects.toThrow('hook install failed')
    expect(calls).not.toContain('createRemotePty')
  })
})

describe('installRemoteAgentHooks', () => {
  it('installs claude/default hooks via installRemoteHooks', async () => {
    await installRemoteAgentHooks('claude', host, '/remote/wt', '/n.sh', '/g.sh')
    expect(calls).toContain('installRemoteHooks')
  })

  it('is a no-op for omp (hook bridge is a plain file installed elsewhere)', async () => {
    await installRemoteAgentHooks('omp', host, '/remote/wt', '/n.sh', '/g.sh')
    expect(calls).not.toContain('installRemoteHooks')
    expect(calls).not.toContain('installRemoteCodexHooks')
  })

  it('rolls back codex hooks when the feature-flag step fails', async () => {
    const { ensureRemoteCodexHooksFeatureFlag } = await import('./hook-installer')
    vi.mocked(ensureRemoteCodexHooksFeatureFlag).mockRejectedValueOnce(new Error('flag failed'))
    await expect(
      installRemoteAgentHooks('codex', host, '/remote/wt', '/n.sh', '/g.sh')
    ).rejects.toThrow('flag failed')
    expect(calls).toContain('rollbackRemoteCodexHooks')
    expect(calls).not.toContain('commitRemoteCodexHooks')
  })
})
