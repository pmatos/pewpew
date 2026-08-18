import type { AgentTool } from '../shared/types'
import { CLAUDE_ENCODE_SHELL_SCRIPT, OMP_ENCODE_SHELL_SCRIPT } from './agent-state-paths'

// The agent's writable state directories ON a remote host, computed by running
// buildRemoteAgentStateScript over SSH and passing its result to
// parseRemoteAgentState. Builder and parser live together deliberately: the
// parser reads ~/.claude positionally off the script's SECOND printed line, so
// the print order below and the `dirs[1]` read there are a single contract that
// must stay visible in one place.
export interface RemoteAgentState {
  writablePaths: string[]
  // The remote ~/.claude dir, populated only for the claude tool (undefined
  // for codex/omp). Named explicitly rather than left implicit so callers
  // re-close CLAUDE_DIR_WRITE_DENYLIST under it without re-deriving the index.
  claudeDir?: string
}

// Builds the POSIX-shell script that resolves and mkdir's the writable state
// dir(s) for `tool` on a remote host, then prints them (one per line) for
// parseRemoteAgentState.
//
// codex has no per-worktree dir convention — its resume is keyed on
// agentSessionId, not a filesystem path — so the whole ~/.codex dir is the
// writable exception (matching the local agentStateDir for codex).
//
// claude additionally needs the whole ~/.claude dir writable — see claudeDir's
// local counterpart for why (keeps adding new global scratch state under
// unpredictable names). The second printed line is that whole directory;
// createRemotePty re-closes CLAUDE_DIR_WRITE_DENYLIST under it as
// extraReadOnlyPaths, mirroring buildLocalSandboxPrefix — including mkdir'ing
// the directory-type denylist entries (roDirNames) here so their --ro-bind-try
// can't silently skip an absent one (see CLAUDE_DIR_RO_DIRS' comment). The
// essential mkdirs ($d, $c) are `&&`-gated ahead of the denylist pre-creates
// deliberately: a failure there means sandboxing genuinely can't proceed (no
// writable exception to bind), so falling back to unsandboxed is correct. The
// denylist directory names, by contrast, are each mkdir'd individually inside
// their own loop with stderr suppressed and no `&&` between iterations — one
// name already occupied by a stray file or dangling symlink must not take the
// whole remote sandbox down (as a single `mkdir -p a b c && ...` chain would:
// GNU mkdir -p keeps going past a failing operand but still exits non-zero
// overall, which used to make the trailing `&& printf` never run, returning
// undefined and disabling bwrap entirely for the session). Mirrors the local
// path's per-entry try/catch in buildLocalSandboxPrefix.
export function buildRemoteAgentStateScript(
  tool: AgentTool | undefined,
  roDirNames: readonly string[]
): string {
  if (tool === 'codex') {
    return 'd="$HOME/.codex"; mkdir -p "$d" && printf "%s" "$d"'
  }
  if (tool === 'omp') {
    return `${OMP_ENCODE_SHELL_SCRIPT}; d="$HOME/.omp/agent/sessions/$enc"; mkdir -p "$d" && printf "%s" "$d"`
  }
  const claudeRoDirsNames = roDirNames.join(' ')
  return (
    `${CLAUDE_ENCODE_SHELL_SCRIPT}; ` +
    'd="$HOME/.claude/projects/$enc"; c="$HOME/.claude"; ' +
    'mkdir -p "$d" "$c" && { ' +
    `for x in ${claudeRoDirsNames}; do mkdir -p "$c/$x" 2>/dev/null; done; ` +
    'printf "%s\\n%s" "$d" "$c"; }'
  )
}

// Parses the script's raw exec result into the writable paths to bind, or
// undefined on failure (a timeout, a non-zero exit, or no path in stdout). A
// transient SSH error is the caller's concern — it degrades to unsandboxed
// rather than blocking session creation — so this stays a pure, total function
// over the result it is given.
export function parseRemoteAgentState(
  tool: AgentTool | undefined,
  result: { stdout: string; code: number; timedOut: boolean }
): RemoteAgentState | undefined {
  if (result.timedOut || result.code !== 0) return undefined
  const dirs = result.stdout
    .trim()
    .split('\n')
    .filter((dir) => dir.startsWith('/'))
  if (dirs.length === 0) return undefined
  const isClaudeTool = tool !== 'codex' && tool !== 'omp'
  return { writablePaths: dirs, claudeDir: isClaudeTool ? dirs[1] : undefined }
}
