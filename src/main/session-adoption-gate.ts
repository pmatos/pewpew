import type { AgentTool, Session } from '../shared/types'
import { assertToolCompatible, findSessionOnWorktree } from './session-queries'

export type SessionAdoptionTarget =
  | { placement: 'local'; worktreePath: string }
  | { placement: 'remote'; hostId: string; worktreePath: string }

export interface SessionAdoptionGate {
  adopt(
    target: SessionAdoptionTarget,
    tool: AgentTool,
    start: () => Promise<Session>
  ): Promise<Session>
}

export interface SessionAdoptionGateDeps {
  sessions(): Iterable<Session>
  canonicalizePath(path: string): string
}

interface InflightAdoption {
  tool: AgentTool
  promise: Promise<Session>
}

export function createSessionAdoptionGate(deps: SessionAdoptionGateDeps): SessionAdoptionGate {
  const inflight = new Map<string, InflightAdoption>()

  return {
    adopt(target, tool, start) {
      try {
        const { existing, key } = resolveTarget(deps, target)
        if (existing) {
          assertToolCompatible(existing, tool)
          return Promise.resolve(existing)
        }

        const active = inflight.get(key)
        if (active) {
          if (active.tool !== tool) {
            return Promise.reject(
              new Error(
                `Worktree already has a ${active.tool} session in-flight; mixed tools per worktree are not supported`
              )
            )
          }
          return active.promise
        }

        const promise = start()
        const entry = { tool, promise }
        inflight.set(key, entry)

        const clear = (): void => {
          if (inflight.get(key) === entry) inflight.delete(key)
        }
        void promise.then(clear, clear)

        return promise
      } catch (error) {
        return Promise.reject(error)
      }
    },
  }
}

function resolveTarget(
  deps: SessionAdoptionGateDeps,
  target: SessionAdoptionTarget
): { existing: Session | undefined; key: string } {
  if (target.placement === 'remote') {
    return {
      existing: findSessionOnWorktree(deps.sessions(), target.hostId, target.worktreePath),
      key: JSON.stringify(['remote', target.hostId, target.worktreePath]),
    }
  }

  const canonicalTarget = deps.canonicalizePath(target.worktreePath)
  let existing: Session | undefined
  for (const session of deps.sessions()) {
    if (deps.canonicalizePath(session.worktreePath) === canonicalTarget) {
      existing = session
      break
    }
  }

  return {
    existing,
    key: JSON.stringify(['local', canonicalTarget]),
  }
}
