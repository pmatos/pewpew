import { createRemotePty } from './pty-manager'
import { expectRemoteOk } from './remote-command'
import { createRemoteAgentHookLifecycle } from './agent-hook-lifecycle'
import type { AgentTool, Host } from '../shared/types'
import type { PreparedRemoteHost } from './remote-host-runtime'

export interface SpawnRemoteAgentArgs {
  id: string
  host: Host
  tool: AgentTool
  skipPermissions?: boolean
  worktreePath: string
  projectPath: string
  // Resolved (and error-checked) by the caller: the missing-agent error mode is
  // per-caller and published (some callers throw, some return a string to the
  // renderer), so this module never performs the agentPaths lookup itself.
  agentPath: string
  // Branch name to use when `git rev-parse --abbrev-ref HEAD` yields nothing.
  branchFallback: string
  // The prepared-host lease minus `agentPaths` — see agentPath above.
  prepared: Omit<PreparedRemoteHost, 'agentPaths'>
}

// The post-worktree remote spawn tail shared by every remote create/adopt path:
// resolve the checked-out branch, install the agent's hooks, then attach the
// remote pty. Owns the hooks-before-pty ordering and the createRemotePty option
// mapping (notably ompHookScriptPath → notifyHookPath), so callers cannot get
// either wrong. reviveSession is deliberately not a caller: it reattaches or
// resumes and passes resume fields the fresh-spawn paths never set.
export async function spawnRemoteAgent(
  args: SpawnRemoteAgentArgs
): Promise<{ branch: string; sandboxed: boolean }> {
  const {
    id,
    host,
    tool,
    skipPermissions,
    worktreePath,
    projectPath,
    agentPath,
    branchFallback,
    prepared,
  } = args

  const branch =
    (
      await expectRemoteOk(
        host,
        ['git', '-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
        'Failed to resolve remote branch'
      )
    ).trim() || branchFallback

  const hooks = createRemoteAgentHookLifecycle({
    host,
    notifyScriptPath: prepared.notifyScriptPath,
  })
  await hooks.installBeforeSpawn(tool, worktreePath)

  const sandboxed = await createRemotePty(id, worktreePath, host, {
    tool,
    skipPermissions,
    agentPath,
    projectPath,
    notifyHookPath: prepared.ompHookScriptPath,
    remoteSocketPath: prepared.remoteSocketPath,
    sandboxAvailable: prepared.sandboxAvailable,
  })

  return { branch, sandboxed }
}
