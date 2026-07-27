import { posix } from 'path'
import type { ExecResult } from './host-connection'
import type { AgentTool } from '../shared/types'

export const NOTIFY_SCRIPT_VERSION = 1

// Tools pewpew strictly requires on a remote host for sessions and the notify
// hook to work. Exported so the connection-test flow can surface missing ones
// up front instead of letting a session/mirror fail deep in bootstrap.
export const STRICT_DEPS = ['tmux', 'git', 'jq', 'socat'] as const
export const AGENT_TOOLS: readonly AgentTool[] = ['claude', 'codex', 'omp'] as const

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

export const OMP_HOOK_SCRIPT_VERSION = 1

// omp loads its hook bridge via `--hook <path>` (a real file, not a piece of
// declarative JSON), so unlike notifyScript above this has to be installed as
// its own file rather than merged into a settings/hooks JSON blob. This is a
// duplicate of hooks/omp-notify.ts's logic (kept in sync by hand) rather than
// reading that file at runtime, because the remote install has to inline the
// script text into a single ssh round trip the same way notifyScript does —
// with the resolved absolute notifyScriptPath baked in directly instead of
// recomputed from CONFIG_DIR/XDG_CONFIG_HOME (which only makes sense for a
// local install where "this machine's home dir" is unambiguous).
function buildOmpHookScript(notifyScriptPath: string): string {
  return `// pewpew omp hook bridge v${OMP_HOOK_SCRIPT_VERSION}
// PEWPEW_OMP_HOOK_VERSION=${OMP_HOOK_SCRIPT_VERSION}
import { execFileSync } from 'node:child_process'

const NOTIFY_SCRIPT = ${JSON.stringify(notifyScriptPath)}

function notify(hookEventName, params) {
  const payload = JSON.stringify({ hook_event_name: hookEventName, ...params })
  try {
    execFileSync(NOTIFY_SCRIPT, [], { input: payload, stdio: ['pipe', 'ignore', 'ignore'] })
  } catch {
    // Best effort — pewpew may not be running, or the socket may be gone.
  }
}

export default function (pi) {
  pi.on('session_start', (_event, ctx) => notify('SessionStart', { cwd: ctx.cwd }))
  pi.on('agent_end', (event, ctx) => {
    if (event.willContinue) return
    notify('Stop', { cwd: ctx.cwd })
  })
  pi.on('tool_result', (_event, ctx) => notify('PostToolUse', { cwd: ctx.cwd }))
  pi.on('session_shutdown', (_event, ctx) => notify('SessionEnd', { cwd: ctx.cwd, reason: 'other' }))
}
`
}

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
  ompHookScriptPath: string
  remoteSocketPath: string
}

export interface HostBootstrapResult {
  notifyScriptPath: string
  ompHookScriptPath: string
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
// Output is one line per AGENT_TOOLS entry (claude, codex, omp — in that
// order), each containing the absolute path or empty. The order here, the
// resolve_one calls below, and the positional args passed into the script by
// resolveRemoteAgents must all stay in lockstep — resolveRemoteAgents maps
// stdout lines back to tools by array index, so a mismatch silently
// mis-assigns a resolved path to the wrong tool.
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
resolve_one omp "$3"
`

export async function resolveRemoteAgents(
  connection: HostBootstrapConnection,
  cachedAgentPaths: AgentResolution = {}
): Promise<AgentResolution> {
  const result = await connection.exec(
    [
      'sh',
      '-c',
      RESOLVE_SCRIPT,
      '_',
      cachedAgentPaths.claude ?? '',
      cachedAgentPaths.codex ?? '',
      cachedAgentPaths.omp ?? '',
    ],
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
  const ompHookScriptPath = posix.join(hooksDir, `omp-notify-v${OMP_HOOK_SCRIPT_VERSION}.ts`)
  const breadcrumbPath = posix.join(hooksDir, 'socket-path')
  const installScript =
    'set -e\n' +
    'mkdir -p "$1"\n' +
    'if [ ! -f "$2" ] || ! grep -q "PEWPEW_NOTIFY_VERSION=$5" "$2"; then\n' +
    '  printf "%s" "$4" > "$2"\n' +
    '  chmod 700 "$2"\n' +
    'fi\n' +
    'printf "%s\\n" "$3" > "$6"\n'
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
    ],
    { timeoutMs: 15000 }
  )
  await expectOk(install, 'install-failed', 'Unable to install remote notify hook')

  // Separate install step: the omp hook bridge is a plain file (loaded via
  // `--hook <path>`, not merged JSON), so it doesn't share installScript's
  // socket-breadcrumb/notify.sh write above. The reinstall guard checks BOTH
  // the bridge's own version marker AND that the current notifyScriptPath is
  // still baked in as a literal — otherwise bumping NOTIFY_SCRIPT_VERSION
  // alone (without also touching OMP_HOOK_SCRIPT_VERSION) would leave an
  // already-installed bridge silently pointing at a notify.sh path that no
  // longer exists, and omp events would go nowhere on already-bootstrapped
  // hosts.
  const ompHookInstallScript =
    'set -e\n' +
    'mkdir -p "$1"\n' +
    'if [ ! -f "$2" ] || ! grep -q "PEWPEW_OMP_HOOK_VERSION=$4" "$2" || ! grep -qF "$5" "$2"; then\n' +
    '  printf "%s" "$3" > "$2"\n' +
    'fi\n'
  const ompHookInstall = await connection.exec(
    [
      'sh',
      '-c',
      ompHookInstallScript,
      '_',
      hooksDir,
      ompHookScriptPath,
      buildOmpHookScript(notifyScriptPath),
      String(OMP_HOOK_SCRIPT_VERSION),
      notifyScriptPath,
    ],
    { timeoutMs: 15000 }
  )
  await expectOk(ompHookInstall, 'install-failed', 'Unable to install remote omp hook bridge')

  bootstrapped.set(hostId, { notifyScriptPath, ompHookScriptPath, remoteSocketPath })
  return { notifyScriptPath, ompHookScriptPath, remoteSocketPath, agentPaths }
}
