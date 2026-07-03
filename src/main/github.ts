// The GitHub gateway: everything pewpew knows about talking to the `gh` CLI —
// parsing its output, classifying its errors, and resolving a branch to its
// open PR number (with a TTL cache). Kept free of session state, disk I/O, and
// Electron so it can be exercised directly through injected runners.

export interface PrViewInfo {
  headRefName: string
  state: string
  title: string
  isCrossRepository?: boolean
  headRepositoryOwner?: { login?: string } | null
  headRepository?: { name?: string } | null
}

export const PR_VIEW_FIELDS =
  'headRefName,state,title,isCrossRepository,headRepositoryOwner,headRepository'

export type NumberedGhItem = { number: number }

// Extract the owner segment from a GitHub remote URL (`git@host:owner/repo.git`
// or `https://host/owner/repo`). Used to disambiguate `gh pr list --head
// <branch>` results when a fork has opened a PR whose head branch name collides
// with a local branch.
export function parseOwnerFromRemoteUrl(url: string): string | undefined {
  const m = url.match(/(?:[:/])([^/:]+)\/[^/]+?(?:\.git)?\/?$/)
  return m?.[1]
}

export function forkFieldsFromPr(prInfo: PrViewInfo): { prIsFork?: boolean; prHeadRepo?: string } {
  if (prInfo.isCrossRepository !== true) return {}
  const owner = prInfo.headRepositoryOwner?.login
  const name = prInfo.headRepository?.name
  return { prIsFork: true, prHeadRepo: owner && name ? `${owner}/${name}` : undefined }
}

// `gh pr view` fails for many reasons beyond the PR genuinely not existing —
// rate limiting, auth, network, or gh resolving the wrong default repo. Only
// report "not found" when gh actually said the PR couldn't be resolved;
// otherwise surface the real error so a rate-limit or auth failure isn't
// misreported as a missing PR (which sends the user hunting for a PR that's
// right there on GitHub).
export function describePrLookupFailure(prNumber: number, detail: string): string {
  const trimmed = detail.trim()
  const genuinelyMissing =
    /could not resolve to a (pull ?request|issue)/i.test(trimmed) ||
    /no pull requests? found/i.test(trimmed)
  if (!trimmed || genuinelyMissing) {
    return `PR #${prNumber} not found in this repository.`
  }
  return `Failed to look up PR #${prNumber}: ${trimmed}`
}

export function describeGhError(err: unknown): string {
  const detail =
    typeof err === 'object' && err !== null && 'stderr' in err
      ? String((err as { stderr?: unknown }).stderr ?? '').trim()
      : ''
  if (detail) return detail
  if (err instanceof Error) return err.message.replace(/^Error:\s*/, '')
  return String(err)
}

export function ghApiOpenItemsArgs(kind: 'pr' | 'issue', repo: string, label?: string): string[] {
  const labelQuery = kind === 'issue' && label ? `&labels=${encodeURIComponent(label)}` : ''
  const endpoint =
    kind === 'pr'
      ? `repos/${repo}/pulls?state=open&per_page=100`
      : `repos/${repo}/issues?state=open&per_page=100${labelQuery}`
  const jq = kind === 'pr' ? '.[].number' : '.[] | select(.pull_request | not) | .number'
  return ['api', '--paginate', endpoint, '--jq', jq]
}

export function parseNumberedGhLines(stdout: string, label: string): NumberedGhItem[] {
  const items: NumberedGhItem[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const number = Number(line)
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`Expected ${label} number, got ${JSON.stringify(line)}.`)
    }
    items.push({ number })
  }
  return items
}

export function parseLabelLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

// Runs `gh <args>` in the given working directory and returns stdout. Injected
// so the lookup cache can be tested without a real `gh` binary or repo.
export type GhRunner = (args: string[], cwd: string) => Promise<{ stdout: string }>

export interface PrLookupDeps {
  runGh: GhRunner
  resolveOwner: (projectPath: string) => string | undefined
  now: () => number
  negativeCacheTtlMs?: number
}

export interface PrLookup {
  lookup(projectPath: string, branch: string): Promise<number | undefined>
}

// Positive hits are cached forever; negative hits (no PR yet / gh transient
// error) are retained only for `negativeCacheTtlMs` so a PR opened after the
// session was created can be picked up without requiring an app restart.
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000

export function createPrLookup(deps: PrLookupDeps): PrLookup {
  const negativeTtl = deps.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS
  const cache = new Map<string, { value: number | null; checkedAt: number }>()

  return {
    async lookup(projectPath: string, branch: string): Promise<number | undefined> {
      const key = `${projectPath}::${branch}`
      const cached = cache.get(key)
      if (cached) {
        if (cached.value !== null) return cached.value
        if (deps.now() - cached.checkedAt < negativeTtl) return undefined
      }
      try {
        const { stdout } = await deps.runGh(
          [
            'pr',
            'list',
            '--head',
            branch,
            '--state',
            'open',
            '--json',
            'number,headRepositoryOwner',
            '--limit',
            '10',
          ],
          projectPath
        )
        const parsed = JSON.parse(stdout) as {
          number: number
          headRepositoryOwner?: { login?: string } | null
        }[]
        // `gh pr list --head <branch>` filters by branch name only (owner:branch
        // isn't supported), so in repos that accept fork PRs a common branch name
        // like `main` or `fix` can return an unrelated PR. Prefer the entry whose
        // head repo owner matches the local origin's owner; fall back to the top
        // result so upstream clones tracking a contributor's branch (where the
        // head owner differs from origin) still get a PR number.
        const owner = deps.resolveOwner(projectPath)
        const match =
          (owner && parsed.find((p) => p.headRepositoryOwner?.login === owner)) || parsed[0]
        const num = match?.number
        cache.set(key, { value: num ?? null, checkedAt: deps.now() })
        return num
      } catch {
        // Don't cache transient gh failures — next call retries immediately.
        return undefined
      }
    },
  }
}
