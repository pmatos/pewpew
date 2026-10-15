import { describe, expect, it, vi } from 'vitest'
import {
  checkoutNamedWorktree,
  tryCheckoutNamedWorktree,
  worktreeCreationError,
} from './worktree-adoption'

const request = { worktreePath: '/repo with spaces/.claude/worktrees/task', branch: 'proj/task' }
const freshArgs = [
  'worktree',
  'add',
  request.worktreePath,
  '--no-track',
  '-b',
  request.branch,
  'refs/remotes/origin/main',
]
const adoptionArgs = ['worktree', 'add', request.worktreePath, request.branch]

function gitAdapter() {
  return {
    runGit: vi.fn(async (argv: string[]) => ({
      stdout: argv[0] === 'symbolic-ref' ? 'origin/main\n' : '',
    })),
    branchExists: vi.fn<(branch: string) => Promise<boolean>>().mockResolvedValue(false),
  }
}

describe.each(['throw', 'message'] as const)('named worktree checkout (%s)', (mode) => {
  const checkout = mode === 'throw' ? checkoutNamedWorktree : tryCheckoutNamedWorktree

  async function expectFailure(attempt: Promise<unknown>, cause: Error, message: string) {
    if (mode === 'throw') await expect(attempt).rejects.toBe(cause)
    else await expect(attempt).resolves.toEqual({ ok: false, message })
  }

  it('fetches origin before creating a branch without upstream tracking and never probes on success', async () => {
    const git = gitAdapter()
    const result = await checkout(request, git)

    expect(result).toEqual(mode === 'throw' ? undefined : { ok: true })
    expect(git.runGit).toHaveBeenCalledWith(['fetch', 'origin', '--quiet'])
    expect(git.runGit).toHaveBeenLastCalledWith(freshArgs)
    expect(git.branchExists).not.toHaveBeenCalled()
  })

  it('preserves the creation error when the exact local branch does not exist', async () => {
    const git = gitAdapter()
    const cause = new Error('disk full')
    const runWorktreeGit = vi.fn().mockRejectedValue(cause)

    await expectFailure(
      checkout(request, { ...git, runWorktreeGit }),
      cause,
      'Failed to create worktree for branch "proj/task": disk full'
    )

    expect(git.branchExists).toHaveBeenCalledExactlyOnceWith('proj/task')
    expect(runWorktreeGit).toHaveBeenCalledExactlyOnceWith(freshArgs)
  })

  it('adopts the exact existing branch after fresh creation fails', async () => {
    const git = gitAdapter()
    git.branchExists.mockResolvedValue(true)
    const runWorktreeGit = vi
      .fn()
      .mockRejectedValueOnce(new Error('branch exists'))
      .mockResolvedValueOnce({ stdout: '' })

    await checkout(request, { ...git, runWorktreeGit })

    expect(runWorktreeGit.mock.calls).toEqual([[freshArgs], [adoptionArgs]])
    expect(git.runGit.mock.calls.some(([argv]) => argv[0] === 'worktree')).toBe(false)
  })

  it('preserves the adoption error if the existing branch cannot be checked out', async () => {
    const git = gitAdapter()
    git.branchExists.mockResolvedValue(true)
    const cause = new Error('already checked out elsewhere')
    const runWorktreeGit = vi
      .fn()
      .mockRejectedValueOnce(new Error('branch exists'))
      .mockRejectedValueOnce(cause)

    await expectFailure(
      checkout(request, { ...git, runWorktreeGit }),
      cause,
      'Failed to create worktree for branch "proj/task": already checked out elsewhere'
    )
    expect(runWorktreeGit).toHaveBeenLastCalledWith(adoptionArgs)
  })

  it('propagates an injected probe rejection without attempting adoption', async () => {
    const git = gitAdapter()
    const cause = new Error('probe unavailable')
    git.branchExists.mockRejectedValue(cause)
    const runWorktreeGit = vi.fn().mockRejectedValue(new Error('create failed'))

    await expect(checkout(request, { ...git, runWorktreeGit })).rejects.toBe(cause)
    expect(runWorktreeGit).toHaveBeenCalledTimes(1)
  })

  it('stops before worktree mutation when origin resolution fails', async () => {
    const git = gitAdapter()
    git.runGit.mockRejectedValue(new Error('no remote'))
    const runWorktreeGit = vi.fn()

    if (mode === 'throw') {
      await expect(checkout(request, { ...git, runWorktreeGit })).rejects.toThrow(
        'no-origin-remote'
      )
    } else {
      await expect(checkout(request, { ...git, runWorktreeGit })).resolves.toEqual({
        ok: false,
        message: 'This project has no origin remote.',
      })
    }
    expect(runWorktreeGit).not.toHaveBeenCalled()
    expect(git.branchExists).not.toHaveBeenCalled()
  })
})

describe('named worktree default Git probe', () => {
  it('probes the fully qualified local branch through the same runner and adopts it', async () => {
    const { runGit } = gitAdapter()
    runGit.mockImplementation(async (argv) => {
      if (argv.includes('--no-track')) throw new Error('branch exists')
      return { stdout: argv[0] === 'symbolic-ref' ? 'origin/main\n' : '' }
    })

    await checkoutNamedWorktree(request, { runGit })

    expect(runGit).toHaveBeenCalledWith(['rev-parse', '--verify', 'refs/heads/proj/task'])
    expect(runGit).toHaveBeenLastCalledWith(adoptionArgs)
  })

  it('treats a rejected default Git probe as absent and keeps the creation error', async () => {
    const { runGit } = gitAdapter()
    const cause = new Error('cannot create branch')
    runGit.mockImplementation(async (argv) => {
      if (argv.includes('--no-track')) throw cause
      if (argv.includes('refs/heads/proj/task')) throw new Error('no such branch')
      return { stdout: argv[0] === 'symbolic-ref' ? 'origin/main\n' : '' }
    })

    await expect(checkoutNamedWorktree(request, { runGit })).rejects.toBe(cause)
    expect(runGit).not.toHaveBeenCalledWith(adoptionArgs)
  })
})

describe('issue checkout diagnostics', () => {
  it('reports a missing origin default without attempting checkout', async () => {
    const git = gitAdapter()
    git.runGit.mockImplementation(async (argv) => {
      if (['ls-remote', 'symbolic-ref', 'rev-parse'].includes(argv[0])) throw new Error('missing')
      return { stdout: '' }
    })

    await expect(tryCheckoutNamedWorktree(request, git)).resolves.toEqual({
      ok: false,
      message: "Could not determine origin's default branch.",
    })
    expect(git.runGit.mock.calls.some(([argv]) => argv[0] === 'worktree')).toBe(false)
  })

  it('retains fetch failure details', async () => {
    const git = gitAdapter()
    git.runGit.mockImplementation(async (argv) => {
      if (argv[0] === 'fetch') throw new Error('network down')
      return { stdout: '' }
    })

    await expect(tryCheckoutNamedWorktree(request, git)).resolves.toEqual({
      ok: false,
      message: 'Failed to resolve origin default: Failed to fetch origin: network down',
    })
  })
})

describe('worktreeCreationError', () => {
  it('wraps the cause message in the shared user-facing failure string', () => {
    expect(worktreeCreationError('issue-42', new Error('boom'))).toBe(
      'Failed to create worktree for branch "issue-42": boom'
    )
  })
})
