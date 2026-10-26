// Resolving the "origin-default" worktree base: figure out which ref the
// `origin` remote treats as its default branch. The logic is pure with respect
// to an injected GitRunner so it can be exercised without spawning git — the
// caller wires it to the real `git` binary.

export type GitRunner = (argv: string[]) => Promise<{ stdout: string }>

// Normalize a symbolic-ref result into a fully-qualified remote-tracking ref.
// Rejects anything that isn't already remote-tracking or a short `origin/<x>`
// name so a stale local branch can never masquerade as the origin default.
export function remoteTrackingRef(ref: string): string | undefined {
  const trimmed = ref.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('refs/remotes/origin/')) return trimmed
  if (trimmed.startsWith('origin/')) return `refs/remotes/${trimmed}`
  return undefined
}

// Pull the default branch out of `git ls-remote --symref origin HEAD` output,
// e.g. `ref: refs/heads/main\tHEAD` → `refs/remotes/origin/main`.
export function parseOriginHeadSymref(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const match = line.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/)
    if (match) return `refs/remotes/origin/${match[1]}`
  }
  return undefined
}

const fetchQueues = new Map<string, Promise<void>>()
const inFlightFetches = new Map<string, Promise<void>>()

// Concurrent fetches in one repo (opening many issue or PR sessions at once)
// race on the same refs and git fails with "cannot lock ref". Fetches that
// share a key run one at a time; an unkeyed fetch runs immediately.
export function serializeFetch<T>(
  fetchKey: string | undefined,
  task: () => Promise<T>
): Promise<T> {
  if (fetchKey === undefined) return task()
  const result = (fetchQueues.get(fetchKey) ?? Promise.resolve()).then(task)
  const tail = result.then(
    () => undefined,
    () => undefined
  )
  fetchQueues.set(fetchKey, tail)
  void tail.then(() => {
    if (fetchQueues.get(fetchKey) === tail) fetchQueues.delete(fetchKey)
  })
  return result
}

async function fetchOnce(run: GitRunner, fetchKey: string | undefined): Promise<void> {
  try {
    await serializeFetch(fetchKey, () => run(['fetch', 'origin', '--quiet']))
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to fetch origin: ${detail}`, { cause: err })
  }
}

// Concurrent origin-default resolutions for one repo want the same refs, so
// they share a single in-flight fetch rather than queueing identical ones.
function fetchOrigin(run: GitRunner, fetchKey: string | undefined): Promise<void> {
  if (fetchKey === undefined) return fetchOnce(run, fetchKey)
  const pending = inFlightFetches.get(fetchKey)
  if (pending) return pending
  const shared = fetchOnce(run, fetchKey).finally(() => inFlightFetches.delete(fetchKey))
  inFlightFetches.set(fetchKey, shared)
  return shared
}

// Resolve the ref to branch new "origin-default" worktrees from. Fetches origin,
// then tries, in order: the remote's advertised HEAD (ls-remote --symref), the
// locally-recorded origin/HEAD, and the conventional main/master names —
// returning the first candidate that `rev-parse --verify` confirms exists.
export async function resolveOriginDefaultBase(run: GitRunner, fetchKey?: string): Promise<string> {
  try {
    await run(['remote', 'get-url', 'origin'])
  } catch {
    throw new Error('no-origin-remote')
  }

  await fetchOrigin(run, fetchKey)

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
