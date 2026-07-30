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
// For codex and omp, the path returned here IS the sandbox's writable
// exception — narrowed to each tool's own per-worktree subdirectory, not the
// rest of $HOME, so a sandboxed write can't reach global config that every
// future session across every project loads.
//
// For claude, the sandbox's writable exception is the whole ~/.claude dir
// (see claudeDir() below and CLAUDE_DIR_WRITE_DENYLIST, which re-closes the
// global-config entries the narrowing above still protects for the other
// tools). This function is still called for claude, but only to locate —
// and mkdir ahead of first run — the per-worktree resume-history marker dir
// that hasClaudeConversationHistory (session-manager.ts) checks; it no
// longer determines what the sandbox binds writable there.
//
// claude and omp key their per-worktree directory off an encoded path; the
// encoders are imported from agent-state-paths.ts rather than reimplemented
// so a mismatch can't leave this marker directory (or, for omp, the sandbox
// binding itself) pointed at a different directory than resume-probing
// checks.
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

// Claude Code itself (not pewpew) keeps adding new per-invocation scratch
// state directly under ~/.claude, each keyed by a name that isn't known
// ahead of spawn: `session-env/<uuid>/` at SessionStart, and — discovered via
// `ENOENT: ... lstat '~/.claude/tasks/session-<id>/.lock'` on `/implement` —
// `tasks/<session-id>/` for the Task tools' lockfile. Enumerating each one
// individually (as an earlier version of this file did for session-env
// alone) means every future addition is a fresh crash report before it gets
// added here. Instead, the whole ~/.claude directory is the writable
// exception for the claude tool, and CLAUDE_DIR_WRITE_DENYLIST below
// re-closes the specific entries that would turn a compromised sandboxed
// session into a persistence vector for every later session (sandboxed or
// not) that loads them.
//
// Deliberately NOT extended to ~/.claude.json (sibling of this dir, not a
// child — mixes benign per-project bookkeeping with global MCP server
// config, so opening it would let a sandboxed write plant a global MCP
// server entry that auto-runs in every future session). Left read-only and
// untested-as-broken: this very repo's own Claude Code sessions run with it
// read-only for their whole lifetime with no observed failure. Revisit only
// if a future error names it specifically, the way the tasks ENOENT did for
// this directory.
function claudeDir(homeDir: string = homedir()): string {
  return join(homeDir, '.claude')
}

// Entries under ~/.claude that stay read-only even though the directory
// itself is granted writable (see claudeDir above) — each is either an
// execution/instruction surface loaded into every future session or a
// credential, confirmed by inspecting a real ~/.claude, not guessed:
//   settings.json / settings.backup.json   hook + permission config
//   CLAUDE.md                              global memory, loaded every session
//   statusline.sh                          shell script executed every render
//   commands/, output-styles/, skills/     custom prompt/instruction content
//   agents/                                user-level custom subagent
//                                           definitions, loaded the same way
//                                           as commands/skills/ across every
//                                           project — including a `hooks`
//                                           block in their frontmatter, which
//                                           runs without the workspace-trust
//                                           dialog a project-level hook gets
//   plugins/                               third-party hooks/commands/MCP config
//   .credentials.json                      OAuth token
//   backups/                               holds .claude.json.backup.* — same
//                                           footgun as settings.json if a
//                                           backup is ever auto-restored
//   daemon/                                control.key, the background
//                                           claude-daemon's auth secret
//   shell-snapshots/                       Bash tool state snapshots, sourced
//                                           (not just parsed) by later Bash
//                                           calls — a stronger persistence
//                                           vector than most entries above,
//                                           since it runs as shell code
//                                           rather than being read as config.
//                                           Confirmed safe to close: this
//                                           whole multi-hour session ran with
//                                           it read-only under the pre-#261
//                                           narrow allowlist (verified via
//                                           /proc/self/mountinfo — no bind
//                                           for shell-snapshots — and by diff
//                                           against the allowlist this dir
//                                           was never part of), with heavy
//                                           Bash tool use throughout and no
//                                           observed failure — same evidence
//                                           class already accepted below for
//                                           ~/.claude.json.
//
// buildSandboxArgs emits these as --ro-bind-try, which silently SKIPS a
// source that doesn't exist — before this file granted the whole ~/.claude
// dir writable, a missing entry here was simply unreachable, so that skip
// was harmless. Now it isn't: a sandboxed session could *create* an absent
// entry (e.g. a from-scratch settings.json with a malicious hooks block) and
// have it run in every later session. The directory entries below are
// mkdir'd ahead of the bind for exactly this reason (an empty read-only dir
// is harmless either way). The file entries CANNOT be pre-created the same
// way without pewpew writing placeholder content into the user's real global
// config — deliberately not done here; see the callers of this list for the
// residual gap that leaves on a machine where one of them doesn't exist yet.
const CLAUDE_DIR_RO_DIRS = [
  'commands',
  'output-styles',
  'skills',
  'agents',
  'plugins',
  'backups',
  'daemon',
  'shell-snapshots',
]
const CLAUDE_DIR_RO_FILES = [
  'settings.json',
  'settings.backup.json',
  'CLAUDE.md',
  'statusline.sh',
  '.credentials.json',
]
const CLAUDE_DIR_WRITE_DENYLIST = [...CLAUDE_DIR_RO_DIRS, ...CLAUDE_DIR_RO_FILES]

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

// Computes the agent's writable state directories ON the remote host and
// mkdir's them in the same SSH round trip. This must run on the remote, not via
// the local agentStateDir()/claudeDir(): the local helpers use local
// realpathSync/homedir/tmpdir and platform-local path.join, all of which
// compute the wrong path for a remote session (wrong symlinks, wrong $HOME,
// wrong tmpdir, wrong omp encoding). The shell canonicalization here mirrors
// the remote history probes in session-manager.ts exactly so the bind-source
// and the resume-probe check the same directory.
//
interface RemoteAgentState {
  writablePaths: string[]
  // The remote ~/.claude dir, populated only for the claude tool (undefined
  // for codex/omp). Named explicitly rather than read positionally off
  // writablePaths so a future script/parsing change can't silently stop
  // applying CLAUDE_DIR_WRITE_DENYLIST without a type error.
  claudeDir?: string
}

// Returns the writable paths to bind (or undefined on failure — a transient
// SSH error degrades to unsandboxed rather than blocking session creation).
async function resolveRemoteAgentStateDir(
  host: Host,
  tool: AgentTool | undefined,
  worktreePath: string
): Promise<RemoteAgentState | undefined> {
  // codex has no per-worktree dir convention — its resume is keyed on
  // agentSessionId, not a filesystem path — so the whole ~/.codex dir is the
  // writable exception (matching the local agentStateDir for codex).
  //
  // claude additionally needs the whole ~/.claude dir writable — see
  // claudeDir's local counterpart for why (keeps adding new global scratch
  // state under unpredictable names). The second printed line is that whole
  // directory; createRemotePty re-closes CLAUDE_DIR_WRITE_DENYLIST under it
  // as extraReadOnlyPaths, mirroring buildLocalSandboxPrefix — including
  // mkdir'ing the directory-type denylist entries here so their --ro-bind-try
  // can't silently skip an absent one (see CLAUDE_DIR_RO_DIRS' comment).
  // The essential mkdirs ($d, $c) are `&&`-gated ahead of the denylist
  // pre-creates deliberately: a failure there means sandboxing genuinely
  // can't proceed (no writable exception to bind), so falling back to
  // unsandboxed is correct. The denylist directory names, by contrast, are
  // each mkdir'd individually inside their own loop with stderr suppressed
  // and no `&&` between iterations — one name already occupied by a stray
  // file or dangling symlink must not take the whole remote sandbox down
  // (as a single `mkdir -p a b c && ...` chain would: GNU mkdir -p keeps
  // going past a failing operand but still exits non-zero overall, which
  // used to make the trailing `&& printf` never run, returning undefined
  // here and disabling bwrap entirely for the session). Mirrors the local
  // path's per-entry try/catch in buildLocalSandboxPrefix.
  const claudeRoDirsNames = CLAUDE_DIR_RO_DIRS.join(' ')
  const script =
    tool === 'codex'
      ? 'd="$HOME/.codex"; mkdir -p "$d" && printf "%s" "$d"'
      : tool === 'omp'
        ? `${OMP_ENCODE_SHELL_SCRIPT}; d="$HOME/.omp/agent/sessions/$enc"; mkdir -p "$d" && printf "%s" "$d"`
        : 'p=$(CDPATH= cd -P -- "$1" 2>/dev/null && pwd -P); [ -n "$p" ] || p="$1"; ' +
          "enc=$(printf '%s' \"$p\" | sed 's/[^a-zA-Z0-9-]/-/g'); " +
          'd="$HOME/.claude/projects/$enc"; c="$HOME/.claude"; ' +
          'mkdir -p "$d" "$c" && { ' +
          `for x in ${claudeRoDirsNames}; do mkdir -p "$c/$x" 2>/dev/null; done; ` +
          'printf "%s\\n%s" "$d" "$c"; }'
  try {
    const result = await execRemote(host, ['sh', '-c', script, '_', worktreePath], {
      timeoutMs: 8000,
    })
    if (!result.timedOut && result.code === 0) {
      const dirs = result.stdout
        .trim()
        .split('\n')
        .filter((dir) => dir.startsWith('/'))
      if (dirs.length > 0) {
        const isClaudeTool = tool !== 'codex' && tool !== 'omp'
        return { writablePaths: dirs, claudeDir: isClaudeTool ? dirs[1] : undefined }
      }
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
  // those checks test directory *contents* rather than mere existence. Kept
  // even for claude below (whose sandbox exception is the whole ~/.claude
  // dir, which already covers this subdirectory) purely for that marker.
  const stateDir = agentStateDir(tool, cwd)
  mkdirSync(stateDir, { recursive: true })
  const userWritablePaths = sandboxConfig.extraWritablePaths.map(resolvePath)
  const extraWritablePaths: string[] = []
  const extraReadOnlyPaths: string[] = []
  if (tool === 'codex' || tool === 'omp') {
    extraWritablePaths.push(stateDir, ...userWritablePaths)
  } else {
    const claudeDirPath = claudeDir()
    extraWritablePaths.push(claudeDirPath, ...userWritablePaths)
    if (sandboxConfig.enabled && sandboxAvailable) {
      // mkdir the directory-type denylist entries so --ro-bind-try below can
      // never silently skip one for being absent (see CLAUDE_DIR_RO_DIRS'
      // comment) — an empty read-only dir is a harmless outcome either way.
      // Gated on the sandbox actually being used: buildSandboxArgs ignores
      // extraWritablePaths/extraReadOnlyPaths entirely when disabled (it
      // returns [] up front), so these are real writes against the user's
      // global ~/.claude with no payoff on a host that isn't sandboxing this
      // session — and if one of these names is ever occupied by something
      // other than a directory (a stray file, a dangling symlink from a
      // dotfiles manager), a pointless one too. Each mkdir is isolated in
      // its own try/catch so one bad entry can't throw out of createPty and
      // abort a whole batch (e.g. session-manager.ts's relocateProject loop,
      // which has no per-iteration try/catch) — that entry just falls back
      // to the --ro-bind-try fail-open-on-absent gap already documented
      // above, rather than crashing the spawn.
      for (const name of CLAUDE_DIR_RO_DIRS) {
        try {
          mkdirSync(join(claudeDirPath, name), { recursive: true })
        } catch (err) {
          console.warn(
            `Session ${sessionId}: could not prepare ~/.claude/${name} as a read-only sandbox ` +
              `entry (${err instanceof Error ? err.message : String(err)}); leaving it to ` +
              "--ro-bind-try's existing fail-open-on-absent behavior"
          )
        }
      }
    }
    extraReadOnlyPaths.push(...CLAUDE_DIR_WRITE_DENYLIST.map((name) => join(claudeDirPath, name)))
  }
  const gitDir = resolveGitDir(projectPath)
  return buildSandboxArgs(projectPath, cwd, {
    enabled: sandboxConfig.enabled && sandboxAvailable,
    extraWritablePaths,
    extraReadOnlyPaths,
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
    // .git dir (gitfile roots) and the agent state dir(s) ON the remote host
    // (computing it locally would use the wrong $HOME, symlinks, and omp
    // encoding). resolveRemoteAgentStateDir also mkdir's the dir(s) in the same
    // SSH round trip so bwrap's bind-source exists before the tmux spawn.
    //
    // Both resolutions must succeed to enable sandboxing: a missing
    // remoteState means the agent's first write hits EROFS under --ro-bind /
    // /, and a missing gitDir means the .git bind points at a file (gitfile
    // root) or wrong path. A transient SSH failure on either degrades to
    // unsandboxed (safe fallback) rather than launching a known-broken bwrap
    // prefix.
    //
    // resolveRemoteAgentStateDir is skipped outright (not just its result
    // discarded) when the sandbox won't be used on this host: it's an SSH
    // round trip that mkdir's real directories under the user's remote
    // ~/.claude, with no payoff — buildSandboxArgs ignores its result
    // entirely when `enabled` is false below — mirroring the local path's
    // equivalent gate in buildLocalSandboxPrefix.
    const sandboxEnabled = getSandboxConfig().enabled
    const canSandboxHost = sandboxEnabled && options?.sandboxAvailable === true
    const [gitDir, remoteState] = await Promise.all([
      resolveRemoteGitDir(host, options.projectPath),
      canSandboxHost
        ? resolveRemoteAgentStateDir(host, options.tool, cwd)
        : Promise.resolve(undefined),
    ])
    const canSandbox = canSandboxHost && !!remoteState
    const remoteClaudeDir = remoteState?.claudeDir
    sandboxPrefix = buildSandboxArgs(options.projectPath, cwd, {
      enabled: canSandbox,
      extraWritablePaths: remoteState?.writablePaths ?? [],
      extraReadOnlyPaths: [
        ...(options.remoteSocketPath ? [posix.dirname(options.remoteSocketPath)] : []),
        ...(remoteClaudeDir
          ? CLAUDE_DIR_WRITE_DENYLIST.map((name) => posix.join(remoteClaudeDir, name))
          : []),
      ],
      gitDir,
    })
    if (sandboxEnabled && options?.sandboxAvailable === true && !remoteState) {
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
