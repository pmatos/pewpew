import { describe, expect, it, vi } from 'vitest'
import { resolveBulkPrDialogDefaults } from './ProjectTree'

describe('bulk PR dialog defaults', () => {
  it('reads the configured tool when opening instead of using a stale render default', async () => {
    let resolveRepoChoices: ((value: { current: string; parent: null }) => void) | undefined
    const getRepoChoices = vi.fn(
      () =>
        new Promise<{ current: string; parent: null }>((resolve) => {
          resolveRepoChoices = resolve
        })
    )
    const getDefaultTool = vi.fn().mockResolvedValue('codex')

    const resolution = resolveBulkPrDialogDefaults({ getRepoChoices, getDefaultTool }, 'claude')

    expect(getDefaultTool).toHaveBeenCalledOnce()
    resolveRepoChoices?.({ current: 'owner/repo', parent: null })
    await expect(resolution).resolves.toEqual({
      repoChoices: { current: 'owner/repo', parent: null },
      tool: 'codex',
    })
  })
})
