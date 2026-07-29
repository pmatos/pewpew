import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { posix } from 'path'
import { dialog } from 'electron'
import { broadcastToAll } from './window-registry'
import {
  exec as execRemote,
  retainHostConnection,
  releaseHostConnection,
  spawnAttach,
} from './host-connection'
import { classifySshExit } from './ssh-exit-parser'
import { captureRemotePaneTexts, type RemoteSessionEntry } from './remote-thumbnail'
import { sanitizeChildEnv } from './appimage-env'
import { buildSandboxArgs } from './agent-sandbox'
import {
  OMP_HOOK_SCRIPT,
  ensureCodexProjectConfigDir,
  ensureRemoteCodexProjectConfigDir,
} from './hook-installer'
import {
  canonicalPath,
  encodeOmpSessionDirName,
  OMP_ENCODE_SHELL_SCRIPT,
} from './agent-state-paths'
import { getSandboxConfig, resolvePath } from './config'
import type { AgentTool, Host } from '../shared/types'

interface SpawnOptions {
  continueSession?: boolean
  tool?: AgentTool
  agentSessionId?: string
  // Absolute path to the agent binary on the target host. Required for remote
  // sessions because non-interactive ssh PATH excludes user-bin dirs like
  // ~/.local/bin; the resolver in host-bootstrap finds the path once and we
  // pass it through here so tmux can exec it directly. Omitted for local
  // sessions where the GUI process inherits a usable PATH.
  agentPath?: string
  // Project root — the read-only boundary the bwrap sandbox draws around the
  // worktree (see agent-sandbox.ts). Omitted skips sandboxing entirely.
  projectPath?: string
  // Remote-only: whether bwrap was confirmed present on the target host by
  // the remote bootstrap probe. Local sessions self-check via
  // isSandboxAvailable() instead, since there's no equivalent signal for a
  // remote host to check here.
  sandboxAvailable?: boolean
  // Remote-only reverse-forwarded hook socket. The sandbox replaces /tmp with
  // a private tmpfs, so this one path must be bound back in or remote agent
  // lifecycle hooks cannot reach pewpew.
  remoteSocketPath?: string
  // Absolute path (on the target host) to the omp hook bridge script passed
  // via `--hook`. Defaults to OMP_HOOK_SCRIPT for local sessions; remote
  // sessions must pass the path returned by bootstrapHost/withPreparedHost
  // since it lives under the remote host's own config dir.
  notifyHookPath?: string
}

export function buildAgentArgs(options?: SpawnOptions): string[] {
  const tool = options?.tool ?? 'claude'
  const cmd = options?.agentPath ?? tool
  if (tool === 'codex') {
    if (options?.continueSession && options?.agentSessionId) {
      return [cmd, 'resume', options.agentSessionId, '--dangerously-bypass-approvals-and-sandbox']
    }
    return [cmd, '--dangerously-bypass-approvals-and-sandbox']
  }
  if (tool === 'omp') {
    const hookPath = options?.notifyHookPath ?? OMP_HOOK_SCRIPT
    const args = [cmd, '--auto-approve', '--hook', hookPath]
    if (options?.continueSession) args.push('--continue')
    return args
  }
  const args = [cmd, '--dangerously-skip-permissions']
  if (options?.continueSession) args.push('--continue')
  return args
}

interface PtyEntry {
  pty: IPty
  tmuxSession: string
  buffer: string
  host?: Host
  released?: boolean
}

const ptys = new Map<string, PtyEntry>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

// Fires when the underlying node-pty exits without going through
// destroyPty/detachPty/destroyRemotePty (those all delete the entry from
// `ptys` *before* killing the pty, so an entry that's still present at
// onExit time means the agent or tmux died on its own — e.g. `claude
// --continue` exiting because no prior conversation exists for the worktree).
// Lets session-manager flip the session back to 'dead' instead of leaving it
// at 'idle' with no backing pty, which the Terminal component renders as a
// permanently empty xterm.
type UnexpectedExitListener = (sessionId: string) => void
let unexpectedExitListener: UnexpectedExitListener | null = null

export function setUnexpectedExitListener(fn: UnexpectedExitListener | null): void {
  unexpectedExitListener = fn
}

function notifyUnexpectedExitIfPresent(sessionId: string): void {
  if (!ptys.has(sessionId)) return
  ptys.delete(sessionId)
  unexpectedExitListener?.(sessionId)
}

function flushBuffers(): void {
  for (const [sessionId, entry] of ptys) {
    if (entry.buffer.length > 0) {
      broadcastToAll('pty:data', { sessionId, data: entry.buffer })
      entry.buffer = ''
    }
  }
}

// Coalesce PTY output into ~16ms (≈60fps) broadcasts. The timer is armed only
// when data is actually buffered, so an idle app with no terminal output stops
// waking the main process 60×/sec — the previous unconditional interval kept
// the CPU package from settling (issue #185).
function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushBuffers()
  }, 16)
}

function appendToBuffer(entry: PtyEntry, data: string): void {
  entry.buffer += data
  scheduleFlush()
}

function commandAvailable(bin: string): boolean {
  try {
    execFileSync('which', [bin], {
      stdio: 'pipe',
      env: sanitizeChildEnv() as NodeJS.ProcessEnv,
    })
    return true
  } catch {
    return false
  }
}

export function isTmuxAvailable(): boolean {
  return commandAvailable('tmux')
}

// `which bwrap` only proves the binary is on PATH — it doesn't prove bwrap
// can actually create the namespaces/mounts it needs. Unprivileged user
// namespaces can be disabled host-wide (sysctl
// kernel.unprivileged_userns_clone=0) or blocked by an LSM/container policy,
// in which case bwrap fails at exec time and a session spawned with the
// sandbox prefix dies immediately instead of falling back to the unsandboxed
// path the missing-binary case already gets. Probe with a real (minimal)
// invocation exercising the same namespace/mount setup as the production
// prefix in agent-sandbox.ts (--ro-bind / /, --dev /dev, --unshare-pid,
// --proc /proc, --tmpfs /tmp) — a strict subset of that argv, so a pass here
// isn't a false positive on a host that can list bwrap on PATH but can't run
// it. `timeout` is load-bearing: this runs synchronously on the Electron main
// process, so a hang (not just a nonzero exit) must not block the UI.
//
// Only the positive result is memoized: caching a negative would wrongly pin
// every future session to unsandboxed if the host's namespace policy changes
// (or bubblewrap gets installed) mid-run — same reasoning as the caching
// discussion tracked in #251 for the simpler presence check this replaces.
let sandboxUsable: boolean | null = null

function probeSandboxUsable(): boolean {
  if (sandboxUsable) return true
  try {
    execFileSync(
      'bwrap',
      [
        '--ro-bind',
        '/',
        '/',
        '--dev',
        '/dev',
        '--unshare-pid',
        '--proc',
        '/proc',
        '--tmpfs',
        '/tmp',
        '--',
        '/bin/true',
      ],
      { stdio: 'pipe', timeout: 3000, env: sanitizeChildEnv() as NodeJS.ProcessEnv }
    )
    sandboxUsable = true
    return true
  } catch {
    return false
  }
}

// Test-only escape hatch: pty-manager.test.ts exercises both the usable and
// unusable case within one process, and the positive-only memoization above
// would otherwise make the first successful probe permanently mask a later
// test simulating an unusable bwrap. Not called from any production path.
export function __resetSandboxProbeCacheForTesting(): void {
  sandboxUsable = null
}

export function isSandboxAvailable(): boolean {
  return probeSandboxUsable()
}

// Under the hardened bwrap args (--ro-bind / /, see agent-sandbox.ts), $HOME
// is read-only by default. Every supported tool persists conversation/session
// state under its own dir there, so without an explicit writable exception
// every sandboxed session would fail on its very first state write.
//
// Narrowed to each tool's own per-worktree subdirectory, not the rest of
// $HOME — opening the whole tool dir would also expose global config like
// ~/.claude/CLAUDE.md and ~/.claude/settings.json, which every future
// session across every project loads, turning one sandboxed write into a
// persistence vector for every session afterward.
//
// claude and omp key their per-worktree directory off an encoded path
// (hasClaudeConversationHistory / hasOmpConversationHistory in
// session-manager.ts); the encoders are imported from agent-state-paths.ts
// rather than reimplemented so a mismatch can't leave the sandbox binding a
// different directory than the one resume-probing checks.
//
// codex has no per-worktree directory convention in this codebase — its
// resume is keyed on `agentSessionId` from the hook payload, not a
// filesystem path — so its writable exception stays the whole ~/.codex dir
// for now; narrowing it would mean guessing at codex's own on-disk layout.
function agentStateDir(
  tool: AgentTool | undefined,
  worktreePath: string,
  homeDir: string = homedir()
): string {
  if (tool === 'omp') {
    return join(homeDir, '.omp', 'agent', 'sessions', encodeOmpSessionDirName(worktreePath))
  }
  if (tool === 'codex') {
    return join(homeDir, '.codex')
  }
  const encoded = canonicalPath(worktreePath).replace(/[^a-zA-Z0-9-]/g, '-')
  return join(homeDir, '.claude', 'projects', encoded)
}

// Resolves the real .git directory for a project root. A standard worktree
// has `<project>/.git` as a directory, but a gitfile root (submodule or
// linked worktree) has `.git` as a *file* (`gitdir: /path/to/real/.git`) —
// bwrap can't bind a file as a directory mount, so buildSandboxArgs needs the
// resolved real dir. `git rev-parse --git-common-dir` follows the gitfile
// pointer and returns the shared dir. Falls back to `<project>/.git` on any
// failure (safe for the standard case, and a gitfile root that fails to
// resolve will have bwrap fail at spawn — caught by createPty's caller
function resolveGitDir(projectPath: string): string {
  try {
    const dir = execFileSync('git', ['-C', projectPath, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (dir) return posix.resolve(projectPath, dir)
  } catch {
    // fall through to default
  }
  return `${projectPath}/.git`
}

// Remote equivalent of resolveGitDir, run over SSH. Falls back the same way.
async function resolveRemoteGitDir(host: Host, projectPath: string): Promise<string> {
  try {
    const result = await execRemote(
      host,
      ['git', '-C', projectPath, 'rev-parse', '--git-common-dir'],
      { timeoutMs: 8000 }
    )
    if (!result.timedOut && result.code === 0) {
      const dir = result.stdout.trim()
      if (dir) return posix.resolve(projectPath, dir)
    }
  } catch {
    // fall through to default
  }
  return `${projectPath}/.git`
}

// Computes the agent's conversation-state directory ON the remote host and
// mkdir's it in the same SSH round trip. This must run on the remote, not via
// the local agentStateDir(): the local helper uses local realpathSync/homedir/
// tmpdir and platform-local path.join, all of which compute the wrong path for
// a remote session (wrong symlinks, wrong $HOME, wrong tmpdir, wrong omp
// encoding). The shell canonicalization here mirrors the remote history probes
// in session-manager.ts exactly so the bind-source and the resume-probe check
// the same directory.
//
// Returns the absolute POSIX path (or undefined on failure — a transient SSH
// error degrades to unsandboxed rather than blocking session creation).
async function resolveRemoteAgentStateDir(
  host: Host,
  tool: AgentTool | undefined,
  worktreePath: string
): Promise<string | undefined> {
  // codex has no per-worktree dir convention — its resume is keyed on
  // agentSessionId, not a filesystem path — so the whole ~/.codex dir is the
  // writable exception (matching the local agentStateDir for codex).
  const script =
    tool === 'codex'
      ? 'd="$HOME/.codex"; mkdir -p "$d" && printf "%s" "$d"'
      : tool === 'omp'
        ? `${OMP_ENCODE_SHELL_SCRIPT}; d="$HOME/.omp/agent/sessions/$enc"; mkdir -p "$d" && printf "%s" "$d"`
        : 'p=$(CDPATH= cd -P -- "$1" 2>/dev/null && pwd -P); [ -n "$p" ] || p="$1"; ' +
          "enc=$(printf '%s' \"$p\" | sed 's/[^a-zA-Z0-9-]/-/g'); " +
          'd="$HOME/.claude/projects/$enc"; mkdir -p "$d" && printf "%s" "$d"'
  try {
    const result = await execRemote(host, ['sh', '-c', script, '_', worktreePath], {
      timeoutMs: 8000,
    })
    if (!result.timedOut && result.code === 0) {
      const dir = result.stdout.trim()
      if (dir.startsWith('/')) return dir
    }
  } catch {
    // fall through — unsandboxed is the safe fallback
  }
  return undefined
}

export function initPtyManager(): void {
  // Flushing is self-arming (see scheduleFlush); nothing to start here.
}

export function stopPtyManager(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

// Resolves sandbox config once and composes the bwrap prefix for a local
// spawn, including the caller-configured extraWritablePaths from config.json
// — extraWritablePaths is local-only (a remote host's ~ can't be resolved
// here), so this helper is not shared with the remote spawn path.
function buildLocalSandboxPrefix(
  sessionId: string,
  projectPath: string | undefined,
  cwd: string,
  tool: AgentTool | undefined
): string[] {
  if (!projectPath) return []
  if (tool === 'codex') ensureCodexProjectConfigDir(projectPath)
  const sandboxConfig = getSandboxConfig()
  const sandboxAvailable = isSandboxAvailable()
  if (sandboxConfig.enabled && !sandboxAvailable) {
    console.warn(
      `Session ${sessionId}: bwrap missing or unable to sandbox (not on PATH, or present but ` +
        'unable to create the required namespaces/mounts), spawning without sandbox containment'
    )
  }
  // This directory doubles as session-manager.ts's resume-history marker
  // (hasClaudeConversationHistory/hasOmpConversationHistory check it via
  // existsSync) — creating it here, before the agent has ever run, is why
  // those checks test directory *contents* rather than mere existence.
  const stateDir = agentStateDir(tool, cwd)
  mkdirSync(stateDir, { recursive: true })
  const gitDir = resolveGitDir(projectPath)
  return buildSandboxArgs(projectPath, cwd, {
    enabled: sandboxConfig.enabled && sandboxAvailable,
    extraWritablePaths: [stateDir, ...sandboxConfig.extraWritablePaths.map(resolvePath)],
    gitDir,
  })
}

// Returns whether this session's agent process is running inside the bwrap
// sandbox — false when projectPath was omitted, sandboxing is disabled in
// config, or bwrap isn't available. Callers persist this on the Session so
// the UI can show an accurate per-session indicator; it reflects reality at
// spawn time only (reattachPty reuses the existing process and doesn't call
// this again, which is correct — reattach doesn't re-wrap anything).
export function createPty(sessionId: string, cwd: string, options?: SpawnOptions): boolean {
  if (!existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`)
  }

  if (!isTmuxAvailable()) {
    dialog.showErrorBox(
      'tmux not found',
      'tmux is required for embedded terminals.\nPlease install tmux and restart pewpew.'
    )
    throw new Error('tmux not found')
  }

  const tmuxSession = `pewpew-${sessionId}`
  const sandboxPrefix = buildLocalSandboxPrefix(sessionId, options?.projectPath, cwd, options?.tool)
  const agentArgs = [...sandboxPrefix, ...buildAgentArgs(options)]

  // Create a detached tmux session that directly runs the agent CLI.
  // Using tmux's shell command avoids issues with interactive shell init (omz, etc.)
  execFileSync(
    'tmux',
    ['new-session', '-d', '-s', tmuxSession, '-c', cwd, '-x', '120', '-y', '30', ...agentArgs],
    { stdio: 'pipe', env: sanitizeChildEnv() as NodeJS.ProcessEnv }
  )

  // Attach to it via node-pty
  const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', tmuxSession], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: sanitizeChildEnv() as Record<string, string>,
  })

  const entry: PtyEntry = {
    pty: ptyProcess,
    tmuxSession,
    buffer: '',
  }

  ptyProcess.onData((data) => {
    appendToBuffer(entry, data)
  })

  ptyProcess.onExit(() => {
    notifyUnexpectedExitIfPresent(sessionId)
  })

  ptys.set(sessionId, entry)
  return sandboxPrefix.length > 0
}

function releaseRemoteEntry(entry: PtyEntry): void {
  if (!entry.host || entry.released) return
  entry.released = true
  void releaseHostConnection(entry.host.hostId)
}

// See createPty's doc comment for what the returned boolean means. Remote
// sessions reopen only paths resolved on that host (agent state and the hook
// socket); user-configured extraWritablePaths remain local-only because a
// remote host's home directory (needed for `~/`) can't be resolved here.
export async function createRemotePty(
  sessionId: string,
  cwd: string,
  host: Host,
  options?: SpawnOptions
): Promise<boolean> {
  const tmuxSession = `pewpew-${sessionId}`
  let sandboxPrefix: string[] = []
  if (options?.projectPath) {
    if (options.tool === 'codex') {
      await ensureRemoteCodexProjectConfigDir(
        (argv, opts) => execRemote(host, argv, opts),
        options.projectPath
      )
    }
    // Remote sandbox wiring mirrors createPty's local path: resolve the real
    // .git dir (gitfile roots) and the agent state dir ON the remote host
    // (computing it locally would use the wrong $HOME, symlinks, and omp
    // encoding). resolveRemoteAgentStateDir also mkdir's the dir in the same
    // SSH round trip so bwrap's bind-source exists before the tmux spawn.
    //
    // Both resolutions must succeed to enable sandboxing: a missing stateDir
    // means the agent's first write hits EROFS under --ro-bind / /, and a
    // missing gitDir means the .git bind points at a file (gitfile root) or
    // wrong path. A transient SSH failure on either degrades to unsandboxed
    // (safe fallback) rather than launching a known-broken bwrap prefix.
    const [gitDir, stateDir] = await Promise.all([
      resolveRemoteGitDir(host, options.projectPath),
      resolveRemoteAgentStateDir(host, options.tool, cwd),
    ])
    const sandboxEnabled = getSandboxConfig().enabled
    const canSandbox = sandboxEnabled && options?.sandboxAvailable === true && !!stateDir
    sandboxPrefix = buildSandboxArgs(options.projectPath, cwd, {
      enabled: canSandbox,
      extraWritablePaths: [
        ...(stateDir ? [stateDir] : []),
        ...(options.remoteSocketPath ? [posix.dirname(options.remoteSocketPath)] : []),
      ],
      gitDir,
    })
    if (sandboxEnabled && options?.sandboxAvailable === true && !stateDir) {
      console.warn(
        `Session ${sessionId}: bwrap is available on host ${host.alias} but the remote ` +
          'agent state directory could not be resolved, spawning without sandbox containment'
      )
    }
  }
  const agentArgs = [...sandboxPrefix, ...buildAgentArgs(options)]

  const create = await execRemote(host, [
    'tmux',
    'new-session',
    '-d',
    '-s',
    tmuxSession,
    '-c',
    cwd,
    '-x',
    '120',
    '-y',
    '30',
    ...agentArgs,
  ])
  if (create.timedOut || create.code !== 0) {
    const detail = create.stderr.trim() || create.stdout.trim() || `exit ${create.code}`
    throw new Error(`Failed to create remote tmux session: ${detail}`)
  }

  const ptyProcess = spawnAttach(host, ['tmux', 'attach-session', '-t', tmuxSession], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    env: sanitizeChildEnv() as Record<string, string>,
  })

  retainHostConnection(host.hostId)

  const entry: PtyEntry = {
    pty: ptyProcess,
    tmuxSession,
    buffer: '',
    host,
  }

  ptyProcess.onData((data) => {
    appendToBuffer(entry, data)
  })

  ptyProcess.onExit(() => {
    releaseRemoteEntry(entry)
    notifyUnexpectedExitIfPresent(sessionId)
  })

  ptys.set(sessionId, entry)
  return sandboxPrefix.length > 0
}

export function writePty(sessionId: string, data: string): void {
  const entry = ptys.get(sessionId)
  if (entry) {
    entry.pty.write(data)
  }
}

export function resizePty(sessionId: string, cols: number, rows: number): void {
  const entry = ptys.get(sessionId)
  if (entry) {
    entry.pty.resize(cols, rows)
  }
}

/** Detach node-pty but keep the tmux session alive (for disconnect/reconnect). */
export function detachPty(sessionId: string): void {
  const entry = ptys.get(sessionId)
  if (!entry) return

  ptys.delete(sessionId)
  releaseRemoteEntry(entry)

  try {
    entry.pty.kill()
  } catch {
    // Pty may already be dead
  }
}

/** Kill both node-pty and the tmux session (full teardown). */
export function destroyPty(sessionId: string): void {
  const entry = ptys.get(sessionId)
  const tmuxSession = entry?.tmuxSession ?? `pewpew-${sessionId}`

  if (entry) {
    ptys.delete(sessionId)
    releaseRemoteEntry(entry)

    try {
      entry.pty.kill()
    } catch {
      // Pty may already be dead from tmux exit
    }
  }

  // Always attempt to kill the tmux session — the pty onExit handler may have
  // already removed the map entry, but the tmux session can still be alive.
  try {
    execFileSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'pipe' })
  } catch {
    // Session may already be dead
  }
}

export async function destroyRemotePty(sessionId: string, host: Host): Promise<void> {
  const entry = ptys.get(sessionId)
  const tmuxSession = entry?.tmuxSession ?? `pewpew-${sessionId}`

  const result = await execRemote(host, ['tmux', 'kill-session', '-t', tmuxSession], {
    timeoutMs: 5000,
  })
  // tmux returns nonzero when the session doesn't exist — that's fine, the
  // remote process is already gone. But SSH-level failures (auth, network,
  // timeout) mean the kill never ran on the remote; surface so killSession
  // doesn't dishonestly flip the UI to 'dead' while the remote Claude lives on.
  // Keep `entry` registered in `ptys` until we know the kill succeeded so
  // input/output stay routable if the caller retries.
  if (result.timedOut) {
    throw new Error(`Remote tmux kill-session timed out on host ${host.alias}`)
  }
  if (result.code !== 0) {
    const { reason, message } = classifySshExit({ exitCode: result.code, stderr: result.stderr })
    if (
      reason === 'auth-failed' ||
      reason === 'network' ||
      reason === 'dep-missing' ||
      reason === 'bind-unlink'
    ) {
      throw new Error(`Remote tmux kill-session failed on host ${host.alias}: ${message}`)
    }
  }

  if (entry) {
    ptys.delete(sessionId)
    try {
      entry.pty.kill()
    } catch {
      // Pty may already be dead from ssh/tmux exit
    }
    releaseRemoteEntry(entry)
  }
}

export function getPtyIds(): string[] {
  return Array.from(ptys.keys())
}

export function hasPty(sessionId: string): boolean {
  return ptys.has(sessionId)
}

export function hasTmuxSession(sessionId: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', `pewpew-${sessionId}`], {
      timeout: 3000,
      stdio: 'pipe',
    })
    return true
  } catch {
    return false
  }
}

export async function captureThumbnails(opts?: {
  // Fired per session as soon as its capture lands. For remote sessions this
  // happens inside the per-entry async path of `captureRemotePaneTexts`, so a
  // healthy session's thumbnail surfaces without waiting for a wedged sibling
  // to hit the per-call timeout.
  onCapture?: (sessionId: string, text: string) => void
}): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const remoteEntries: RemoteSessionEntry[] = []
  for (const [sessionId, entry] of ptys) {
    if (entry.host) {
      remoteEntries.push({ sessionId, host: entry.host, tmuxSession: entry.tmuxSession })
      continue
    }
    try {
      const text = execFileSync('tmux', ['capture-pane', '-t', entry.tmuxSession, '-p'], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: 'pipe',
      })
      result[sessionId] = text
      opts?.onCapture?.(sessionId, text)
    } catch {
      // Session may be dead
    }
  }
  if (remoteEntries.length > 0) {
    // Multiplexed through the per-host ControlMaster: every exec call shares the
    // existing live SSH connection, so this is N tmux invocations but zero new
    // SSH handshakes. Each per-session call is isolated inside the helper so a
    // single dead/unreachable session can't poison the batch or the underlying
    // control connection.
    const remote = await captureRemotePaneTexts(remoteEntries, {
      exec: execRemote,
      onCapture: opts?.onCapture,
    })
    for (const [sessionId, text] of Object.entries(remote)) {
      result[sessionId] = text
    }
  }
  return result
}

export async function hasRemoteTmuxSession(sessionId: string, host: Host): Promise<boolean> {
  const result = await execRemote(host, ['tmux', 'has-session', '-t', `pewpew-${sessionId}`], {
    timeoutMs: 3000,
  })
  return result.code === 0 && !result.timedOut
}

// Discriminated probe: distinguishes "tmux session is absent on the remote"
// from "we couldn't reach the remote to ask". The boolean `hasRemoteTmuxSession`
// collapses both into `false`, which reconnect/batch-probe paths would otherwise
// treat as a dead session and incorrectly downgrade a still-running remote
// terminal.
export type RemoteTmuxProbeResult = 'present' | 'absent' | 'unreachable'

export async function probeRemoteTmuxSession(
  sessionId: string,
  host: Host
): Promise<RemoteTmuxProbeResult> {
  const result = await execRemote(host, ['tmux', 'has-session', '-t', `pewpew-${sessionId}`], {
    timeoutMs: 3000,
  })
  if (result.timedOut) return 'unreachable'
  if (result.code === 0) return 'present'
  const { reason } = classifySshExit({ exitCode: result.code, stderr: result.stderr })
  if (
    reason === 'auth-failed' ||
    reason === 'network' ||
    reason === 'dep-missing' ||
    reason === 'bind-unlink'
  ) {
    return 'unreachable'
  }
  // Non-zero exit with no SSH-level failure marker is tmux's own "can't find
  // session" exit. The remote is reachable; the session is simply gone.
  return 'absent'
}

export async function getScrollback(sessionId: string): Promise<string> {
  const entry = ptys.get(sessionId)
  if (entry?.host) {
    const result = await execRemote(
      entry.host,
      ['tmux', 'capture-pane', '-t', entry.tmuxSession, '-p', '-e', '-S', '-5000'],
      { timeoutMs: 5000 }
    )
    return result.code === 0 && !result.timedOut ? result.stdout : ''
  }

  const tmuxSession = `pewpew-${sessionId}`
  try {
    return execFileSync('tmux', ['capture-pane', '-t', tmuxSession, '-p', '-e', '-S', '-5000'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: 'pipe',
    })
  } catch {
    return ''
  }
}

export function discoverTmuxSessions(): string[] {
  try {
    const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: 'pipe',
    })
    const sessions: string[] = []
    for (const name of output.split('\n')) {
      if (name.startsWith('pewpew-')) {
        sessions.push(name.replace('pewpew-', ''))
      }
    }
    return sessions
  } catch {
    return []
  }
}

export function reattachPty(sessionId: string): void {
  const tmuxSession = `pewpew-${sessionId}`

  // Attach to existing tmux session via node-pty
  const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', tmuxSession], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    env: sanitizeChildEnv() as Record<string, string>,
  })

  const entry: PtyEntry = {
    pty: ptyProcess,
    tmuxSession,
    buffer: '',
  }

  ptyProcess.onData((data) => {
    appendToBuffer(entry, data)
  })

  ptyProcess.onExit(() => {
    notifyUnexpectedExitIfPresent(sessionId)
  })

  ptys.set(sessionId, entry)

  // Replay scrollback history
  try {
    const scrollback = execFileSync(
      'tmux',
      ['capture-pane', '-t', tmuxSession, '-p', '-e', '-S', '-5000'],
      { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }
    )
    if (scrollback) {
      appendToBuffer(entry, scrollback)
    }
  } catch {
    // Scrollback capture may fail — not critical
  }
}

export async function reattachRemotePty(sessionId: string, host: Host): Promise<void> {
  const tmuxSession = `pewpew-${sessionId}`

  const ptyProcess = spawnAttach(host, ['tmux', 'attach-session', '-t', tmuxSession], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    env: sanitizeChildEnv() as Record<string, string>,
  })

  retainHostConnection(host.hostId)

  const entry: PtyEntry = {
    pty: ptyProcess,
    tmuxSession,
    buffer: '',
    host,
  }

  ptyProcess.onData((data) => {
    appendToBuffer(entry, data)
  })

  ptyProcess.onExit(() => {
    releaseRemoteEntry(entry)
    notifyUnexpectedExitIfPresent(sessionId)
  })

  ptys.set(sessionId, entry)

  const scrollback = await getScrollback(sessionId)
  if (scrollback) {
    appendToBuffer(entry, scrollback)
  }
}
