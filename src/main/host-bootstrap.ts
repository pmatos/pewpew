import { posix } from 'path'
import type { ExecResult } from './host-connection'
import type { AgentTool } from '../shared/types'

export const NOTIFY_SCRIPT_VERSION = 1
export const WORKTREE_GUARD_SCRIPT_VERSION = 7

// Tools pewpew strictly requires on a remote host for sessions and the notify
// hook to work. Exported so the connection-test flow can surface missing ones
// up front instead of letting a session/mirror fail deep in bootstrap.
export const STRICT_DEPS = ['tmux', 'git', 'jq', 'socat'] as const
export const AGENT_TOOLS: readonly AgentTool[] = ['claude', 'codex', 'omp'] as const

// Soft dependency: bubblewrap confines the agent's Bash subprocesses to the
// worktree (see agent-sandbox.ts). Unlike STRICT_DEPS, its absence doesn't
// block the session — it just runs unsandboxed against Bash, same as a host
// without bwrap has always run.
export const SANDBOX_DEPS = ['bwrap'] as const

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

payload=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  # jq is required for every decision this hook makes, so its absence can't
  # be treated as "nothing to guard here" — that would silently disable the
  # guard for the rest of the session. Deny with a hand-built JSON reason
  # (there's no jq available to build one) instead of failing open.
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"pewpew: worktree guard cannot run because jq is not installed on this host; blocking the write (fail-closed)"}}'
  exit 0
fi

# A payload that isn't valid JSON at all is indistinguishable, further down,
# from "a tool call with no file_path" (both make the later jq extractions
# come back empty) — which exits allow. That's the wrong default for
# malformed input: legitimate Write/Edit/MultiEdit/NotebookEdit calls from
# Claude Code are always well-formed JSON, so anything else must fail closed.
if ! printf '%s' "$payload" | jq -e . >/dev/null 2>&1; then
  jq -nc --arg reason "pewpew: the hook payload is not valid JSON; blocking the write (fail-closed)" \\
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
fi

# Canonicalize the root itself (resolves any symlinks in the worktree path).
# A cd failure means the baked-in root no longer matches reality (e.g. the
# worktree was relocated or deleted after this hook was installed) — deny
# rather than silently allowing every write, the same fail-closed posture
# used for every other failure mode below.
root_real=$(cd "$root" 2>/dev/null && pwd -P)
if [ -z "$root_real" ]; then
  jq -nc --arg reason "pewpew: could not resolve the worktree root ($root) — it may have been moved or deleted; blocking the write (fail-closed)" \\
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
fi

# /tmp is exempt from the worktree boundary: under the bwrap sandbox it's a
# private --tmpfs mount unique to this session (see agent-sandbox.ts), not
# the host's shared /tmp, so a write there can't reach another session or
# the host filesystem the way a write to an arbitrary host path could. This
# hook has no visibility into whether bwrap is actually active for *this*
# session (it's installed with just the worktree root baked in), so on an
# unsandboxed session /tmp is genuinely the shared host /tmp and this
# exemption is a real (accepted) gap there — bwrap being unavailable already
# degrades every other write-containment guarantee this project makes, not
# just this one. Canonicalized the same way as root_real so a symlinked
# /tmp (e.g. macOS's /tmp -> /private/tmp) still matches.
tmp_real=$(cd /tmp 2>/dev/null && pwd -P)

# ~/.claude is exempt from the worktree boundary too: Claude Code keeps
# adding per-invocation scratch state directly under ~/.claude
# (session-env/, tasks/, and its cross-project auto-memory system under
# projects/<other-project>/memory/, keyed by the MAIN repo's path — not
# this worktree's), so a write there is expected and this hook would
# otherwise be the one thing left blocking it. claude sessions are never
# bwrap-sandboxed (see buildAgentArgs in pty-manager.ts), so
# CLAUDE_DIR_WRITE_DENYLIST below — this hook's own list, not shared with
# any other file — is what re-closes the specific entries that would turn
# a compromised write into a persistence vector for every later session
# that loads them. Canonicalized the same way as root_real/tmp_real so a
# symlinked ~/.claude (e.g. a dotfiles-managed home) still matches, and
# gated the same way below on being non-empty so a failed \`cd\` can't
# collapse the case pattern into a match-everything wildcard.
#
# Deliberately NOT extended to ~/.claude.json (sibling of this dir, not a
# child — mixes benign per-project bookkeeping with global MCP server
# config): the boundary check below only matches "$claude_real" or
# "$claude_real"/*, which a sibling file never does, so no extra exclusion
# is needed for it.
claude_real=$(cd "$HOME/.claude" 2>/dev/null && pwd -P)
CLAUDE_DIR_WRITE_DENYLIST=(
  commands output-styles skills agents plugins backups daemon shell-snapshots
  settings.json settings.backup.json CLAUDE.md statusline.sh .credentials.json
)

# Check for an embedded/trailing newline in the raw JSON string BEFORE ever
# assigning it into a shell variable: \`target=$(...)\` below would silently
# strip a trailing newline via command substitution, so validating $target
# after the fact can't detect it — a file literally named "evil\\n" would
# then be checked as the (different, likely nonexistent) path "evil" while
# Write/Edit still operates on the real newline-suffixed name. jq's \`test()\`
# runs against the full string value jq parsed from the JSON, unaffected by
# shell stripping.
has_newline=$(printf '%s' "$payload" | jq -r '(.tool_input.file_path // .tool_input.notebook_path // "") | test("\\n")' 2>/dev/null)
if [ "$has_newline" = "true" ]; then
  jq -nc --arg reason "pewpew: the write target contains a newline; blocking the write (fail-closed)" \\
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
fi

target=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)
[ -z "$target" ] && exit 0

# Resolve an absolute, symlink-free, \`.\`/\`..\`-normalized path even when the
# target doesn't exist yet (a new file's parent directory may not have been
# created). Processes path components left to right through a work queue:
# \`..\` pops the last resolved component lexically, independent of whether
# that component currently exists on disk; any component that resolves to an
# existing symlink — including the FINAL component, and including a symlink
# to a regular file rather than a directory — has its target re-queued for
# the same treatment, so a chain of symlinks and \`..\` segments is fully
# unwound rather than left partially resolved (which previously let a
# final-component symlink, or a \`..\` past a not-yet-created component,
# through unresolved).
resolve_path() {
  p="$1"
  case "$p" in
    /*) ;;
    *) p="$root_real/$p" ;;
  esac

  queue=()
  IFS='/' read -r -a queue <<< "$p"

  resolved=()
  symlink_hops=0
  iterations=0
  while [ "\${#queue[@]}" -gt 0 ]; do
    iterations=$((iterations + 1))
    # Backstop against a pathological number of path components; ordinary
    # paths never come close to this.
    [ "$iterations" -gt 10000 ] && return 1

    part="\${queue[0]}"
    queue=("\${queue[@]:1}")

    case "$part" in
      '' | '.') continue ;;
      '..')
        last=$((\${#resolved[@]} - 1))
        [ "$last" -ge 0 ] && unset 'resolved[last]'
        continue
        ;;
    esac

    resolved+=("$part")
    candidate="/$(IFS=/; printf '%s' "\${resolved[*]}")"

    if [ -L "$candidate" ]; then
      symlink_hops=$((symlink_hops + 1))
      # Bound symlink dereferences specifically (matching Linux's own
      # MAXSYMLINKS), not ordinary path components, so a genuinely deep but
      # legitimate path can't spuriously hit this cap — only a symlink cycle
      # can.
      [ "$symlink_hops" -gt 40 ] && return 1
      last=$((\${#resolved[@]} - 1))
      unset 'resolved[last]'
      # Same newline-truncation class as the target extraction above: a
      # symlink whose target string itself contains a newline would have
      # that newline silently dropped by \`$(readlink ...)\`, potentially
      # collapsing an out-of-worktree target onto an in-worktree-looking
      # string. \`readlink\` normally emits exactly one line (the target plus
      # its own terminator); more than one line means the target contains an
      # embedded or trailing newline. Piped directly to \`wc -l\`, unaffected
      # by command-substitution stripping.
      [ "$(readlink "$candidate" | wc -l)" -gt 1 ] && return 1
      linktarget=$(readlink "$candidate") || return 1
      case "$linktarget" in
        /*) resolved=() ;;
      esac
      target_parts=()
      IFS='/' read -r -a target_parts <<< "$linktarget"
      queue=("\${target_parts[@]}" "\${queue[@]}")
    fi
  done

  printf '/%s' "$(IFS=/; printf '%s' "\${resolved[*]}")"
}

target_real=$(resolve_path "$target")

reason=""
allowed=0

if [ -z "$target_real" ]; then
  # resolve_path failed (symlink-cycle cap, a component vanishing mid-walk,
  # or similar) — the same fail-closed reasoning as everywhere else in this
  # script: if the guard can't determine whether a target is safe, it must
  # not let it through.
  reason="pewpew: could not canonicalize the write target ($target); blocking the write (fail-closed)"
else
  # Path-boundary check: target must be the root itself, or start with "root/".
  # A plain string-prefix check would let a sibling like "<root>-evil" through.
  case "$target_real" in
    "$root_real") allowed=1 ;;
    "$root_real"/*) allowed=1 ;;
    *) allowed=0 ;;
  esac

  # /tmp exemption (see tmp_real above). Guarded on tmp_real being non-empty
  # and checked outside the case above rather than as extra arms in it: an
  # empty case pattern (if \`cd /tmp\` ever failed) would collapse "$tmp_real"/*
  # into the wildcard /*, matching every absolute path.
  if [ "$allowed" != "1" ] && [ -n "$tmp_real" ]; then
    case "$target_real" in
      "$tmp_real") allowed=1 ;;
      "$tmp_real"/*) allowed=1 ;;
    esac
  fi

  # ~/.claude exemption (see claude_real above), minus CLAUDE_DIR_WRITE_DENYLIST.
  if [ "$allowed" != "1" ] && [ -n "$claude_real" ]; then
    case "$target_real" in
      "$claude_real") allowed=1 ;;
      "$claude_real"/*) allowed=1 ;;
    esac
    if [ "$allowed" = "1" ]; then
      for entry in "\${CLAUDE_DIR_WRITE_DENYLIST[@]}"; do
        denylisted="$claude_real/$entry"
        case "$target_real" in
          "$denylisted" | "$denylisted"/*)
            allowed=0
            reason="pewpew: ~/.claude/$entry is a global execution/config surface loaded by every future session; blocking the write (fail-closed)"
            ;;
        esac
      done
    fi
  fi

  guard_settings="$root_real/.claude/settings.local.json"
  # \`-ef\` (same file, via inode/device) catches what the exact string match
  # above misses on a case-insensitive-but-case-preserving filesystem (e.g.
  # macOS's default APFS mode): a differently-cased path like
  # ".claude/Settings.local.json" opens the identical on-disk file without
  # matching the string comparison. \`-ef\` requires both operands to exist,
  # so it only ever adds a match — it can't be tricked by a nonexistent path.
  if [ "$target_real" = "$guard_settings" ] || \\
    { [ -e "$target_real" ] && [ -e "$guard_settings" ] && [ "$target_real" -ef "$guard_settings" ]; }; then
    allowed=0
    reason="pewpew: this hook's own settings file ($guard_settings) may not be edited"
  fi
fi

[ "\${allowed:-0}" = "1" ] && exit 0

if [ -z "$reason" ]; then
  reason="pewpew: blocked write outside the session worktree ($root_real) — target resolved to $target_real"
fi

jq -nc --arg reason "$reason" \\
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
exit 0
`

export const OMP_HOOK_SCRIPT_VERSION = 1

// Matches hooks/omp-notify.ts's NOTIFY_TIMEOUT_MS — kept in sync by hand
// alongside the rest of this duplicated bridge logic (see the comment below).
const OMP_HOOK_NOTIFY_TIMEOUT_MS = 2000

// omp loads its hook bridge via `--hook <path>` (a real file, not a piece of
// declarative JSON), so unlike notifyScript above this has to be installed as
// its own file rather than merged into a settings/hooks JSON blob. This is a
// duplicate of hooks/omp-notify.ts's logic (kept in sync by hand) rather than
// reading that file at runtime, because the remote install has to inline the
// script text into a single ssh round trip the same way notifyScript does —
// with the resolved absolute notifyScriptPath baked in directly instead of
// recomputed from CONFIG_DIR/XDG_CONFIG_HOME (which only makes sense for a
// local install where "this machine's home dir" is unambiguous).
//
// MANUAL SYNC CHECKLIST — host-bootstrap.test.ts asserts this generated
// script registers the same pi.on(...) event set and the same
// NOTIFY_TIMEOUT_MS value as hooks/omp-notify.ts, but NOT full handler-body
// behavior, so when changing hooks/omp-notify.ts also mirror here:
//   - add/remove/rename a pi.on(...) event
//   - change NOTIFY_TIMEOUT_MS (OMP_HOOK_NOTIFY_TIMEOUT_MS below)
//   - change the willContinue skip (or any other handler conditional)
//   - change the notify() payload shape
//
// The generated script's `import` line is built via string concatenation
// (not a literal `import ... from ...` substring in this file) so it can't
// be statically pattern-matched as a real import by electron-vite's ESM
// __dirname/__filename/require shim injector — that injector scans the
// bundled *output* text for import-looking lines and once mistook this
// template literal's embedded import statement for a real one, inserting
// its CommonJS-shim boilerplate here instead of at this file's actual top,
// leaving every real `__dirname` use elsewhere in the bundle undefined.
const OMP_HOOK_IMPORT_LINE = ['import', '{ execFileSync }', 'from', "'node:child_process'"].join(
  ' '
)

function buildOmpHookScript(notifyScriptPath: string): string {
  return `// pewpew omp hook bridge v${OMP_HOOK_SCRIPT_VERSION}
// PEWPEW_OMP_HOOK_VERSION=${OMP_HOOK_SCRIPT_VERSION}
${OMP_HOOK_IMPORT_LINE}

const NOTIFY_SCRIPT = ${JSON.stringify(notifyScriptPath)}
// Bounds notify() so a hung notify.sh/socat can't stall the omp agent loop —
// this runs on every tool_result, not just at session start/end.
const NOTIFY_TIMEOUT_MS = ${OMP_HOOK_NOTIFY_TIMEOUT_MS}

function notify(hookEventName, params) {
  const payload = JSON.stringify({ hook_event_name: hookEventName, ...params })
  try {
    execFileSync(NOTIFY_SCRIPT, [], {
      input: payload,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: NOTIFY_TIMEOUT_MS,
    })
  } catch {
    // Best effort — pewpew may not be running, the socket may be gone, or
    // the call timed out.
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
  guardScriptPath: string
  ompHookScriptPath: string
  remoteSocketPath: string
}

export interface HostBootstrapResult {
  notifyScriptPath: string
  guardScriptPath: string
  ompHookScriptPath: string
  remoteSocketPath: string
  sandboxAvailable: boolean
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

// Remote counterpart of pty-manager.ts's local probeSandboxUsable(): runs a
// minimal real bwrap invocation over SSH instead of just `command -v bwrap`.
// Presence on PATH doesn't prove bwrap can create the namespaces/mounts it
// needs — unprivileged userns can be disabled host-wide, or an LSM/container
// policy can block it — and a host that fails that way would get a session
// that dies instantly instead of falling back to unsandboxed. The argv here
// is a strict subset of buildSandboxArgs's production prefix, so a pass here
// isn't a false positive on a host that can list bwrap but can't run it.
// Non-fatal: any failure (missing binary, nonzero exit, timeout) resolves to
// false so sandboxing degrades gracefully and never blocks session creation.
export async function probeRemoteSandboxUsable(
  connection: HostBootstrapConnection
): Promise<boolean> {
  try {
    const result = await connection.exec(
      [
        'sh',
        '-c',
        'bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --tmpfs /tmp -- /bin/true',
      ],
      { timeoutMs: 8000 }
    )
    return !result.timedOut && result.code === 0
  } catch {
    return false
  }
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
    // sandboxAvailable is re-probed too (not cached) because it's a mutable
    // host capability, not a static install-time fact: bwrap can be installed
    // or removed, or a kernel/LSM policy can change, between sessions on the
    // same host within one app run.
    const [agentPaths, sandboxAvailable] = await Promise.all([
      resolveRemoteAgents(connection, cachedAgentPaths),
      probeRemoteSandboxUsable(connection),
    ])
    return { ...cached, sandboxAvailable, agentPaths }
  }

  const missingStrict = await probeMissingDeps(connection)
  if (missingStrict.length > 0) {
    throw new HostBootstrapError(
      'missing-deps',
      `Remote host is missing required tools: ${missingStrict.join(', ')}`,
      missingStrict
    )
  }

  const [agentPaths, socketProbe, sandboxAvailable] = await Promise.all([
    resolveRemoteAgents(connection, cachedAgentPaths),
    connection.exec(['sh', '-c', 'test -S "$1"', '_', remoteSocketPath], {
      timeoutMs: 5000,
    }),
    // Non-fatal: a probe failure (ssh hiccup, bwrap missing, or bwrap present
    // but unable to create namespaces) is treated the same as "sandbox
    // unavailable" — sandboxing degrades gracefully, it never blocks session
    // creation the way a STRICT_DEPS miss does.
    probeRemoteSandboxUsable(connection),
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
    '  chmod 700 "$7"\n' +
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
    'if [ ! -f "$2" ] || ! grep -qF "PEWPEW_OMP_HOOK_VERSION=$4" "$2" || ! grep -qF "$5" "$2"; then\n' +
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

  bootstrapped.set(hostId, {
    notifyScriptPath,
    guardScriptPath,
    ompHookScriptPath,
    remoteSocketPath,
  })
  return {
    notifyScriptPath,
    guardScriptPath,
    ompHookScriptPath,
    remoteSocketPath,
    sandboxAvailable,
    agentPaths,
  }
}
