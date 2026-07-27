import { describe, expect, it, vi } from 'vitest'
import type { Host } from '../shared/types'
import { createRemoteHostRuntime, type RemoteHostRuntimeDeps } from './remote-host-runtime'

function host(overrides: Partial<Host> = {}): Host {
  return {
    hostId: 'h1',
    alias: 'devbox',
    label: 'Dev',
    ...overrides,
  }
}

function deps(): RemoteHostRuntimeDeps {
  return {
    listenHookServerForHost: vi.fn(() => '/tmp/local.sock'),
    ensureHostConnection: vi.fn(async () => ({
      remoteSocketPath: '/tmp/remote.sock',
      controlPath: '/tmp/control.sock',
    })),
    retainHostConnection: vi.fn(),
    releaseHostConnection: vi.fn(async () => undefined),
    stopHostConnection: vi.fn(async () => undefined),
    runtimeStateFor: vi.fn(() => undefined),
    startBootstrapWindow: vi.fn(() => vi.fn()),
    bootstrapHost: vi.fn(async () => ({
      notifyScriptPath: '/tmp/notify.sh',
      guardScriptPath: '/tmp/worktree-guard.sh',
      ompHookScriptPath: '/tmp/omp-notify.ts',
      remoteSocketPath: '/tmp/remote.sock',
      sandboxAvailable: true,
      agentPaths: { claude: '/bin/claude' },
    })),
    execRemote: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, timedOut: false })),
    setHostAgentPaths: vi.fn(),
    emitToast: vi.fn(),
  }
}

describe('remote host runtime ownership', () => {
  it('releases the prepared host retain after an operation returns', async () => {
    const fakes = deps()
    const runtime = createRemoteHostRuntime(fakes)

    const result = await runtime.withPreparedHost(host(), async (prepared) => {
      expect(prepared.notifyScriptPath).toBe('/tmp/notify.sh')
      expect(prepared.guardScriptPath).toBe('/tmp/worktree-guard.sh')
      expect(prepared.ompHookScriptPath).toBe('/tmp/omp-notify.ts')
      expect(prepared.sandboxAvailable).toBe(true)
      expect(prepared.agentPaths.claude).toBe('/bin/claude')
      return 'created'
    })

    expect(result).toBe('created')
    expect(fakes.retainHostConnection).toHaveBeenCalledWith('h1')
    expect(fakes.releaseHostConnection).toHaveBeenCalledWith('h1')
    expect(fakes.releaseHostConnection).toHaveBeenCalledTimes(1)
    expect(fakes.emitToast).not.toHaveBeenCalled()
  })

  it('represents prepared host ownership as an idempotent lease', async () => {
    const fakes = deps()
    const runtime = createRemoteHostRuntime(fakes)

    const lease = await runtime.acquirePreparedHost(host())
    expect(lease.notifyScriptPath).toBe('/tmp/notify.sh')

    await lease.release()
    await lease.release()

    expect(fakes.retainHostConnection).toHaveBeenCalledWith('h1')
    expect(fakes.releaseHostConnection).toHaveBeenCalledWith('h1')
    expect(fakes.releaseHostConnection).toHaveBeenCalledTimes(1)
  })
})

describe('sandbox availability', () => {
  it('threads sandboxAvailable=false through and warns once per host', async () => {
    const fakes = deps()
    fakes.bootstrapHost = vi.fn(async () => ({
      notifyScriptPath: '/tmp/notify.sh',
      guardScriptPath: '/tmp/worktree-guard.sh',
      ompHookScriptPath: '/tmp/omp-notify.ts',
      remoteSocketPath: '/tmp/remote.sock',
      sandboxAvailable: false,
      agentPaths: { claude: '/bin/claude' },
    }))
    const runtime = createRemoteHostRuntime(fakes)
    const noBwrapHost = host({ hostId: 'no-bwrap-host', label: 'No Bwrap Box' })

    await runtime.withPreparedHost(noBwrapHost, async (prepared) => {
      expect(prepared.sandboxAvailable).toBe(false)
      return null
    })
    await runtime.withPreparedHost(noBwrapHost, async () => null)

    expect(fakes.emitToast).toHaveBeenCalledTimes(1)
    expect(fakes.emitToast).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'info',
        hostLabel: 'No Bwrap Box',
        detail: expect.stringContaining('Claude sessions still block'),
      })
    )
  })
})
