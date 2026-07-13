// Git branch/ref resolution behind a single `GitRunner` seam.
//
// Every function here is either pure or drives git through the injected
// `GitRunner`, so the whole module is exercised at its interface with a fake
// runner — no process spawning, no repository, no wider app wiring. Callers
// supply a runner bound to whichever repository (local `git -C <path>` or a
// remote SSH invocation) the ref work targets.

// Runs a git subcommand (argv without the leading `git`) and yields its stdout.
export type GitRunner = (argv: string[]) => Promise<{ stdout: string }>

// Matches "issue37", "issue-37", "issue_37", "issue/37", "issue#37", "issue 37"
// anywhere in a string. Case-insensitive. Captures the number.
const ISSUE_REGEX = /issue[-_/#\s]?(\d+)/i

// Scan sources in order and return the first issue number found, or undefined.
export function parseIssueNumber(...sources: (string | undefined)[]): number | undefined {
  for (const src of sources) {
    if (!src) continue
    const m = src.match(ISSUE_REGEX)
    if (m) return parseInt(m[1], 10)
  }
  return undefined
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

function remoteTrackingRef(ref: string): string | undefined {
  const trimmed = ref.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('refs/remotes/origin/')) return trimmed
  if (trimmed.startsWith('origin/')) return `refs/remotes/${trimmed}`
  return undefined
}

function parseOriginHeadSymref(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const match = line.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/)
    if (match) return `refs/remotes/origin/${match[1]}`
  }
  return undefined
}

export async function resolveOriginDefaultBase(run: GitRunner): Promise<string> {
  try {
    await run(['remote', 'get-url', 'origin'])
  } catch {
    throw new Error('no-origin-remote')
  }

  try {
    await run(['fetch', 'origin', '--quiet'])
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to fetch origin: ${detail}`, { cause: err })
  }

  const candidates: string[] = []
  const seen = new Set<string>()
  const addCandidate = (ref: string | undefined): void => {
    if (!ref || seen.has(ref)) return
    seen.add(ref)
    candidates.push(ref)
  }

  try {
    const { stdout } = await run(['ls-remote', '--symref', 'origin', 'HEAD'])
    addCandidate(parseOriginHeadSymref(stdout))
  } catch {
    // fall through to local origin/HEAD
  }

  try {
    const { stdout } = await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    addCandidate(remoteTrackingRef(stdout))
  } catch {
    // fall through to conventional branch names
  }

  for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/master']) {
    addCandidate(ref)
  }

  async function firstExistingCandidate(index: number): Promise<string> {
    const ref = candidates[index]
    if (!ref) throw new Error('no-origin-default-branch')
    try {
      await run(['rev-parse', '--verify', ref])
      return ref
    } catch {
      return firstExistingCandidate(index + 1)
    }
  }

  return firstExistingCandidate(0)
}

// Whether a local branch exists, verified through the fully qualified
// `refs/heads/<branch>` ref so a same-named remote-tracking ref can't be
// mistaken for it.
export async function localBranchExists(run: GitRunner, branch: string): Promise<boolean> {
  try {
    await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}
