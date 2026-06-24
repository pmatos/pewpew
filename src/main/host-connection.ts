// INVARIANT: callers of exec() pass each path argument as its own argv entry;
// shellQuote handles POSIX single-quoting for the remote shell. Never concatenate
// user input into argv strings before passing them in. Both exec() and
// testConnection() insert `--` before the alias so a host alias beginning with
// `-` (e.g. from a hand-edited config.json) cannot be interpreted by ssh as an
// option, even if upstream validation was bypassed.

import { execFile, spawn } from 'child_process'
import { mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir, userInfo } from 'os'
import * as pty from 'node-pty'
import type { IPty, IPtyForkOptions } from 'node-pty'
import { shellQuote } from './shell-quote'
import {
  STRICT_DEPS,
  AGENT_TOOLS,
  probeMissingDeps,
  resolveRemoteAgents,
  type HostBootstrapConnection,
} from './host-bootstrap'
import { classifySshExit } from './ssh-exit-parser'
import { recordSshInvocation } from './ssh-log-buffer'
import { emitToast } from './notifications'
import { getHost } from './host-registry'
import { CONFIG_DIR } from './config'
import { sanitizeHostIdForPath } from './host-id'
import type {
  DependencyStatus,
  Host,
  HostId,
  SshInvocationKind,
  TestConnectionResult,
  ToastSeverity,
  ValidateRemoteRepoResult,
} from '../shared/types'

interface SshLogContext {
  hostId?: HostId
  kind: SshInvocationKind
}

function logSshInvocation(
  ctx: SshLogContext | undefined,
  argv: string[],
  exitCode: number | null,
  stderr: string,
  durationMs: number
): void {
  if (!ctx?.hostId) return
  recordSshInvocation({
    ts: Date.now(),
    hostId: ctx.hostId,
    kind: ctx.kind,
    argv,
    exitCode,
    stderrSnippet: stderr.slice(0, 1024),
    durationMs,
  })
}

// Bootstrap signals that an early dep-missing toast from a probe would be
// redundant with the richer toast bootstrap will emit on completion. Cleared
// when bootstrap finishes (success or failure) — see startBootstrapWindow.
const bootstrapInProgress = new Set<HostId>()
export function startBootstrapWindow(hostId: HostId): () => void {
  bootstrapInProgress.add(hostId)
  return () => bootstrapInProgress.delete(hostId)
}

function firstStderrLine(stderr: string): string {
  for (const raw of stderr.split('\n')) {
    const line = raw.trim()
    if (line) return line
  }
  return ''
}

function hostLabel(host: Host): string {
  return getHost(host.hostId)?.label ?? host.alias
}

function maybeEmitFailureToast(
  host: Host,
  kind: SshInvocationKind,
  exitCode: number | null,
  stderr: string
): void {
  if (exitCode === 0) return
  // `-O exit` non-zero typically means the control socket was already gone;
  // not actionable. The PTY attach exit is surfaced through the session card's
  // connection-state UI; a parallel toast would spam every disconnect. Probes
  // taken during bootstrap collide with the bootstrap layer's own toast.
  if (kind === 'control-exit' || kind === 'attach') return
  // Probes and execs taken during bootstrap collide with the bootstrap
  // layer's own toast. bootstrapHost runs all its probes through
  // connection.exec (kind='exec'), not the runtime's internal controlCheck
  // (kind='probe'), so both must be suppressed here. session-manager's
  // HostBootstrapError handler is the single source of truth during the
  // bootstrap window.
  if ((kind === 'probe' || kind === 'exec') && bootstrapInProgress.has(host.hostId)) return

  const { reason, message } = classifySshExit({ exitCode, stderr })
  // For exec invocations, an unrecognized non-zero exit is most often the
  // remote command's own exit code (e.g. `tmux has-session` returning 1 when
  // the session is absent). Surface only the four reasons we can attribute to
  // SSH itself so legitimate "absent"/"empty" probe outcomes don't spam the
  // user with "ssh failed: exit 1" warnings during reconnect / batch probes.
  // Control-connection failures are different: any non-zero there *is* an
  // SSH-level problem, so the generic toast still fires for kind='control'.
  if (kind === 'exec' && reason === 'unknown') return
  const detail = firstStderrLine(stderr) || message
  const label = hostLabel(host)
  let severity: ToastSeverity = 'error'
  let title: string
  switch (reason) {
    case 'auth-failed':
      title = `SSH authentication failed on ${label}`
      break
    case 'network':
      title = `Cannot reach ${label}`
      break
    case 'bind-unlink':
      title = `${label}: remote sshd needs StreamLocalBindUnlink yes`
      break
    case 'dep-missing':
      title = `${label}: tool missing on remote`
      break
    default:
      severity = 'warning'
      title = `ssh failed on ${label}: exit ${exitCode ?? '?'}`
  }
  emitToast({ severity, title, detail, hostLabel: label })
}

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
  timedOut: boolean
}

export type HostConnectionState = 'offline' | 'connecting' | 'live' | 'auth-failed' | 'unreachable'

interface HostRuntime {
  host: Host
  controlPath: string
  localSocketPath: string
  remoteSocketPath: string
  child: ReturnType<typeof spawn> | null
  state: HostConnectionState
  refs: number
  ready?: Promise<void>
}

const runtimes = new Map<HostId, HostRuntime>()

// Fired after the SSH control connection is fully torn down. Lets higher-level
// modules (index.ts wires hook-server here) release resources that were
// allocated alongside the SSH runtime without host-connection taking on a
// cross-module dependency.
let onConnectionStopped: ((hostId: HostId) => void) | null = null
export function setOnHostConnectionStopped(fn: ((hostId: HostId) => void) | null): void {
  onConnectionStopped = fn
}

function uidSegment(): string {
  if (typeof process.getuid === 'function') return String(process.getuid())
  try {
    return String(userInfo().uid)
  } catch {
    return homedir().replace(/[^A-Za-z0-9_.-]/g, '_')
  }
}

export function remoteSocketPathForHost(hostId: HostId): string {
  // Include hostId so two configured hosts that resolve to the same remote
  // account don't collide on the reverse-forwarded socket (StreamLocalBindUnlink
  // would otherwise let the later connection steal the earlier one's socket).
  return `/tmp/pewpew-${uidSegment()}-${sanitizeHostIdForPath(hostId)}.sock`
}

function controlPathForHost(hostId: HostId): string {
  return join(CONFIG_DIR, `ssh-${sanitizeHostIdForPath(hostId)}.sock`)
}

function runtimeFor(host: Host, localSocketPath: string): HostRuntime {
  const existing = runtimes.get(host.hostId)
  if (existing) {
    existing.host = host
    existing.localSocketPath = localSocketPath
    return existing
  }

  mkdirSync(CONFIG_DIR, { recursive: true })
  const runtime: HostRuntime = {
    host,
    controlPath: controlPathForHost(host.hostId),
    localSocketPath,
    remoteSocketPath: remoteSocketPathForHost(host.hostId),
    child: null,
    state: 'offline',
    refs: 0,
  }
  runtimes.set(host.hostId, runtime)
  return runtime
}

// 16 MiB lets `tmux capture-pane -S -5000` (up to 5000 lines with ANSI escapes)
// fit even for wide terminals with heavy color output, which would otherwise
// overflow execFile's default and return empty scrollback on reattach.
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024

function runSsh(
  argv: string[],
  timeoutMs: number,
  ctx?: SshLogContext,
  maxBuffer = DEFAULT_MAX_BUFFER
): Promise<ExecResult> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const child = execFile(
      'ssh',
      argv,
      { timeout: timeoutMs, maxBuffer },
      (error, stdout, stderr) => {
        // execFile's `timeout` option kills the child with `killSignal` (default
        // SIGTERM) when it fires. Node sets `error.killed === true` in that
        // case; `error.code === 'ETIMEDOUT'` only appears for OS-level socket
        // timeouts and is kept as a belt-and-braces check.
        const errno = (error ?? null) as (NodeJS.ErrnoException & { killed?: boolean }) | null
        const timedOut = Boolean(errno && (errno.killed === true || errno.code === 'ETIMEDOUT'))
        // ENOENT means the ssh binary itself couldn't be launched. Surface it
        // as an exit-127 "command not found" so classifySshExit routes it to
        // `dep-missing` instead of the generic `unknown`.
        if (!timedOut && errno && errno.code === 'ENOENT') {
          const enoentStderr = 'ssh: command not found'
          logSshInvocation(ctx, argv, 127, enoentStderr, Date.now() - t0)
          resolve({
            stdout: '',
            stderr: enoentStderr,
            code: 127,
            timedOut: false,
          })
          return
        }
        const code = error
          ? typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : (child.exitCode ?? 1)
          : 0
        const stderrStr = stderr.toString()
        logSshInvocation(ctx, argv, code, stderrStr, Date.now() - t0)
        resolve({
          stdout: stdout.toString(),
          stderr: stderrStr,
          code,
          timedOut,
        })
      }
    )
  })
}

function controlArgs(runtime: HostRuntime): string[] {
  return [
    '-N',
    '-o',
    'BatchMode=yes',
    '-o',
    'ControlMaster=yes',
    '-o',
    `ControlPath=${runtime.controlPath}`,
    '-o',
    'ControlPersist=10m',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'StreamLocalBindUnlink=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-R',
    `${runtime.remoteSocketPath}:${runtime.localSocketPath}`,
    '--',
    runtime.host.alias,
  ]
}

async function controlCheck(runtime: HostRuntime): Promise<boolean> {
  const result = await runSsh(
    [
      '-o',
      'BatchMode=yes',
      '-o',
      `ControlPath=${runtime.controlPath}`,
      '-O',
      'check',
      '--',
      runtime.host.alias,
    ],
    1000,
    { hostId: runtime.host.hostId, kind: 'probe' }
  )
  return result.code === 0
}

async function waitForControl(runtime: HostRuntime): Promise<void> {
  const deadline = Date.now() + 5000
  // Don't bail on child.exitCode being set: ControlPersist daemonizes the
  // foreground ssh, so exitCode flips to 0 once setup completes while the
  // control socket lives on in the daemon. A non-zero exit is signaled by
  // exitPromise in startRuntime, which wins the Promise.race.
  async function poll(): Promise<void> {
    if (Date.now() >= deadline) {
      throw new Error('ssh control connection did not become ready')
    }
    if (await controlCheck(runtime)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
    await poll()
  }

  await poll()
}

export function classifyConnectionFailure(
  code: number | null,
  stderr: string
): HostConnectionState {
  const { reason } = classifySshExit({ exitCode: code, stderr })
  if (reason === 'auth-failed') return 'auth-failed'
  if (reason === 'network' || reason === 'bind-unlink') return 'unreachable'
  return 'offline'
}

export function runtimeStateFor(hostId: HostId): HostConnectionState | undefined {
  return runtimes.get(hostId)?.state
}

async function startRuntime(runtime: HostRuntime): Promise<void> {
  runtime.state = 'connecting'
  let stderr = ''
  const argv = controlArgs(runtime)
  const t0 = Date.now()

  const child = spawn('ssh', argv, {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  runtime.child = child

  child.stderr?.on('data', (data) => {
    stderr += data.toString()
  })

  // ControlPersist=10m + ControlMaster=yes forks the foreground ssh into the
  // background once the master socket is set up; the parent then exits 0 while
  // the daemon keeps the control socket alive. Treat code 0 as successful
  // daemonization and let waitForControl detect the live socket.
  const exitPromise = new Promise<never>((_, reject) => {
    child.once('exit', (code) => {
      logSshInvocation(
        { hostId: runtime.host.hostId, kind: 'control' },
        argv,
        code,
        stderr,
        Date.now() - t0
      )
      if (code === 0) return
      runtime.child = null
      runtime.state = classifyConnectionFailure(code, stderr)
      reject(new Error(stderr.trim() || `ssh control connection exited: ${code ?? 'signal'}`))
    })
  })

  // Attach before any await so spawn failures (ENOENT, EACCES) don't
  // bubble up as unhandled EventEmitter errors and crash the main process.
  const errorPromise = new Promise<never>((_, reject) => {
    child.once('error', (err) => {
      runtime.child = null
      runtime.state = 'offline'
      const errno = err as NodeJS.ErrnoException
      const errStderr =
        errno.code === 'ENOENT'
          ? 'ssh: command not found'
          : `ssh failed to spawn: ${errno.message || errno.code || 'unknown'}`
      // Spawn errors fire before child.stderr produces any data, so the outer
      // `stderr` buffer is empty. Surface the synthesized errStderr there so
      // the catch block's toast (and classifyConnectionFailure) see it.
      stderr = errStderr
      logSshInvocation(
        { hostId: runtime.host.hostId, kind: 'control' },
        argv,
        null,
        errStderr,
        Date.now() - t0
      )
      reject(new Error(errStderr))
    })
  })

  try {
    await Promise.race([waitForControl(runtime), exitPromise, errorPromise])
    runtime.state = 'live'
  } catch (err) {
    const exitCode = child.exitCode
    if (runtime.child) {
      try {
        runtime.child.kill()
      } catch {
        // Already gone.
      }
    }
    runtime.child = null
    maybeEmitFailureToast(runtime.host, 'control', exitCode, stderr)
    runtime.state = classifyConnectionFailure(exitCode, stderr)
    throw err
  }
}

export async function ensureHostConnection(
  host: Host,
  localSocketPath: string
): Promise<{ remoteSocketPath: string; controlPath: string }> {
  const runtime = runtimeFor(host, localSocketPath)
  // After ControlPersist daemonization the foreground child has exited but the
  // master daemon owns the control socket, so 'live' alone is the source of
  // truth for liveness here.
  if (runtime.state === 'live') {
    return { remoteSocketPath: runtime.remoteSocketPath, controlPath: runtime.controlPath }
  }
  if (!runtime.ready) {
    runtime.ready = startRuntime(runtime).finally(() => {
      runtime.ready = undefined
    })
  }
  await runtime.ready
  return { remoteSocketPath: runtime.remoteSocketPath, controlPath: runtime.controlPath }
}

export function retainHostConnection(hostId: HostId): void {
  const runtime = runtimes.get(hostId)
  if (runtime) runtime.refs++
}

export async function releaseHostConnection(hostId: HostId): Promise<void> {
  const runtime = runtimes.get(hostId)
  if (!runtime) return
  runtime.refs = Math.max(0, runtime.refs - 1)
  if (runtime.refs > 0) return
  await stopHostConnection(hostId)
}

export async function stopHostConnection(hostId: HostId): Promise<void> {
  const runtime = runtimes.get(hostId)
  if (!runtime) return

  // Always send `-O exit`: after ControlPersist daemonization the master is
  // owned by a forked child we no longer track, so the control socket is the
  // only handle on it. Falls through harmlessly if the socket is already gone.
  await runSsh(
    [
      '-o',
      'BatchMode=yes',
      '-o',
      `ControlPath=${runtime.controlPath}`,
      '-O',
      'exit',
      '--',
      runtime.host.alias,
    ],
    2000,
    { hostId: runtime.host.hostId, kind: 'control-exit' }
  ).catch(() => undefined)
  if (runtime.child) {
    try {
      runtime.child.kill()
    } catch {
      // Already gone.
    }
  }

  runtime.child = null
  runtime.state = 'offline'
  runtimes.delete(hostId)
  try {
    unlinkSync(runtime.controlPath)
  } catch {
    // Control socket may already be gone.
  }
  onConnectionStopped?.(hostId)
}

export async function stopAllHostConnections(): Promise<void> {
  await Promise.all(Array.from(runtimes.keys()).map((hostId) => stopHostConnection(hostId)))
}

export async function testConnection(
  alias: string,
  opts: { timeoutMs?: number } = {}
): Promise<TestConnectionResult> {
  const timeoutMs = opts.timeoutMs ?? 15000
  const argv = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', alias, 'true']
  const { stderr, code, timedOut } = await runSsh(argv, timeoutMs)

  if (timedOut) {
    return { ok: false, reason: 'network', message: 'ssh timed out' }
  }
  if (code !== 0) {
    const { reason, message } = classifySshExit({ exitCode: code, stderr })
    return { ok: false, reason, message }
  }

  // Connection works — probe the required tools and agent CLIs so the user
  // sees exactly what's missing (e.g. socat) before a session or mirror fails
  // deep in host bootstrap. Probes are best-effort: a probe that errors leaves
  // its field undefined rather than failing the whole test.
  const connection: HostBootstrapConnection = { exec: (a, o) => exec(alias, a, o) }
  const [requiredDeps, agentTools] = await Promise.all([
    probeRequiredDeps(connection),
    probeAgentTools(connection),
  ])
  return { ok: true, requiredDeps, agentTools }
}

async function probeRequiredDeps(
  connection: HostBootstrapConnection
): Promise<DependencyStatus[] | undefined> {
  try {
    const missing = new Set(await probeMissingDeps(connection))
    return STRICT_DEPS.map((name) => ({ name, installed: !missing.has(name) }))
  } catch {
    return undefined
  }
}

async function probeAgentTools(
  connection: HostBootstrapConnection
): Promise<DependencyStatus[] | undefined> {
  try {
    const resolved = await resolveRemoteAgents(connection)
    return AGENT_TOOLS.map((name) => ({ name, installed: Boolean(resolved[name]) }))
  } catch {
    return undefined
  }
}

function aliasOf(aliasOrHost: string | Host): string {
  return typeof aliasOrHost === 'string' ? aliasOrHost : aliasOrHost.alias
}

function runtimeForHostIfLive(host: Host): HostRuntime | undefined {
  const runtime = runtimes.get(host.hostId)
  return runtime?.state === 'live' ? runtime : undefined
}

// Forward-looking helper for remote project/session operations.
export async function exec(
  aliasOrHost: string | Host,
  argv: string[],
  opts: { timeoutMs?: number } = {}
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 30000
  const quoted = argv.map(shellQuote)
  const liveRuntime =
    typeof aliasOrHost === 'string' ? undefined : runtimeForHostIfLive(aliasOrHost)
  const sshArgv = liveRuntime
    ? [
        '-o',
        'BatchMode=yes',
        '-o',
        `ControlPath=${liveRuntime.controlPath}`,
        '--',
        aliasOf(aliasOrHost),
        ...quoted,
      ]
    : ['-o', 'BatchMode=yes', '--', aliasOf(aliasOrHost), ...quoted]
  const ctx: SshLogContext | undefined =
    typeof aliasOrHost === 'string' ? undefined : { hostId: aliasOrHost.hostId, kind: 'exec' }
  const result = await runSsh(sshArgv, timeoutMs, ctx)
  if (typeof aliasOrHost !== 'string' && !result.timedOut && result.code !== 0) {
    maybeEmitFailureToast(aliasOrHost, 'exec', result.code, result.stderr)
  }
  return result
}

export function spawnAttach(host: Host, argv: string[], options: IPtyForkOptions): IPty {
  const runtime = runtimeForHostIfLive(host)
  const quoted = argv.map(shellQuote)
  const sshArgv = [
    '-tt',
    '-o',
    'BatchMode=yes',
    ...(runtime ? ['-o', `ControlPath=${runtime.controlPath}`] : []),
    '--',
    host.alias,
    ...quoted,
  ]
  const t0 = Date.now()
  const ptyProcess = pty.spawn('ssh', sshArgv, options)
  // Stderr is piped to the PTY (the user sees it in xterm); we record the
  // exit code and full argv for ring-buffer reproducibility, leaving the
  // stderr snippet empty.
  ptyProcess.onExit(({ exitCode }) => {
    logSshInvocation(
      { hostId: host.hostId, kind: 'attach' },
      sshArgv,
      exitCode,
      '',
      Date.now() - t0
    )
  })
  return ptyProcess
}

// Validates that a remote path is a git repository ROOT (not a subdirectory)
// and extracts its root-commit fingerprint in a single ssh round-trip. The
// remote path is passed as a positional argument ($1) to `sh -c`, never
// interpolated into the script text — this keeps the INVARIANT at the top of
// this file intact even for paths containing shell metacharacters.
//
// The probe uses `git rev-parse --show-prefix`: it exits 0 with an empty
// stdout at a repo root, 0 with a non-empty "subdir/" at a subdirectory, and
// ~128 outside any repo. We reject non-empty prefixes with exit 2 and a
// diagnostic on stderr so the caller can surface "must be the repository
// root" instead of a generic error. Worktrees and submodules (where `.git` is
// a file) are accepted because `rev-parse` resolves them natively.
//
// The fingerprint step is best-effort: an empty repo with no HEAD returns
// an empty fingerprint, not a rejection.
//
// The probe deliberately does NOT swallow `rev-parse`'s stderr and propagates
// the original exit code, so that a missing `git` binary on the remote
// (shell-level exit 127 + "command not found") remains distinguishable from a
// path that simply isn't a git repo — `classifySshExit` routes the former to
// `dep-missing`.
export async function validateRemoteRepo(
  alias: string,
  path: string,
  opts: { timeoutMs?: number } = {}
): Promise<ValidateRemoteRepoResult> {
  const script =
    'prefix=$(git -C "$1" rev-parse --show-prefix)\n' +
    'rc=$?\n' +
    'if [ $rc -ne 0 ]; then exit $rc; fi\n' +
    'if [ -n "$prefix" ]; then\n' +
    '  printf "Remote path must be the repository root (got subdirectory: %s)\\n" "$prefix" >&2\n' +
    '  exit 2\n' +
    'fi\n' +
    'git -C "$1" rev-list --max-parents=0 HEAD 2>/dev/null || true'
  const { stdout, stderr, code, timedOut } = await exec(alias, ['sh', '-c', script, '_', path], {
    timeoutMs: opts.timeoutMs ?? 15000,
  })
  if (timedOut) {
    return { ok: false, reason: 'network', message: 'ssh timed out' }
  }
  if (code === 0) {
    const fingerprint = stdout.trim().split('\n')[0] || undefined
    return { ok: true, fingerprint }
  }
  const { reason, message } = classifySshExit({ exitCode: code, stderr })
  if (
    reason === 'auth-failed' ||
    reason === 'network' ||
    reason === 'dep-missing' ||
    reason === 'bind-unlink'
  ) {
    // ValidateRemoteRepoReason has no 'bind-unlink' variant — coerce to
    // 'network' since the user-facing outcome (cannot use this host) is the
    // same and `message` already carries the specific stderr line.
    const coercedReason = reason === 'bind-unlink' ? 'network' : reason
    return { ok: false, reason: coercedReason, message }
  }
  return {
    ok: false,
    reason: 'not-a-git-repo',
    message: stderr.trim() ? message : 'Path is not a git repository',
  }
}
