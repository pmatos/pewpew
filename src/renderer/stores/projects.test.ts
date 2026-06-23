import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useProjectsStore, remoteWorktreeKey } from './projects'
import type { Worktree } from '../../shared/types'

const store = useProjectsStore
const listRemoteWorktrees = vi.fn()

beforeEach(() => {
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { listRemoteWorktrees },
  }
  listRemoteWorktrees.mockReset()
  store.setState({ remoteWorktrees: {}, remoteWorktreesStatus: {} })
})

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('fetchRemoteWorktrees', () => {
  it('stores worktrees under the host+path key and marks the entry loaded', async () => {
    const worktrees: Worktree[] = [
      { name: 'feat', path: '/srv/proj/.claude/worktrees/feat', branch: 'b', isMain: false },
    ]
    listRemoteWorktrees.mockResolvedValue(worktrees)

    await store.getState().fetchRemoteWorktrees('h1', '/srv/proj')

    const key = remoteWorktreeKey('h1', '/srv/proj')
    expect(store.getState().remoteWorktrees[key]).toEqual(worktrees)
    expect(store.getState().remoteWorktreesStatus[key]).toBe('loaded')
    expect(listRemoteWorktrees).toHaveBeenCalledWith('h1', '/srv/proj')
  })

  it('marks the entry as error when the fetch fails', async () => {
    listRemoteWorktrees.mockRejectedValue(new Error('ssh down'))

    await store.getState().fetchRemoteWorktrees('h1', '/srv/proj')

    const key = remoteWorktreeKey('h1', '/srv/proj')
    expect(store.getState().remoteWorktreesStatus[key]).toBe('error')
    expect(store.getState().remoteWorktrees[key]).toBeUndefined()
  })
})
