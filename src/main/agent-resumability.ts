// Deciding whether a session's agent process can be *resumed* (pick up its
// prior conversation) versus must be spawned *fresh*. This is the single home
// for that policy: previously it lived duplicated across the local and remote
// resume paths in session-manager.ts, and once drifted (the remote branch
// hardcoded `--continue`, so reviving a freshly-mirrored worktree with no
// conversation collapsed the pane on spawn). Keeping `resumeSourceForTool` as
// the one source of truth means the local and remote dispatchers can only ever
// agree on what each tool resumes off.
import { readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import {
  CLAUDE_ENCODE_SHELL_SCRIPT,
  OMP_ENCODE_SHELL_SCRIPT,
  encodeClaudeSessionDirName,
  encodeOmpSessionDirName,
} from './agent-state-paths'
import type { AgentTool, Host, Session } from '../shared/types'

// The fields a resume decision reads — a narrow slice of Session so callers and
// tests need only supply what actually matters.
type ResumeInput = Pick<Session, 'tool' | 'agentSessionId' | 'worktreePath'>

// What a given tool resumes *off of*: codex replays a captured session id;
// claude and omp each key a per-worktree conversation directory. The dispatchers
// switch on this exhaustively (no default), so adding a new source is a compile
// error until both the local and remote paths handle it.
export type ResumeSource = 'agent-session-id' | 'claude-history' | 'omp-history'

export function resumeSourceForTool(tool: AgentTool): ResumeSource {
  switch (tool) {
    case 'codex':
      return 'agent-session-id'
    case 'omp':
      return 'omp-history'
    case 'claude':
      return 'claude-history'
  }
}

// The local filesystem probes for conversation history. Injectable into
// canResumeLocal so the per-tool dispatch can be exercised without touching the
// real ~/.claude / ~/.omp directories.
export interface LocalResumeProbes {
  hasClaudeConversationHistory: (worktreePath: string) => boolean
  hasOmpConversationHistory: (worktreePath: string) => boolean
}

// Contents, not mere existence: pty-manager.ts pre-creates this exact directory
// (as a bwrap bind-source) before the agent ever runs, so a bare existence test
// would wrongly resume a worktree's very first session if the app restarted
// before the agent wrote anything.
export function hasClaudeConversationHistory(worktreePath: string): boolean {
  const dir = join(homedir(), '.claude', 'projects', encodeClaudeSessionDirName(worktreePath))
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}

// Contents, not mere existence — same reasoning as hasClaudeConversationHistory:
// createRemotePty's resolveRemoteAgentStateDir pre-creates this directory before
// omp ever runs.
export function hasOmpConversationHistory(worktreePath: string): boolean {
  const dir = join(homedir(), '.omp', 'agent', 'sessions', encodeOmpSessionDirName(worktreePath))
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}

const defaultLocalProbes: LocalResumeProbes = {
  hasClaudeConversationHistory,
  hasOmpConversationHistory,
}

export function canResumeLocal(
  session: ResumeInput,
  probes: LocalResumeProbes = defaultLocalProbes
): boolean {
  switch (resumeSourceForTool(session.tool)) {
    case 'agent-session-id':
      return !!session.agentSessionId
    case 'omp-history':
      return probes.hasOmpConversationHistory(session.worktreePath)
    case 'claude-history':
      return probes.hasClaudeConversationHistory(session.worktreePath)
  }
}

// The remote analogue of the local fs probes: an SSH exec injected by the caller
// so the dispatch is testable without a real host. Only the exit code and
// timeout flag are consulted, so the real host-connection `exec` (which returns
// a wider ExecResult) satisfies this structurally.
export type RemoteProbeExec = (
  host: Host,
  argv: string[],
  opts?: { timeoutMs?: number }
) => Promise<{ code: number; timedOut: boolean }>

// Reuses the shared CLAUDE_ENCODE_SHELL_SCRIPT (the POSIX port of
// encodeClaudeSessionDirName) to leave `$enc` set, then tests the directory's
// *contents* under the remote $HOME — same contents-not-existence reasoning as
// hasClaudeConversationHistory. Runs as a single positional-arg `sh -c` so paths
// with shell metacharacters stay inert. Any SSH/probe failure returns false, so
// revival falls back to a fresh spawn rather than risk `claude --continue`
// exiting immediately.
export async function hasRemoteClaudeConversationHistory(
  host: Host,
  worktreePath: string,
  exec: RemoteProbeExec
): Promise<boolean> {
  const script = `${CLAUDE_ENCODE_SHELL_SCRIPT}; [ -n "$(ls -A "$HOME/.claude/projects/$enc" 2>/dev/null)" ]`
  try {
    const result = await exec(host, ['sh', '-c', script, '_', worktreePath], { timeoutMs: 10000 })
    return !result.timedOut && result.code === 0
  } catch {
    return false
  }
}

// Remote analogue of hasOmpConversationHistory. Reuses OMP_ENCODE_SHELL_SCRIPT,
// which sets both `$enc` and `$h` (the canonicalized remote $HOME) — the tail
// reads `$h`, NOT `$HOME`, because the omp encoder resolves home itself; that
// asymmetry with the claude probe above is deliberate. Any SSH/probe failure
// returns false so revival falls back to a fresh spawn.
export async function hasRemoteOmpConversationHistory(
  host: Host,
  worktreePath: string,
  exec: RemoteProbeExec
): Promise<boolean> {
  const script = `${OMP_ENCODE_SHELL_SCRIPT}; [ -n "$(ls -A "$h/.omp/agent/sessions/$enc" 2>/dev/null)" ]`
  try {
    const result = await exec(host, ['sh', '-c', script, '_', worktreePath], { timeoutMs: 10000 })
    return !result.timedOut && result.code === 0
  } catch {
    return false
  }
}

export async function canResumeRemote(
  session: ResumeInput,
  host: Host,
  exec: RemoteProbeExec
): Promise<boolean> {
  switch (resumeSourceForTool(session.tool)) {
    case 'agent-session-id':
      return !!session.agentSessionId
    case 'omp-history':
      return hasRemoteOmpConversationHistory(host, session.worktreePath, exec)
    case 'claude-history':
      return hasRemoteClaudeConversationHistory(host, session.worktreePath, exec)
  }
}
