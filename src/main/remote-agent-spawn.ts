import { createRemotePty } from './pty-manager'
import { expectRemoteOk } from './remote-command'
import { exec as execRemote } from './host-connection'
import {
  installRemoteHooks,
  installRemoteCodexHooks,
  ensureRemoteCodexHooksFeatureFlag,
  rollbackRemoteCodexHooks,
  commitRemoteCodexHooks,
} from './hook-installer'
import type { AgentTool, Host } from '../shared/types'
import type { PreparedRemoteHost } from './remote-host-runtime'

// Installs the agent's lifecycle hooks into a remote worktree. Dispatches on the
// tool: codex snapshots + feature-flags + commits (rolling back on failure), omp
// is a no-op (its hook bridge is a plain file installed by bootstrapHost), and
// claude/default merge hooks into the worktree. Kept exported because
// reviveSession spawns fresh without going through spawnRemoteAgent.
export async function installRemoteAgentHooks(
  tool: AgentTool,
  host: Host,
  worktreePath: string,
  notifyScriptPath: string,
  guardScriptPath: string
): Promise<void> {
  const remote = (argv: string[], opts?: { timeoutMs?: number }) => execRemote(host, argv, opts)
  if (tool === 'codex') {
    const snapshot = await installRemoteCodexHooks(remote, worktreePath, notifyScriptPath)
    try {
      await ensureRemoteCodexHooksFeatureFlag(remote)
    } catch (err) {
      await rollbackRemoteCodexHooks(remote, snapshot)
      throw err
    }
    await commitRemoteCodexHooks(remote, snapshot)
    return
  }
  if (tool === 'omp') {
    // omp's hook bridge is installed as a plain file by bootstrapHost (see
    // ompHookScriptPath) and passed via `--hook <path>` in buildAgentArgs —
    // no settings/hooks JSON to merge into the remote worktree here.
    return
  }
  await installRemoteHooks(remote, worktreePath, notifyScriptPath, guardScriptPath)
}

export interface SpawnRemoteAgentArgs {
  id: string
  host: Host
  tool: AgentTool
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
  const { id, host, tool, worktreePath, projectPath, agentPath, branchFallback, prepared } = args

  const branch =
    (
      await expectRemoteOk(
        host,
        ['git', '-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
        'Failed to resolve remote branch'
      )
    ).trim() || branchFallback

  await installRemoteAgentHooks(
    tool,
    host,
    worktreePath,
    prepared.notifyScriptPath,
    prepared.guardScriptPath
  )

  const sandboxed = await createRemotePty(id, worktreePath, host, {
    tool,
    agentPath,
    projectPath,
    notifyHookPath: prepared.ompHookScriptPath,
    remoteSocketPath: prepared.remoteSocketPath,
    sandboxAvailable: prepared.sandboxAvailable,
  })

  return { branch, sandboxed }
}
