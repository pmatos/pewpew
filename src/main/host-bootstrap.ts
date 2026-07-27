import { posix } from 'path'
import type { ExecResult } from './host-connection'
import type { AgentTool } from '../shared/types'

export const NOTIFY_SCRIPT_VERSION = 1
export const WORKTREE_GUARD_SCRIPT_VERSION = 1

// Tools pewpew strictly requires on a remote host for sessions and the notify
// hook to work. Exported so the connection-test flow can surface missing ones
// up front instead of letting a session/mirror fail deep in bootstrap.
export const STRICT_DEPS = ['tmux', 'git', 'jq', 'socat'] as const
export const AGENT_TOOLS: readonly AgentTool[] = ['claude', 'codex'] as const

const notifyScript = `#!/usr/bin/env bash
# pewpew notify script v${NOTIFY_SCRIPT_VERSION}
PEWPEW_NOTIFY_VERSION=${NOTIFY_SCRIPT_VERSION}
set -euo pipefail

INPUT=$(cat)
PEWPEW_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/pewpew"
SOCKET=$(cat "$PEWPEW_DIR/hooks/socket-path" 2>/dev/null || echo "")
if [ -z "$SOCKET" ] || [ ! -S "$SOCKET" ]; then
  exit 0
fi

EVENT_NAME=$(echo "$INPUT" | jq -r '.hook_event_name // empty')

case "$EVENT_NAME" in
  SessionStart)   METHOD="session.start" ;;
  Stop)           METHOD="session.stop" ;;
  PostToolUse)    METHOD="session.activity" ;;
  SessionEnd)     METHOD="session.end" ;;
  Notification)   METHOD="session.notification" ;;
  *)              exit 0 ;;
esac

PAYLOAD=$(printf '%s' "$INPUT" | jq -c \\
  --arg method "$METHOD" \\
  '{jsonrpc:"2.0",method:$method,params:.,id:null}')

echo "$PAYLOAD" | socat - UNIX-CONNECT:"$SOCKET" >/dev/null 2>/dev/null || true
`

// Logic body must stay byte-identical to hooks/worktree-guard.sh from its
// root="$1" line onward — enforced by a round-trip test in
// host-bootstrap.test.ts so the local and remote guards can't silently drift.
export const worktreeGuardScript = `#!/usr/bin/env bash
# pewpew worktree guard script v${WORKTREE_GUARD_SCRIPT_VERSION}
PEWPEW_WORKTREE_GUARD_VERSION=${WORKTREE_GUARD_SCRIPT_VERSION}
root="$1"
[ -z "$root" ] && exit 0

# Canonicalize the root itself (resolves any symlinks in the worktree path).
root_real=$(cd "$root" 2>/dev/null && pwd -P) || exit 0

payload=$(cat)
target=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)
[ -z "$target" ] && exit 0

# Resolve an absolute, symlink-free path even when the target doesn't exist
# yet (a new file's parent directory may not have been created). Walk up from
# the target until an existing *directory* ancestor is found (an existing
# regular file can't be cd'd into, so -d rather than -e), canonicalize that,
# then re-append the unresolved remainder.
resolve_path() {
  p="$1"
  case "$p" in
    /*) ;;
    *) p="$root_real/$p" ;;
  esac
  suffix=""
  while [ ! -d "$p" ]; do
    suffix="/\${p##*/}$suffix"
    parent="\${p%/*}"
    if [ "$parent" = "$p" ] || [ -z "$parent" ]; then
      p="/"
      break
    fi
    p="$parent"
  done
  base=$(cd "$p" 2>/dev/null && pwd -P) || { printf ''; return; }
  printf '%s%s\\n' "$base" "$suffix"
}

target_real=$(resolve_path "$target")
[ -z "$target_real" ] && exit 0

# Path-boundary check: target must be the root itself, or start with "root/".
# A plain string-prefix check would let a sibling like "<root>-evil" through.
case "$target_real" in
  "$root_real") allowed=1 ;;
  "$root_real"/*) allowed=1 ;;
  *) allowed=0 ;;
esac

reason=""
guard_settings="$root_real/.claude/settings.local.json"
if [ "$target_real" = "$guard_settings" ]; then
  allowed=0
  reason="pewpew: this hook's own settings file ($guard_settings) may not be edited"
fi

[ "\${allowed:-0}" = "1" ] && exit 0

if [ -z "$reason" ]; then
  reason="pewpew: blocked write outside the session worktree ($root_real) — target resolved to $target_real"
fi

jq -nc --arg reason "$reason" \\
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
exit 0
`

export type HostBootstrapErrorKind = 'missing-deps' | 'stream-local-bind' | 'install-failed'

export class HostBootstrapError extends Error {
  kind: HostBootstrapErrorKind
  missingDeps: string[]

  constructor(kind: HostBootstrapErrorKind, message: string, missingDeps: string[] = []) {
    super(message)
    this.name = 'HostBootstrapError'
    this.kind = kind
    this.missingDeps = missingDeps
  }
}

export interface HostBootstrapConnection {
  exec(argv: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>
}

export type AgentResolution = Partial<Record<AgentTool, string>>

// The cached portion of bootstrap — the parts that genuinely don't change
// between calls (notify script install, socket path). Agent paths are persisted
// per-host on disk (Host.agentPaths) and threaded in via cachedAgentPaths so
// resolveRemoteAgents can verify them cheaply with `[ -x ]` instead of a full
// search.
interface CachedBootstrap {
  notifyScriptPath: string
  guardScriptPath: string
  remoteSocketPath: string
}

export interface HostBootstrapResult {
  notifyScriptPath: string
  guardScriptPath: string
  remoteSocketPath: string
  agentPaths: AgentResolution
}

const bootstrapped = new Map<string, CachedBootstrap>()

// Resolve absolute paths to agent CLIs on the remote, in a single ssh round
// trip. Per agent: trust the cached path if it's still executable, else search
// with PATH augmented with common user-bin locations, else fall back to the
// user's interactive login shell ($SHELL -ilc) to honour PATH set in their
// shell rc (e.g. ~/.zshrc). The shell fallback is what makes us robust to
// users who only export PATH in their interactive rc — sshd's non-interactive
// command exec doesn't source those.
//
// Output is two lines (claude, then codex), each containing the absolute path
// or empty.
const RESOLVE_SCRIPT = `set +e
augment_path() {
  for d in "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/bin" "$HOME/.cargo/bin" "$HOME/.deno/bin" "$HOME/go/bin"; do
    [ -d "$d" ] && PATH="$d:$PATH"
  done
  for d in "$HOME"/.nvm/versions/node/*/bin; do
    [ -d "$d" ] || continue
    PATH="$d:$PATH"
  done
}
resolve_one() {
  agent=$1
  cached=$2
  if [ -n "$cached" ] && [ -x "$cached" ]; then
    printf '%s\\n' "$cached"
    return
  fi
  augment_path
  found=$(command -v "$agent" 2>/dev/null)
  if [ -z "$found" ] && [ -n "$SHELL" ] && [ -x "$SHELL" ]; then
    found=$("$SHELL" -ilc "command -v $agent" 2>/dev/null | grep '^/' | tail -n 1)
  fi
  printf '%s\\n' "$found"
}
resolve_one claude "$1"
resolve_one codex "$2"
`

export async function resolveRemoteAgents(
  connection: HostBootstrapConnection,
  cachedAgentPaths: AgentResolution = {}
): Promise<AgentResolution> {
  const result = await connection.exec(
    ['sh', '-c', RESOLVE_SCRIPT, '_', cachedAgentPaths.claude ?? '', cachedAgentPaths.codex ?? ''],
    { timeoutMs: 15000 }
  )
  // Surface probe failures as a typed bootstrap error rather than masquerading
  // as "agent not installed". A transient SSH timeout otherwise shows up as a
  // misleading "<tool> is not installed on host X" message that leads users to
  // reinstall a binary that's actually present.
  if (result.timedOut) {
    throw new HostBootstrapError('install-failed', 'Agent path resolution timed out')
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    throw new HostBootstrapError('install-failed', `Agent path resolution failed: ${detail}`)
  }
  const lines = result.stdout.split('\n')
  const resolved: AgentResolution = {}
  AGENT_TOOLS.forEach((tool, i) => {
    const path = (lines[i] ?? '').trim()
    if (path) resolved[tool] = path
  })
  return resolved
}

// Called when the SSH target for a host changes (alias edit). Drops the cached
// bootstrap result so the next session re-probes dependencies and reinstalls
// notify hooks on the new endpoint.
export function invalidateBootstrap(hostId: string): void {
  bootstrapped.delete(hostId)
}

// Probe the remote for which of `deps` are missing, in a single ssh round
// trip. Returns the subset of `deps` not found on PATH (empty = all present).
// Throws HostBootstrapError('missing-deps') only when the probe itself fails to
// run (timeout / non-zero), never for a tool simply being absent.
export async function probeMissingDeps(
  connection: HostBootstrapConnection,
  deps: readonly string[] = STRICT_DEPS
): Promise<string[]> {
  const depProbe =
    'missing=""; for dep in "$@"; do command -v "$dep" >/dev/null 2>&1 || missing="$missing $dep"; done; printf "%s\\n" "$missing"'
  const result = await connection.exec(['sh', '-c', depProbe, '_', ...deps], { timeoutMs: 15000 })
  await expectOk(result, 'missing-deps', 'Dependency probe failed')
  const missing = new Set(result.stdout.trim().split(/\s+/).filter(Boolean))
  return deps.filter((d) => missing.has(d))
}

async function expectOk(
  result: ExecResult,
  kind: HostBootstrapErrorKind,
  message: string
): Promise<void> {
  if (result.timedOut) throw new HostBootstrapError(kind, `${message}: timed out`)
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    throw new HostBootstrapError(kind, `${message}: ${detail}`)
  }
}

export async function bootstrapHost(
  hostId: string,
  connection: HostBootstrapConnection,
  remoteSocketPath: string,
  cachedAgentPaths: AgentResolution = {}
): Promise<HostBootstrapResult> {
  const cached = bootstrapped.get(hostId)
  if (cached && cached.remoteSocketPath === remoteSocketPath) {
    // Cache hit on the heavy work — still resolve agent paths so a freshly
    // installed claude/codex (or one moved out from under the cached path) is
    // picked up. The resolve script verifies the cached path with `[ -x ]`
    // before falling back to a search, so the common case stays a single ssh.
    const agentPaths = await resolveRemoteAgents(connection, cachedAgentPaths)
    return { ...cached, agentPaths }
  }

  const missingStrict = await probeMissingDeps(connection)
  if (missingStrict.length > 0) {
    throw new HostBootstrapError(
      'missing-deps',
      `Remote host is missing required tools: ${missingStrict.join(', ')}`,
      missingStrict
    )
  }

  const [agentPaths, socketProbe] = await Promise.all([
    resolveRemoteAgents(connection, cachedAgentPaths),
    connection.exec(['sh', '-c', 'test -S "$1"', '_', remoteSocketPath], {
      timeoutMs: 5000,
    }),
  ])
  if (socketProbe.code !== 0 || socketProbe.timedOut) {
    throw new HostBootstrapError(
      'stream-local-bind',
      `Remote hook socket ${remoteSocketPath} is not available; check StreamLocalBindUnlink and reverse Unix-socket forwarding`
    )
  }

  // Resolve the remote config root the same way notifyScript does
  // (`${XDG_CONFIG_HOME:-$HOME/.config}`), so the breadcrumb we write here is
  // the one the script reads at hook time. Hardcoding $HOME/.config would
  // silently drop events on remotes with XDG_CONFIG_HOME set.
  const configRootProbe = await connection.exec(
    ['sh', '-c', 'printf "%s" "${XDG_CONFIG_HOME:-$HOME/.config}"'],
    { timeoutMs: 5000 }
  )
  await expectOk(configRootProbe, 'install-failed', 'Unable to resolve remote config root')
  const configRoot = configRootProbe.stdout.trim()
  if (!configRoot.startsWith('/')) {
    throw new HostBootstrapError('install-failed', 'Remote config root is not an absolute path')
  }

  const hooksDir = posix.join(configRoot, 'pewpew', 'hooks')
  const notifyScriptPath = posix.join(hooksDir, `notify-v${NOTIFY_SCRIPT_VERSION}.sh`)
  const breadcrumbPath = posix.join(hooksDir, 'socket-path')
  const guardScriptPath = posix.join(
    hooksDir,
    `worktree-guard-v${WORKTREE_GUARD_SCRIPT_VERSION}.sh`
  )
  const installScript =
    'set -e\n' +
    'mkdir -p "$1"\n' +
    'if [ ! -f "$2" ] || ! grep -q "PEWPEW_NOTIFY_VERSION=$5" "$2"; then\n' +
    '  printf "%s" "$4" > "$2"\n' +
    '  chmod 700 "$2"\n' +
    'fi\n' +
    'printf "%s\\n" "$3" > "$6"\n' +
    'if [ ! -f "$7" ] || ! grep -q "PEWPEW_WORKTREE_GUARD_VERSION=$9" "$7"; then\n' +
    '  printf "%s" "$8" > "$7"\n' +
    '  chmod 755 "$7"\n' +
    'fi\n'
  const install = await connection.exec(
    [
      'sh',
      '-c',
      installScript,
      '_',
      hooksDir,
      notifyScriptPath,
      remoteSocketPath,
      notifyScript,
      String(NOTIFY_SCRIPT_VERSION),
      breadcrumbPath,
      guardScriptPath,
      worktreeGuardScript,
      String(WORKTREE_GUARD_SCRIPT_VERSION),
    ],
    { timeoutMs: 15000 }
  )
  await expectOk(
    install,
    'install-failed',
    'Unable to install remote notify hook and worktree guard'
  )

  bootstrapped.set(hostId, { notifyScriptPath, guardScriptPath, remoteSocketPath })
  return { notifyScriptPath, guardScriptPath, remoteSocketPath, agentPaths }
}
