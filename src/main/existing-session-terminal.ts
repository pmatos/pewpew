import type { Host, Session } from '../shared/types'
import type { AgentHookLifecycle, RemoteHookContext } from './agent-hook-lifecycle'
import type { ExecResult } from './host-connection'
import type { createPty, createRemotePty } from './pty-manager'
import type { RemoteHostRuntime } from './remote-host-runtime'

export type StartupSession = Pick<
  Session,
  | 'id'
  | 'tool'
  | 'worktreePath'
  | 'projectPath'
  | 'skipPermissions'
  | 'agentSessionId'
  | 'connectionState'
  | 'sandboxed'
>

type SpawnHooks = Pick<AgentHookLifecycle, 'installBeforeSpawn'>
type LocalStartupIntent = 'revive' | 'pending-attach'

interface ExistingSessionTerminalDeps {
  local: {
    hasPty(id: string): boolean
    hasTmuxSession(id: string): boolean
    reattachPty(id: string): void
    canResume(session: StartupSession): boolean
    worktreeExists(path: string): boolean
    hooks: SpawnHooks
    createPty: typeof createPty
  }
  remote: {
    runtime: Pick<RemoteHostRuntime, 'withPreparedHost'>
    hasTmuxSession(id: string, host: Host): Promise<boolean>
    reattachPty(id: string, host: Host): Promise<void>
    canResume(session: StartupSession, host: Host): Promise<boolean>
    exec(host: Host, argv: string[], options: { timeoutMs: number }): Promise<ExecResult>
    hooks(context: RemoteHookContext): SpawnHooks
    createPty: typeof createRemotePty
  }
}

export interface ExistingSessionTerminalStarter {
  // Pending attach has already passed the caller's worktree-existence gate.
  // Only revival clears connectionState; both operations record fresh-spawn sandbox state.
  startLocal(session: StartupSession, intent: LocalStartupIntent): Promise<void>
  startRemote(session: StartupSession, host: Host): Promise<void>
}

export function createExistingSessionTerminalStarter(
  deps: ExistingSessionTerminalDeps
): ExistingSessionTerminalStarter {
  const { local, remote } = deps

  async function hasRemoteWorktree(host: Host, worktreePath: string): Promise<boolean> {
    const result = await remote.exec(host, ['test', '-d', worktreePath], { timeoutMs: 10000 })
    if (result.timedOut) {
      throw new Error(`Timed out checking whether ${worktreePath} exists on host ${host.alias}`)
    }
    if (result.code === 0) return true
    if (result.code === 1) return false
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    throw new Error(
      `Failed to check whether ${worktreePath} exists on host ${host.alias}: ${detail}`
    )
  }

  return {
    async startLocal(session, intent) {
      const { id } = session
      if (intent === 'revive') {
        // Clear lazy restore before touching the PTY so a renderer mount cannot reattach it.
        session.connectionState = undefined
        if (local.hasPty(id)) return
      }
      if (local.hasTmuxSession(id)) {
        local.reattachPty(id)
        return
      }

      const canResume = local.canResume(session)
      if (!canResume) {
        console.warn(
          `Session ${id} (${session.tool}) has no prior conversation; spawning fresh instead of resuming`
        )
      }
      if (intent === 'pending-attach') {
        try {
          await local.hooks.installBeforeSpawn(session.tool, session.worktreePath)
        } catch (err) {
          console.error(`Session ${id}: failed to reinstall hooks before attach`, err)
        }
      } else if (local.worktreeExists(session.worktreePath)) {
        await local.hooks.installBeforeSpawn(session.tool, session.worktreePath)
      }
      session.sandboxed = local.createPty(id, session.worktreePath, {
        continueSession: canResume,
        tool: session.tool,
        skipPermissions: session.skipPermissions,
        agentSessionId: session.agentSessionId,
        projectPath: session.projectPath,
      })
    },

    async startRemote(session, host) {
      const { id } = session
      await remote.runtime.withPreparedHost(host, async (prepared) => {
        if (await remote.hasTmuxSession(id, host)) {
          await remote.reattachPty(id, host)
          return
        }

        const agentPath = prepared.agentPaths[session.tool]
        if (!agentPath) {
          throw new Error(`${session.tool} is not installed on host ${host.label || host.alias}`)
        }
        const canResume = await remote.canResume(session, host)
        if (!canResume) {
          console.warn(
            `Session ${id} (${session.tool}) has no prior conversation on host ${host.alias}; spawning fresh instead of resuming`
          )
        }
        const hooks = remote.hooks({ host, notifyScriptPath: prepared.notifyScriptPath })
        // Installers create directories. Only a clean absence skips hooks; transport failures abort.
        if (await hasRemoteWorktree(host, session.worktreePath)) {
          await hooks.installBeforeSpawn(session.tool, session.worktreePath)
        }
        session.sandboxed = await remote.createPty(id, session.worktreePath, host, {
          continueSession: canResume,
          tool: session.tool,
          skipPermissions: session.skipPermissions,
          agentSessionId: session.agentSessionId,
          agentPath,
          projectPath: session.projectPath,
          notifyHookPath: prepared.ompHookScriptPath,
          remoteSocketPath: prepared.remoteSocketPath,
          sandboxAvailable: prepared.sandboxAvailable,
        })
      })
    },
  }
}
