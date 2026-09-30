import { exec as execRemote, type ExecResult } from './host-connection'
import {
  commitRemoteCodexHooks,
  ensureCodexHooksFeatureFlag,
  ensureRemoteCodexHooksFeatureFlag,
  installCodexHooks,
  installHooks,
  installRemoteCodexHooks,
  installRemoteHooks,
  rollbackCodexHooks,
  rollbackRemoteCodexHooks,
} from './hook-installer'
import type { AgentTool, Host } from '../shared/types'

export interface AgentHookLifecycle {
  installBeforeSpawn(tool: AgentTool, worktreePath: string): Promise<void>
  installProjectHooks(tool: AgentTool, projectPath: string): Promise<void>
}

export interface RemoteHookContext {
  host: Host
  notifyScriptPath: string
}

interface CodexInstallTransaction {
  enableFeatureFlag(): Promise<void>
  rollback(): Promise<void>
  commit(): Promise<void>
}

interface HookAdapter {
  installClaude(path: string, skipGitignore: boolean): Promise<void>
  stageCodex(path: string, skipGitignore: boolean): Promise<CodexInstallTransaction>
}

function createAgentHookLifecycle(adapter: HookAdapter): AgentHookLifecycle {
  async function install(tool: AgentTool, path: string, skipGitignore: boolean): Promise<void> {
    if (tool === 'omp') return

    if (tool === 'claude') {
      await adapter.installClaude(path, skipGitignore)
      return
    }

    const transaction = await adapter.stageCodex(path, skipGitignore)
    try {
      await transaction.enableFeatureFlag()
    } catch (error) {
      await transaction.rollback().catch(() => undefined)
      throw error
    }
    await transaction.commit().catch(() => undefined)
  }

  return {
    installBeforeSpawn: (tool, worktreePath) => install(tool, worktreePath, true),
    installProjectHooks: (tool, projectPath) => install(tool, projectPath, false),
  }
}

export function createLocalAgentHookLifecycle(): AgentHookLifecycle {
  return createAgentHookLifecycle({
    installClaude: (path, skipGitignore) => installHooks(path, { skipGitignore }),
    stageCodex: async (path, skipGitignore) => {
      const snapshot = await installCodexHooks(path, { skipGitignore })
      return {
        enableFeatureFlag: async () => ensureCodexHooksFeatureFlag(),
        rollback: async () => rollbackCodexHooks(snapshot),
        commit: async () => undefined,
      }
    },
  })
}

export function createRemoteAgentHookLifecycle(context: RemoteHookContext): AgentHookLifecycle {
  const remote = (argv: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> =>
    execRemote(context.host, argv, opts)

  return createAgentHookLifecycle({
    installClaude: (path) => installRemoteHooks(remote, path, context.notifyScriptPath),
    stageCodex: async (path) => {
      const snapshot = await installRemoteCodexHooks(remote, path, context.notifyScriptPath)
      return {
        enableFeatureFlag: () => ensureRemoteCodexHooksFeatureFlag(remote),
        rollback: () => rollbackRemoteCodexHooks(remote, snapshot),
        commit: () => commitRemoteCodexHooks(remote, snapshot),
      }
    },
  })
}
