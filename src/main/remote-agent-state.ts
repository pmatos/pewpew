import { OMP_ENCODE_SHELL_SCRIPT } from './agent-state-paths'

// The agent's writable state directory ON a remote host, computed by running
// buildRemoteAgentStateScript over SSH and passing its result to
// parseRemoteAgentState. codex and omp only — claude is never sandboxed (see
// buildAgentArgs in pty-manager.ts), so it never needs this.
export interface RemoteAgentState {
  writablePaths: string[]
}

// Builds the POSIX-shell script that resolves and mkdir's the writable state
// dir for `tool` on a remote host, then prints it for parseRemoteAgentState.
//
// codex has no per-worktree dir convention — its resume is keyed on
// agentSessionId, not a filesystem path — so the whole ~/.codex dir is the
// writable exception (matching the local agentStateDir for codex).
export function buildRemoteAgentStateScript(tool: 'codex' | 'omp'): string {
  if (tool === 'codex') {
    return 'd="$HOME/.codex"; mkdir -p "$d" && printf "%s" "$d"'
  }
  return `${OMP_ENCODE_SHELL_SCRIPT}; d="$HOME/.omp/agent/sessions/$enc"; mkdir -p "$d" && printf "%s" "$d"`
}

// Parses the script's raw exec result into the writable paths to bind, or
// undefined on failure (a timeout, a non-zero exit, or no path in stdout). A
// transient SSH error is the caller's concern — it degrades to unsandboxed
// rather than blocking session creation — so this stays a pure, total function
// over the result it is given.
export function parseRemoteAgentState(result: {
  stdout: string
  code: number
  timedOut: boolean
}): RemoteAgentState | undefined {
  if (result.timedOut || result.code !== 0) return undefined
  const dirs = result.stdout
    .trim()
    .split('\n')
    .filter((dir) => dir.startsWith('/'))
  if (dirs.length === 0) return undefined
  return { writablePaths: dirs }
}
