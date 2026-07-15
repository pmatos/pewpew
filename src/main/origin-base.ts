// Resolving origin's default base ref. A deep module: a lot of git-ref
// resolution behaviour (fetch, ls-remote symref, symbolic-ref, conventional
// fallbacks, verification) sits behind a small interface — a single injected
// GitRunner. Callers supply an adapter (local execFile, remote SSH); the
// resolution logic lives here, testable through the runner seam alone.

export type GitRunner = (argv: string[]) => Promise<{ stdout: string }>

// Parse `git ls-remote --symref origin HEAD` output into a fully-qualified
// remote-tracking ref, e.g. `ref: refs/heads/main\tHEAD` → `refs/remotes/origin/main`.
export function parseOriginHeadSymref(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const match = line.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/)
    if (match) return `refs/remotes/origin/${match[1]}`
  }
  return undefined
}

// Normalize a `symbolic-ref --short refs/remotes/origin/HEAD` result to a
// fully-qualified remote-tracking ref. A bare local branch name (no `origin/`
// prefix) is rejected so it can't be confused with a remote-tracking ref.
export function remoteTrackingRef(ref: string): string | undefined {
  const trimmed = ref.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('refs/remotes/origin/')) return trimmed
  if (trimmed.startsWith('origin/')) return `refs/remotes/${trimmed}`
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
