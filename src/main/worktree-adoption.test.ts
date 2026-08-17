import { describe, expect, it, vi } from 'vitest'
import { createOrAdoptWorktree, worktreeCreationError } from './worktree-adoption'

// Seam under test: the `createOrAdoptWorktree` orchestration core extracted from
// the four create-or-adopt worktree call sites (local/remote × issue/session
// creation). It runs the two-phase fallback shared by all of them — try to add a
// worktree on a fresh branch; if that fails only because the branch already
// exists, adopt it instead — and reports the outcome as a discriminated result so
// each caller surfaces failure its own way (issue paths wrap the cause into a
// user string, session paths re-throw it). Expected values are the documented
// behaviour of the original inline branches read top-to-bottom (the spec), not a
// recomputation of the new implementation.

describe('createOrAdoptWorktree', () => {
  it('adds the fresh-branch worktree and never probes for an existing branch on success', async () => {
    const addNewBranch = vi.fn().mockResolvedValue(undefined)
    const branchExists = vi.fn().mockResolvedValue(false)
    const adoptExistingBranch = vi.fn().mockResolvedValue(undefined)

    const result = await createOrAdoptWorktree({ addNewBranch, branchExists, adoptExistingBranch })

    expect(result).toEqual({ ok: true })
    expect(addNewBranch).toHaveBeenCalledTimes(1)
    expect(branchExists).not.toHaveBeenCalled()
    expect(adoptExistingBranch).not.toHaveBeenCalled()
  })

  it('reports the creation error as the cause when the branch does not already exist', async () => {
    const creationError = new Error('fatal: invalid reference: refs/remotes/origin/main')
    const addNewBranch = vi.fn().mockRejectedValue(creationError)
    const branchExists = vi.fn().mockResolvedValue(false)
    const adoptExistingBranch = vi.fn().mockResolvedValue(undefined)

    const result = await createOrAdoptWorktree({ addNewBranch, branchExists, adoptExistingBranch })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.cause).toBe(creationError)
    expect(adoptExistingBranch).not.toHaveBeenCalled()
  })

  it('adopts the existing branch when creation fails but the branch is already present', async () => {
    const addNewBranch = vi
      .fn()
      .mockRejectedValue(new Error('fatal: a branch named already exists'))
    const branchExists = vi.fn().mockResolvedValue(true)
    const adoptExistingBranch = vi.fn().mockResolvedValue(undefined)

    const result = await createOrAdoptWorktree({ addNewBranch, branchExists, adoptExistingBranch })

    expect(result).toEqual({ ok: true })
    expect(adoptExistingBranch).toHaveBeenCalledTimes(1)
  })

  it('reports the adoption error as the cause when adopting the existing branch also fails', async () => {
    const adoptionError = new Error('fatal: worktree already checked out')
    const addNewBranch = vi
      .fn()
      .mockRejectedValue(new Error('fatal: a branch named already exists'))
    const branchExists = vi.fn().mockResolvedValue(true)
    const adoptExistingBranch = vi.fn().mockRejectedValue(adoptionError)

    const result = await createOrAdoptWorktree({ addNewBranch, branchExists, adoptExistingBranch })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.cause).toBe(adoptionError)
  })

  it('propagates a branch-existence probe failure instead of swallowing it', async () => {
    const probeError = new Error('ssh: connect to host failed')
    const addNewBranch = vi.fn().mockRejectedValue(new Error('create failed'))
    const branchExists = vi.fn().mockRejectedValue(probeError)
    const adoptExistingBranch = vi.fn().mockResolvedValue(undefined)

    await expect(
      createOrAdoptWorktree({ addNewBranch, branchExists, adoptExistingBranch })
    ).rejects.toBe(probeError)
    expect(adoptExistingBranch).not.toHaveBeenCalled()
  })
})

describe('worktreeCreationError', () => {
  it('wraps the cause message in the shared user-facing failure string', () => {
    expect(worktreeCreationError('issue-42', new Error('boom'))).toBe(
      'Failed to create worktree for branch "issue-42": boom'
    )
  })
})
