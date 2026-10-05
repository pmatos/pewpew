import { describe, expect, it, vi } from 'vitest'
import { resolveSessionDialogDefaults } from './SessionDialogs'

describe('session dialog defaults', () => {
  it('reads the configured defaults when opening instead of using stale render defaults', async () => {
    const api = {
      getDefaultTool: vi.fn().mockResolvedValue('codex'),
      getDefaultSkipPermissions: vi.fn().mockResolvedValue(true),
      getWorktreeBase: vi.fn().mockResolvedValue('origin-default'),
    }

    await expect(resolveSessionDialogDefaults(api, 'session')).resolves.toEqual({
      tool: 'codex',
      skipPermissions: true,
      baseFromOrigin: true,
    })
  })

  it('only looks up the worktree base for the new-session dialog', async () => {
    const api = {
      getDefaultTool: vi.fn().mockResolvedValue('claude'),
      getDefaultSkipPermissions: vi.fn().mockResolvedValue(false),
      getWorktreeBase: vi.fn().mockResolvedValue('origin-default'),
    }

    await expect(resolveSessionDialogDefaults(api, 'pr')).resolves.toMatchObject({
      baseFromOrigin: false,
    })
    expect(api.getWorktreeBase).not.toHaveBeenCalled()
  })

  it('falls back per-field when a lookup fails', async () => {
    const api = {
      getDefaultTool: vi.fn().mockRejectedValue(new Error('nope')),
      getDefaultSkipPermissions: vi.fn().mockResolvedValue(true),
      getWorktreeBase: vi.fn().mockRejectedValue(new Error('nope')),
    }

    await expect(resolveSessionDialogDefaults(api, 'session')).resolves.toEqual({
      tool: 'claude',
      skipPermissions: true,
      baseFromOrigin: false,
    })
  })
})
