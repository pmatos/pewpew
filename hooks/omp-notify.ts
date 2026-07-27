// Bridges omp's (oh-my-pi) native hook events to pewpew's existing notify.sh
// delivery pipeline (JSON on stdin -> unix socket -> hook-server.ts).
//
// Unlike Claude/Codex, omp hooks are JS/TS modules loaded via the CLI's
// `--hook <path>` flag rather than declarative JSON written into the project,
// so this file needs no per-worktree install, gitignore entry, rollback
// snapshot, or config feature flag — pewpew just points `--hook` at this file
// (or, for remote hosts, at a copy installed alongside the remote notify
// script; see host-bootstrap.ts).
//
// Loaded by omp itself (via Bun's native TS import), not by pewpew's own
// tsc/eslint — see the repo-root tsconfig.json ("include": ["src"]).
//
// omp's `--hook` flag is actually an alias for `--extension` (both feed the
// same `additionalExtensionPaths` list), so this file is loaded through the
// extension loader, not the dedicated hook loader/capability. That's fine:
// ExtensionAPI.on() accepts the exact same event names as HookAPI.on() (both
// subsystems share event payload types from extensibility/shared-events.ts),
// and ExtensionContext is a strict superset of HookContext including `cwd` —
// this file only ever calls `.on()` and reads `ctx.cwd`, so it works
// identically under either loader.

import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Mirrors src/main/config.ts's CONFIG_DIR resolution exactly, since this file
// is only used for LOCAL sessions (remote installs get a copy with the
// correct remote notify script path substituted in — see host-bootstrap.ts).
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'pewpew')
const NOTIFY_SCRIPT = join(CONFIG_DIR, 'hooks', 'notify.sh')

// notify() runs synchronously on every tool_result — i.e. once per tool call,
// not just at session start/end — so an unbounded execFileSync could stall
// the whole omp agent loop if notify.sh/socat ever hung (e.g. hook-server
// accepting but not promptly reading/closing under load). The timeout bounds
// that; the existing catch below already treats any failure, including a
// timeout's SIGTERM, as best-effort.
const NOTIFY_TIMEOUT_MS = 2000

function notify(hookEventName: string, params: Record<string, unknown>): void {
  const payload = JSON.stringify({ hook_event_name: hookEventName, ...params })
  try {
    execFileSync(NOTIFY_SCRIPT, [], {
      input: payload,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: NOTIFY_TIMEOUT_MS,
    })
  } catch {
    // Best effort — pewpew may not be running, the notify script/socket may
    // be missing, or the call timed out. Never let a notification failure
    // interrupt the agent.
  }
}

// HookAPI's `pi` param is typed by omp itself; this file has no dependency on
// omp's own package, so handlers are typed structurally rather than imported.
interface HookEventCtx {
  cwd: string
}
interface HookApiLike {
  on(event: string, handler: (event: Record<string, unknown>, ctx: HookEventCtx) => void): void
}

export default function (pi: HookApiLike): void {
  // Fired on initial session load. Maps to Claude/Codex's SessionStart.
  pi.on('session_start', (_event, ctx) => {
    notify('SessionStart', { cwd: ctx.cwd })
  })

  // Fired when an agent loop ends. `willContinue` means a continuation
  // (auto-retry, empty/unexpected-stop retry) is already scheduled — that is
  // not a user-visible settle, so skip it. Otherwise this is the closest omp
  // equivalent to Claude/Codex's Stop (assistant turn settled, awaiting user).
  pi.on('agent_end', (event, ctx) => {
    if (event.willContinue) return
    notify('Stop', { cwd: ctx.cwd })
  })

  // Fired after each tool call completes. Maps to Claude/Codex's PostToolUse.
  pi.on('tool_result', (_event, ctx) => {
    notify('PostToolUse', { cwd: ctx.cwd })
  })

  // Fired only on process exit (SIGINT/SIGTERM) — unlike Claude's SessionEnd,
  // omp has no /clear-still-alive nuance to special-case here, so any
  // session_shutdown unconditionally means the agent process is gone.
  pi.on('session_shutdown', (_event, ctx) => {
    notify('SessionEnd', { cwd: ctx.cwd, reason: 'other' })
  })
}
