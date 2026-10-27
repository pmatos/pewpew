import type { AgentTool, CreateSessionOptions, OpenSessionsSummary, Session } from '../shared/types'
import type { ListNumberedItems } from './github-items'

export type CreateNumberedSession = (
  projectPath: string,
  number: number,
  hostId: string | null,
  options?: CreateSessionOptions
) => Promise<Session | string>

export interface NumberedSessionRequest {
  kind: 'pr' | 'issue'
  projectPath: string
  hostId: string | null
  // Omitted means all open items; an explicit empty array opens nothing.
  numbers?: readonly number[]
  options: CreateSessionOptions
}

export interface NumberedSessionAdapters {
  sessions(): readonly Session[]
  defaultTool(): AgentTool
  list: ListNumberedItems
  create: CreateNumberedSession
  describeError(error: unknown): string
}

export async function openNumberedSessions(
  request: NumberedSessionRequest,
  adapters: NumberedSessionAdapters
): Promise<OpenSessionsSummary | string> {
  const { kind, projectPath, hostId, options } = request
  let numbers =
    request.numbers === undefined ? undefined : [...new Set(request.numbers)].sort((a, b) => a - b)

  if (numbers === undefined || numbers.length > 1) {
    let open: number[]
    try {
      const items = await adapters.list(projectPath, hostId, options.repo ?? null)
      if (typeof items === 'string') return items
      open = items.map((item) => item.number)
    } catch (error) {
      return adapters.describeError(error)
    }
    if (numbers === undefined) {
      numbers = open
    } else {
      const openNumbers = new Set(open)
      numbers = numbers.filter((number) => openNumbers.has(number))
      if (numbers.length === 0) {
        return `None of the requested ${kind === 'pr' ? 'PRs' : 'issues'} are open.`
      }
    }
  }

  // Both skip and reuse decisions see the same post-listing, pre-creation state.
  const currentSessions = adapters.sessions()
  const existing = numbersInUse(
    currentSessions,
    projectPath,
    hostId,
    kind === 'pr' ? 'prNumber' : 'issueNumber'
  )
  const preexistingIds = new Set(currentSessions.map((session) => session.id))
  const { toCreate, toSkip } = selectNumbersToOpen(
    numbers.map((number) => ({ number })),
    existing
  )
  const createOne = async ({ number }: { number: number }): Promise<CreateOutcome> => {
    try {
      const result = await adapters.create(projectPath, number, hostId, options)
      return typeof result === 'string' ? { number, error: result } : { session: result }
    } catch (error) {
      return { number, error: adapters.describeError(error) }
    }
  }

  const effectiveTool = options.tool ?? adapters.defaultTool()
  let results: CreateOutcome[]
  if (shouldCreateSerially(hostId, effectiveTool)) {
    results = []
    for (const item of toCreate) results.push(await createOne(item))
  } else {
    results = await Promise.all(toCreate.map(createOne))
  }
  return summarizeCreations(results, preexistingIds, toSkip)
}

// A single create attempt's outcome: a Session (freshly created or an existing one
// the manager reused) or a per-number failure.
type CreateOutcome = { session: Session } | { number: number; error: string }

// Partition requested items into the ones to create and the numbers to skip.
// Skips both numbers already open (`existing`) and duplicates within `items`.
export function selectNumbersToOpen<T extends { number: number }>(
  items: T[],
  existing: Set<number>
): { toCreate: T[]; toSkip: number[] } {
  const toCreate: T[] = []
  const toSkip: number[] = []
  const seen = new Set(existing)
  for (const item of items) {
    if (seen.has(item.number)) {
      toSkip.push(item.number)
    } else {
      seen.add(item.number)
      toCreate.push(item)
    }
  }
  return { toCreate, toSkip }
}

// The PR/issue numbers already claimed by sessions for this exact project and host,
// so a re-open request can skip them instead of colliding on `worktree add`.
function numbersInUse(
  sessions: Iterable<Session>,
  projectPath: string,
  hostId: string | null,
  field: 'prNumber' | 'issueNumber'
): Set<number> {
  const inUse = new Set<number>()
  for (const session of sessions) {
    if (session.hostId !== hostId || session.projectPath !== projectPath) continue
    const number = session[field]
    if (number !== undefined) inUse.add(number)
  }
  return inUse
}

// Remote Codex sessions must be created one at a time on a given host; every other
// combination can be created concurrently.
function shouldCreateSerially(hostId: string | null, effectiveTool: AgentTool): boolean {
  return hostId !== null && effectiveTool === 'codex'
}

// Bucket the outcomes of a create batch. A returned session whose id was already
// present before the batch ran (`preexistingIds`) was reused rather than created —
// createSession hands back the existing session when the requested branch is
// already checked out.
function summarizeCreations(
  outcomes: CreateOutcome[],
  preexistingIds: Set<string>,
  skipped: number[]
): OpenSessionsSummary {
  const created: Session[] = []
  const reused: Session[] = []
  const failed: { number: number; error: string }[] = []
  for (const outcome of outcomes) {
    if ('session' in outcome) {
      if (preexistingIds.has(outcome.session.id)) {
        reused.push(outcome.session)
      } else {
        created.push(outcome.session)
      }
    } else {
      failed.push(outcome)
    }
  }
  return { created, reused, skipped, failed }
}
