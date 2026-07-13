// Pure derivation of a session's git identity — branch names and the issue/PR
// numbers implied by a worktree name. Kept free of fs/git/electron so it can be
// unit-tested directly and reused across the local and remote session paths.

// Matches "issue37", "issue-37", "issue_37", "issue/37", "issue#37", "issue 37"
// anywhere in a string. Case-insensitive. Captures the number.
const ISSUE_REGEX = /issue[-_/#\s]?(\d+)/i

// Canonical `pr-<number>` worktree name produced when opening a PR session.
const PR_WORKTREE_REGEX = /^pr-(\d+)$/

export function parseIssueNumber(...sources: (string | undefined)[]): number | undefined {
  for (const src of sources) {
    if (!src) continue
    const m = src.match(ISSUE_REGEX)
    if (m) return parseInt(m[1], 10)
  }
  return undefined
}

// Recover the PR number from a worktree named by the PR session path (`pr-808`).
// Returns undefined for any other shape.
export function parsePrNumber(worktreeName: string): number | undefined {
  const m = worktreeName.match(PR_WORKTREE_REGEX)
  return m ? parseInt(m[1], 10) : undefined
}

// Project names come from arbitrary directory basenames (or a user-supplied
// remote-project label), so they can contain characters that are illegal in a
// git ref component (space, `:`, `~`, `^`, `?`, `*`, `[`, `\`, control chars,
// `..`, leading `-`/`.`, etc.). Coerce to a safe slug; fall back to
// `pewpew` when nothing valid remains.
export function sanitizeBranchPrefix(name: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .replace(/(?:\.lock)+$/i, '')
    .replace(/^[-._]+|[-._]+$/g, '')
  return slug || 'pewpew'
}

// The conventional branch name for a worktree: a sanitized project prefix and
// the worktree name joined by a slash. The worktree name is used verbatim — it
// is already a caller-controlled label, not an arbitrary directory basename.
export function worktreeBranchName(projectName: string, worktreeName: string): string {
  return `${sanitizeBranchPrefix(projectName)}/${worktreeName}`
}
