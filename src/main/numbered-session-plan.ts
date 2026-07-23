import type { AgentTool, OpenSessionsSummary, Session } from '../shared/types'

// Pure decisions behind "open a batch of sessions for a list of PR/issue numbers".
// The session manager owns the mutable session registry and the side effects
// (git, gh, pty, persistence); this module owns only the reasoning it feeds them:
// which numbers are already taken, whether creation must be serialized, and how to
// bucket the outcomes. Keeping these decisions here gives the batch-open logic a
// test surface that does not require the whole session manager.

// A single create attempt's outcome: a Session (freshly created or an existing one
// the manager reused) or a per-number failure.
export type CreateOutcome = { session: Session } | { number: number; error: string }

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
export function numbersInUse(
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
export function shouldCreateSerially(hostId: string | null, effectiveTool: AgentTool): boolean {
  return hostId !== null && effectiveTool === 'codex'
}

// Bucket the outcomes of a create batch. A returned session whose id was already
// present before the batch ran (`preexistingIds`) was reused rather than created —
// createSession hands back the existing session when the requested branch is
// already checked out.
export function summarizeCreations(
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
