import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host } from '../shared/types'

const state = vi.hoisted(() => ({
  calls: [] as string[],
}))

vi.mock('./hook-installer', () => ({
  installHooks: vi.fn(async () => {
    state.calls.push('install-claude-local')
  }),
  installRemoteHooks: vi.fn(async (execRemote: (argv: string[]) => Promise<unknown>) => {
    state.calls.push('install-claude-remote')
    await execRemote(['probe'])
  }),
  installCodexHooks: vi.fn(async () => {
    state.calls.push('stage-codex-local')
    return { hooksPath: '/wt/.codex/hooks.json', priorContent: '{"before":true}' }
  }),
  installRemoteCodexHooks: vi.fn(async () => {
    state.calls.push('stage-codex-remote')
    return { worktreePath: '/wt', hadPrior: true }
  }),
  ensureCodexHooksFeatureFlag: vi.fn(() => {
    state.calls.push('enable-codex-local')
  }),
  ensureRemoteCodexHooksFeatureFlag: vi.fn(async () => {
    state.calls.push('enable-codex-remote')
  }),
  rollbackCodexHooks: vi.fn(() => {
    state.calls.push('rollback-codex-local')
  }),
  rollbackRemoteCodexHooks: vi.fn(async () => {
    state.calls.push('rollback-codex-remote')
  }),
  commitRemoteCodexHooks: vi.fn(async () => {
    state.calls.push('commit-codex-remote')
  }),
}))

vi.mock('./host-connection', () => ({
  exec: vi.fn(async (host: Host) => {
    state.calls.push(`exec:${host.hostId}`)
    return { stdout: '', stderr: '', code: 0, timedOut: false }
  }),
}))

import {
  createLocalAgentHookLifecycle,
  createRemoteAgentHookLifecycle,
} from './agent-hook-lifecycle'
import {
  commitRemoteCodexHooks,
  ensureCodexHooksFeatureFlag,
  ensureRemoteCodexHooksFeatureFlag,
  installCodexHooks,
  installHooks,
  installRemoteHooks,
  rollbackCodexHooks,
} from './hook-installer'

const host = { hostId: 'h1', alias: 'dev', label: 'Dev' } as unknown as Host

beforeEach(() => {
  state.calls.length = 0
  vi.clearAllMocks()
})

describe('local agent hook lifecycle', () => {
  it('maps lifecycle intent to worktree and project hook policy', async () => {
    const hooks = createLocalAgentHookLifecycle()

    await hooks.installBeforeSpawn('claude', '/worktree')
    await hooks.installProjectHooks('claude', '/project')

    expect(vi.mocked(installHooks).mock.calls).toEqual([
      ['/worktree', { skipGitignore: true }],
      ['/project', { skipGitignore: false }],
    ])
  })

  it('installs project-scoped Codex hooks before enabling the feature', async () => {
    const hooks = createLocalAgentHookLifecycle()

    await hooks.installProjectHooks('codex', '/project')

    expect(installCodexHooks).toHaveBeenCalledWith('/project', { skipGitignore: false })
    expect(state.calls).toEqual(['stage-codex-local', 'enable-codex-local'])
  })

  it('keeps omp installation host-scoped instead of writing project hooks', async () => {
    const hooks = createLocalAgentHookLifecycle()

    await hooks.installBeforeSpawn('omp', '/worktree')
    await hooks.installProjectHooks('omp', '/project')

    expect(state.calls).toEqual([])
  })

  it('restores staged Codex hooks when feature enablement fails without replacing the error', async () => {
    const hooks = createLocalAgentHookLifecycle()
    const flagError = new Error('flag failed')
    vi.mocked(ensureCodexHooksFeatureFlag).mockImplementationOnce(() => {
      state.calls.push('enable-codex-local')
      throw flagError
    })
    vi.mocked(rollbackCodexHooks).mockImplementationOnce(() => {
      state.calls.push('rollback-codex-local')
      throw new Error('rollback failed')
    })

    await expect(hooks.installBeforeSpawn('codex', '/worktree')).rejects.toBe(flagError)
    expect(state.calls).toEqual(['stage-codex-local', 'enable-codex-local', 'rollback-codex-local'])
  })
})

describe('remote agent hook lifecycle', () => {
  function createHooks() {
    return createRemoteAgentHookLifecycle({
      host,
      notifyScriptPath: '/remote/notify.sh',
    })
  }

  it('binds the prepared host to Claude installation', async () => {
    await createHooks().installBeforeSpawn('claude', '/remote/worktree')

    expect(state.calls).toEqual(['install-claude-remote', 'exec:h1'])
    expect(installRemoteHooks).toHaveBeenCalledWith(
      expect.any(Function),
      '/remote/worktree',
      '/remote/notify.sh'
    )
  })

  it('commits the remote Codex snapshot only after enabling the feature', async () => {
    await createHooks().installBeforeSpawn('codex', '/remote/worktree')

    expect(state.calls).toEqual([
      'stage-codex-remote',
      'enable-codex-remote',
      'commit-codex-remote',
    ])
  })

  it('rolls back remote Codex hooks and skips commit when feature enablement fails', async () => {
    const flagError = new Error('remote flag failed')
    vi.mocked(ensureRemoteCodexHooksFeatureFlag).mockImplementationOnce(async () => {
      state.calls.push('enable-codex-remote')
      throw flagError
    })

    await expect(createHooks().installBeforeSpawn('codex', '/remote/worktree')).rejects.toBe(
      flagError
    )
    expect(state.calls).toEqual([
      'stage-codex-remote',
      'enable-codex-remote',
      'rollback-codex-remote',
    ])
  })

  it('does not fail a successful install when remote backup cleanup fails', async () => {
    vi.mocked(commitRemoteCodexHooks).mockImplementationOnce(async () => {
      state.calls.push('commit-codex-remote')
      throw new Error('cleanup failed')
    })

    await expect(
      createHooks().installBeforeSpawn('codex', '/remote/worktree')
    ).resolves.toBeUndefined()
    expect(state.calls).toEqual([
      'stage-codex-remote',
      'enable-codex-remote',
      'commit-codex-remote',
    ])
  })
})
