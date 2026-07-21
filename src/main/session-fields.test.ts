import { describe, expect, it } from 'vitest'
import { deriveSessionFields, type PersistedSessionFields } from './session-fields'

// Seam under test: the pure `deriveSessionFields` decision core extracted from
// `session-manager`'s private `backfillDerivedFields`. Expected values are the
// documented behaviour of the original inline reconciliation (the spec), not a
// recomputation of the new implementation:
//   - branch: a local worktree's live git branch (passed in as
//     `env.resolvedLocalBranch`) self-heals a wrong persisted value; remote /
//     missing-worktree sessions keep their persisted branch, or fall back to the
//     conventional `<project>/<worktree>` name when it's empty.
//   - issueNumber / prNumber: parsed from the worktree name (and branch, for
//     issues) only when not already persisted.
//   - tool: defaults to 'claude' for legacy sessions that predate the field.

function base(overrides: Partial<PersistedSessionFields> = {}): PersistedSessionFields {
  return {
    branch: 'main',
    worktreeName: 'wt',
    projectName: 'proj',
    tool: 'claude',
    ...overrides,
  }
}

describe('deriveSessionFields — branch', () => {
  it('self-heals a local session to its live git branch, overriding the persisted value', () => {
    const derived = deriveSessionFields(base({ branch: 'stale-persisted' }), {
      resolvedLocalBranch: 'feature/live',
    })
    expect(derived.branch).toBe('feature/live')
  })

  it('keeps the persisted branch when there is no live local branch (remote session)', () => {
    const derived = deriveSessionFields(base({ branch: 'feature/persisted' }), {
      resolvedLocalBranch: undefined,
    })
    expect(derived.branch).toBe('feature/persisted')
  })

  it('falls back to the conventional name when no live branch and no persisted branch', () => {
    const derived = deriveSessionFields(
      base({ branch: '', projectName: 'my proj', worktreeName: 'feat' }),
      { resolvedLocalBranch: undefined }
    )
    // sanitizeBranchPrefix('my proj') === 'my-proj'
    expect(derived.branch).toBe('my-proj/feat')
  })
})

describe('deriveSessionFields — issueNumber', () => {
  it('parses the issue number from the worktree name when unset', () => {
    const derived = deriveSessionFields(
      base({ worktreeName: 'issue-37', issueNumber: undefined }),
      { resolvedLocalBranch: undefined }
    )
    expect(derived.issueNumber).toBe(37)
  })

  it('parses the issue number from the derived branch when the worktree name has none', () => {
    // Ordering guarantee: branch is computed first, then issue parsing consults it.
    const derived = deriveSessionFields(base({ worktreeName: 'wt', issueNumber: undefined }), {
      resolvedLocalBranch: 'issue-9',
    })
    expect(derived.issueNumber).toBe(9)
  })

  it('keeps an already-persisted issue number instead of re-parsing', () => {
    const derived = deriveSessionFields(base({ worktreeName: 'issue-37', issueNumber: 5 }), {
      resolvedLocalBranch: undefined,
    })
    expect(derived.issueNumber).toBe(5)
  })

  it('leaves issueNumber undefined when nothing encodes one', () => {
    const derived = deriveSessionFields(
      base({ worktreeName: 'wt', branch: 'main', issueNumber: undefined }),
      { resolvedLocalBranch: undefined }
    )
    expect(derived.issueNumber).toBeUndefined()
  })
})

describe('deriveSessionFields — prNumber', () => {
  it('recovers the PR number from a pr-<n> worktree name when unset', () => {
    const derived = deriveSessionFields(base({ worktreeName: 'pr-808', prNumber: undefined }), {
      resolvedLocalBranch: undefined,
    })
    expect(derived.prNumber).toBe(808)
  })

  it('keeps an already-persisted PR number instead of re-parsing', () => {
    const derived = deriveSessionFields(base({ worktreeName: 'pr-808', prNumber: 42 }), {
      resolvedLocalBranch: undefined,
    })
    expect(derived.prNumber).toBe(42)
  })

  it('leaves prNumber undefined for a non-pr worktree name', () => {
    const derived = deriveSessionFields(base({ worktreeName: 'feature-x', prNumber: undefined }), {
      resolvedLocalBranch: undefined,
    })
    expect(derived.prNumber).toBeUndefined()
  })
})

describe('deriveSessionFields — tool', () => {
  it("defaults a legacy session with no tool to 'claude'", () => {
    const derived = deriveSessionFields(base({ tool: undefined }), {
      resolvedLocalBranch: undefined,
    })
    expect(derived.tool).toBe('claude')
  })

  it('preserves a persisted codex tool', () => {
    const derived = deriveSessionFields(base({ tool: 'codex' }), {
      resolvedLocalBranch: undefined,
    })
    expect(derived.tool).toBe('codex')
  })
})
