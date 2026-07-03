import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'fs'
import { join, basename, sep } from 'path'
import { posix } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { dialog, shell } from 'electron'
import { broadcastToAll, getMainWindow } from './window-registry'
import { CONFIG_DIR, getConfig, getReconnectConfig, saveConfig } from './config'
import { updateTray } from './tray'
import { notifyNeedsInput, emitToast } from './notifications'
import { createReconnectScheduler, type AttemptOutcome } from './reconnect-scheduler'
import {
  createPty,
  detachPty,
  destroyPty,
  destroyRemotePty,
  hasPty,
  hasTmuxSession,
  hasRemoteTmuxSession,
  isTmuxAvailable,
  discoverTmuxSessions,
  probeRemoteTmuxSession,
  reattachPty,
  reattachRemotePty,
  createRemotePty,
  setUnexpectedExitListener,
} from './pty-manager'
import { getRepoFingerprint, gitWorktrees, parseWorktreeList } from './project-scanner'
import {
  installHooks,
  installRemoteHooks,
  installCodexHooks,
  installRemoteCodexHooks,
  ensureCodexHooksFeatureFlag,
  ensureRemoteCodexHooksFeatureFlag,
  rollbackCodexHooks,
  rollbackRemoteCodexHooks,
  commitRemoteCodexHooks,
} from './hook-installer'
import { getHost } from './host-registry'
import { listRemoteProjects } from './remote-project-registry'
import { classifySshExit } from './ssh-exit-parser'
import { applyHookEvent, type SideEffectIntent } from './session-state-machine'
import { exec as execRemote, runtimeStateFor, type HostConnectionState } from './host-connection'
import { remoteHostRuntime, type PreparedRemoteHostLease } from './remote-host-runtime'
import {
  createPrLookup,
  describeGhError,
  describePrLookupFailure,
  forkFieldsFromPr,
  ghApiOpenItemsArgs,
  parseLabelLines,
  parseNumberedGhLines,
  parseOwnerFromRemoteUrl,
  PR_VIEW_FIELDS,
  type NumberedGhItem,
  type PrViewInfo,
} from './github'
import type {
  AgentTool,
  CreateSessionOptions,
  Host,
  OpenSessionsSummary,
  RemoteProject,
  Session,
  SessionStatus,
  Worktree,
  WorktreeBase,
} from '../shared/types'

const execFileAsync = promisify(execFile)
const SESSIONS_PATH = join(CONFIG_DIR, 'sessions.json')

// Matches "issue37", "issue-37", "issue_37", "issue/37", "issue#37", "issue 37"
// anywhere in a string. Case-insensitive. Captures the number.
const ISSUE_REGEX = /issue[-_/#\s]?(\d+)/i

function parseIssueNumber(...sources: (string | undefined)[]): number | undefined {
  for (const src of sources) {
    if (!src) continue
    const m = src.match(ISSUE_REGEX)
    if (m) return parseInt(m[1], 10)
  }
  return undefined
}

// Project names come from arbitrary directory basenames (or a user-supplied
// remote-project label), so they can contain characters that are illegal in a
// git ref component (space, `:`, `~`, `^`, `?`, `*`, `[`, `\`, control chars,
// `..`, leading `-`/`.`, etc.). Coerce to a safe slug; fall back to
// `pewpew` when nothing valid remains.
export function sanitizeBranchPrefix(name: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .replace(/(?:\.lock)+$/i, '')
    .replace(/^[-._]+|[-._]+$/g, '')
  return slug || 'pewpew'
}

// Read the actual branch checked out in a worktree. Falls back to the
// conventional `<project>/<worktree>` name if the worktree is missing or git fails.
function resolveBranchFromWorktree(
  worktreePath: string,
  worktreeName: string,
  projectName: string
): string {
  if (existsSync(worktreePath)) {
    try {
      const out = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf-8',
      }).trim()
      if (out && out !== 'HEAD') return out
    } catch {
      // fall through to default
    }
  }
  return `${sanitizeBranchPrefix(projectName)}/${worktreeName}`
}

type GitRunner = (argv: string[]) => Promise<{ stdout: string }>

function remoteTrackingRef(ref: string): string | undefined {
  const trimmed = ref.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('refs/remotes/origin/')) return trimmed
  if (trimmed.startsWith('origin/')) return `refs/remotes/${trimmed}`
  return undefined
}

function parseOriginHeadSymref(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const match = line.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/)
    if (match) return `refs/remotes/origin/${match[1]}`
  }
  return undefined
}

export async function resolveOriginDefaultBase(run: GitRunner): Promise<string> {
  try {
    await run(['remote', 'get-url', 'origin'])
  } catch {
    throw new Error('no-origin-remote')
  }

  try {
    await run(['fetch', 'origin', '--quiet'])
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to fetch origin: ${detail}`, { cause: err })
  }

  const candidates: string[] = []
  const seen = new Set<string>()
  const addCandidate = (ref: string | undefined): void => {
    if (!ref || seen.has(ref)) return
    seen.add(ref)
    candidates.push(ref)
  }

  try {
    const { stdout } = await run(['ls-remote', '--symref', 'origin', 'HEAD'])
    addCandidate(parseOriginHeadSymref(stdout))
  } catch {
    // fall through to local origin/HEAD
  }

  try {
    const { stdout } = await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    addCandidate(remoteTrackingRef(stdout))
  } catch {
    // fall through to conventional branch names
  }

  for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/master']) {
    addCandidate(ref)
  }

  async function firstExistingCandidate(index: number): Promise<string> {
    const ref = candidates[index]
    if (!ref) throw new Error('no-origin-default-branch')
    try {
      await run(['rev-parse', '--verify', ref])
      return ref
    } catch {
      return firstExistingCandidate(index + 1)
    }
  }

  return firstExistingCandidate(0)
}

// Extract the owner segment from a GitHub `origin` remote URL. Used to
// disambiguate `gh pr list --head <branch>` results when a fork has opened a
// PR whose head branch name collides with a local branch.
function getOriginOwner(projectPath: string): string | undefined {
  try {
    const url = execFileSync('git', ['-C', projectPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()
    return parseOwnerFromRemoteUrl(url)
  } catch {
    return undefined
  }
}

interface SessionEntry {
  session: Session
}

const sessions = new Map<string, SessionEntry>()

function getRemoteProject(hostId: string, projectPath: string): RemoteProject {
  const project = listRemoteProjects().find((p) => p.hostId === hostId && p.path === projectPath)
  if (!project) throw new Error('Remote project is not registered')
  return project
}

function getRequiredHost(hostId: string): Host {
  const host = getHost(hostId)
  if (!host) throw new Error('Unknown host')
  return host
}

async function expectRemoteOk(host: Host, argv: string[], message: string): Promise<string> {
  const result = await execRemote(host, argv)
  if (result.timedOut || result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    throw new Error(`${message}: ${detail}`)
  }
  return result.stdout
}

// Lists the worktrees of a remote project over SSH. Remote paths are always
// POSIX, so names are derived with posix.basename regardless of the host OS the
// app runs on. Throws (via expectRemoteOk) on a non-zero/timed-out git command
// so callers can surface the failure instead of silently showing no worktrees.
export async function gitRemoteWorktrees(host: Host, projectPath: string): Promise<Worktree[]> {
  const stdout = await expectRemoteOk(
    host,
    ['git', '-C', projectPath, 'worktree', 'list', '--porcelain'],
    'Failed to list remote worktrees'
  )
  return parseWorktreeList(stdout, posix.basename)
}

function effectiveWorktreeBase(options: CreateSessionOptions): WorktreeBase {
  return options.baseRef ?? getConfig().worktreeBase
}

async function branchExists(projectPath: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['-C', projectPath, 'rev-parse', '--verify', `refs/heads/${branchName}`],
      { timeout: 5000 }
    )
    return true
  } catch {
    return false
  }
}

async function remoteBranchExists(
  host: Host,
  projectPath: string,
  branchName: string
): Promise<boolean> {
  try {
    await expectRemoteOk(
      host,
      ['git', '-C', projectPath, 'rev-parse', '--verify', `refs/heads/${branchName}`],
      'git failed'
    )
    return true
  } catch {
    return false
  }
}

// Resolve a branch to its open PR number via `gh`, with origin-owner
// disambiguation and a TTL cache. The gateway itself lives in ./github; here we
// wire it to the real `gh` binary and wall clock.
const prLookup = createPrLookup({
  runGh: async (args, cwd) => {
    const { stdout } = await execFileAsync('gh', args, { cwd })
    return { stdout: String(stdout) }
  },
  resolveOwner: getOriginOwner,
  now: () => Date.now(),
})

function resolvePrNumberAsync(sessionId: string): void {
  const entry = sessions.get(sessionId)
  if (!entry || entry.session.prNumber !== undefined) return
  if (entry.session.hostId) return
  const { projectPath, branch } = entry.session
  if (!branch) return
  prLookup.lookup(projectPath, branch).then((num) => {
    if (num === undefined) return
    const current = sessions.get(sessionId)
    if (!current || current.session.prNumber !== undefined) return
    current.session.prNumber = num
    onSessionsChanged()
  })
}

function persistSessions(): void {
  const data = Array.from(sessions.values()).map((e) => e.session)
  writeFileSync(SESSIONS_PATH, JSON.stringify(data, null, 2))
}

function notifyRenderer(): void {
  const data = Array.from(sessions.values()).map((e) => e.session)
  broadcastToAll('sessions:updated', data)
}

function onSessionsChanged(): void {
  persistSessions()
  notifyRenderer()
  updateTray(getSessions())
}

function updateSession(id: string, status: SessionStatus): void {
  const entry = sessions.get(id)
  if (!entry) return
  entry.session.status = status
  entry.session.lastActivity = Date.now()
  onSessionsChanged()
}

// Rate-limit `lastKnownState` writes per session to once every 10s so the
// 3s thumbnail tick doesn't churn `sessions.json` on disk.
const LAST_KNOWN_STATE_MIN_INTERVAL_MS = 10_000
const LAST_KNOWN_STATE_MAX_BYTES = 3 * 1024
const lastKnownStateWrites = new Map<string, number>()

// Mutate a single session's `lastKnownState` in memory, respecting the 10s
// per-session rate limit and 3 KiB cap. Returns `true` when the entry was
// actually mutated so the caller can decide whether to flush; callers that
// update many sessions in one tick should prefer `updateLastKnownStatesBatch`
// to collapse the disk write + broadcast into one call (avoids an O(N) write
// storm from a tight timer loop).
function applyLastKnownState(id: string, text: string, now: number): boolean {
  const entry = sessions.get(id)
  if (!entry) return false
  const last = lastKnownStateWrites.get(id) ?? 0
  if (now - last < LAST_KNOWN_STATE_MIN_INTERVAL_MS) return false
  const trimmed =
    text.length > LAST_KNOWN_STATE_MAX_BYTES ? text.slice(-LAST_KNOWN_STATE_MAX_BYTES) : text
  // Idle sessions emit identical thumbnail text every tick; without this
  // no-op the 10s window would still trigger a sessions.json write +
  // broadcast for every live session indefinitely.
  if (entry.session.lastKnownState?.text === trimmed) return false
  entry.session.lastKnownState = { text: trimmed, timestamp: now }
  lastKnownStateWrites.set(id, now)
  return true
}

export function updateLastKnownState(id: string, text: string): void {
  const now = Date.now()
  if (applyLastKnownState(id, text, now)) {
    onSessionsChanged()
  }
}

// Batch variant for the periodic thumbnail tick: collects all (id, text)
// pairs for one tick and emits a single persist + broadcast when at least
// one session was updated. Prevents an O(N) burst of JSON writes when many
// session snapshots unlock the 10s window simultaneously.
export function updateLastKnownStatesBatch(
  updates: ReadonlyArray<{ id: string; text: string }>
): void {
  const now = Date.now()
  let any = false
  for (const { id, text } of updates) {
    if (applyLastKnownState(id, text, now)) any = true
  }
  if (any) onSessionsChanged()
}

// Re-probe PR numbers for sessions that don't have one yet, so a PR opened
// after session creation shows up without an app restart.
const PR_REFRESH_INTERVAL_MS = 5 * 60 * 1000

export function initSessionManager(): void {
  setInterval(() => {
    for (const entry of sessions.values()) {
      if (entry.session.prNumber === undefined) resolvePrNumberAsync(entry.session.id)
    }
  }, PR_REFRESH_INTERVAL_MS).unref()

  // When a pty dies on its own we react by kind:
  //  - Local (`claude --continue` exits, tmux collapses): flip to 'dead' so the
  //    renderer shows the "Restart terminal" overlay instead of an empty xterm.
  //  - Remote (an SSH drop kills the local pty, but the remote tmux likely
  //    survives): auto-reconnect if enabled — mark 'connecting' and schedule a
  //    backoff-driven reattach. If disabled, mark 'offline' so the manual
  //    "Reconnect" overlay surfaces rather than a frozen terminal.
  setUnexpectedExitListener((sessionId) => {
    const entry = sessions.get(sessionId)
    if (!entry) return
    if (entry.session.status === 'dead') return

    if (!entry.session.hostId) {
      updateSession(sessionId, 'dead')
      return
    }

    // A normally-ended remote session (agent exited → session.end hook →
    // promptCleanup) must not be auto-reconnected: its remote tmux is gone, so a
    // probe would flip it to 'dead' with a misleading "remote session ended"
    // toast and could clobber a user-chosen 'completed'. Terminal statuses and
    // an in-flight cleanup both mark a genuine end — a network drop delivers no
    // session.end hook, so it never trips these.
    if (entry.session.status === 'completed' || entry.session.status === 'error') return
    if (cleanupInProgress.has(sessionId)) return

    const host = getHost(entry.session.hostId)
    const label = host?.label || host?.alias || entry.session.hostId
    if (getReconnectConfig().enabled) {
      emitToast({ severity: 'warning', title: `Connection to ${label} lost — reconnecting…` })
      entry.session.connectionState = 'connecting'
      onSessionsChanged()
      reconnectScheduler.schedule(sessionId)
    } else {
      entry.session.connectionState = 'offline'
      onSessionsChanged()
    }
  })
}

async function deriveLabel(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 5000 }
    )
    const branch = stdout.trim()
    if (branch && branch !== 'HEAD') return branch
  } catch {
    // fall through to basename
  }
  return basename(worktreePath)
}

function canonicalPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

async function isGitWorktree(worktreePath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) return false
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'rev-parse', '--is-inside-work-tree'],
      { timeout: 5000 }
    )
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

// In-flight adoption promises keyed by canonical worktree path. Serializes
// concurrent mirror requests for the same path (e.g. double-click on + Mirror,
// racing against mirrorAllWorktrees) so only one session/PTY is created.
// Tracks the tool the in-flight adoption is using so a concurrent call with a
// different tool gets a mixed-tool error rather than silently sharing the
// wrong agent's session.
interface InflightAdoption {
  promise: Promise<Session>
  tool: AgentTool
}
const inflightAdoptions = new Map<string, InflightAdoption>()

export async function createSessionForWorktree(
  projectPath: string,
  worktreePath: string,
  label?: string,
  tool?: AgentTool
): Promise<Session> {
  const effectiveTool: AgentTool = tool ?? getConfig().defaultTool
  const target = canonicalPath(worktreePath)
  for (const e of sessions.values()) {
    if (canonicalPath(e.session.worktreePath) === target) {
      if (e.session.tool !== effectiveTool) {
        throw new Error(
          `Worktree already has a ${e.session.tool} session; mixed tools per worktree are not supported`
        )
      }
      return e.session
    }
  }

  const inflight = inflightAdoptions.get(target)
  if (inflight) {
    if (inflight.tool !== effectiveTool) {
      throw new Error(
        `Worktree already has a ${inflight.tool} session in-flight; mixed tools per worktree are not supported`
      )
    }
    return inflight.promise
  }

  const promise = adoptWorktree(projectPath, worktreePath, label, effectiveTool)
  inflightAdoptions.set(target, { promise, tool: effectiveTool })
  try {
    return await promise
  } finally {
    inflightAdoptions.delete(target)
  }
}

async function installAgentHooks(tool: AgentTool, worktreePath: string): Promise<void> {
  if (tool === 'codex') {
    const snapshot = await installCodexHooks(worktreePath, { skipGitignore: true })
    try {
      ensureCodexHooksFeatureFlag()
    } catch (err) {
      rollbackCodexHooks(snapshot)
      throw err
    }
    return
  }
  await installHooks(worktreePath, { skipGitignore: true })
}

async function adoptWorktree(
  projectPath: string,
  worktreePath: string,
  label: string | undefined,
  tool: AgentTool
): Promise<Session> {
  if (!(await isGitWorktree(worktreePath))) {
    throw new Error(`${worktreePath} is not a valid git worktree`)
  }

  // Store the canonical path so renderer raw-equality matches against
  // git's canonical porcelain output (the same normalization used for dedupe).
  const canonical = canonicalPath(worktreePath)
  const id = randomUUID().slice(0, 8)
  const projectName = basename(projectPath)
  const worktreeName = label || (await deriveLabel(worktreePath))
  const tmuxSession = `pewpew-${id}`
  const branch = resolveBranchFromWorktree(worktreePath, worktreeName, projectName)

  await installAgentHooks(tool, worktreePath)
  createPty(id, worktreePath, { tool })

  const session: Session = {
    id,
    hostId: null,
    projectPath,
    projectName,
    worktreeName,
    worktreePath: canonical,
    branch,
    issueNumber: parseIssueNumber(worktreeName, branch),
    pid: 0,
    tmuxSession,
    status: 'running',
    lastActivity: Date.now(),
    hookEvents: [],
    tool,
  }

  sessions.set(id, { session })

  getRepoFingerprint(projectPath).then((fp) => {
    if (fp) {
      session.repoFingerprint = fp
      onSessionsChanged()
    }
  })

  resolvePrNumberAsync(id)

  onSessionsChanged()

  return session
}

export interface MirrorAllResult {
  mirrored: Session[]
  failed: { path: string; error: string }[]
}

// Adopts each target worktree, partitioning fulfilled/rejected outcomes into the
// mirrored/failed buckets a MirrorAllResult reports. Runs concurrently unless
// `serialize` is set, in which case adoptions run one at a time (used for remote
// Codex, where hook installation mutates a shared remote config file).
async function adoptTargets(
  targets: Worktree[],
  adopt: (wt: Worktree) => Promise<Session>,
  serialize = false
): Promise<MirrorAllResult> {
  const settle = async (wt: Worktree): Promise<PromiseSettledResult<Session>> => {
    try {
      return { status: 'fulfilled', value: await adopt(wt) }
    } catch (reason) {
      return { status: 'rejected', reason }
    }
  }

  let results: PromiseSettledResult<Session>[]
  if (serialize) {
    results = []
    for (const wt of targets) results.push(await settle(wt))
  } else {
    results = await Promise.allSettled(targets.map(adopt))
  }

  const mirrored: Session[] = []
  const failed: { path: string; error: string }[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') mirrored.push(r.value)
    else failed.push({ path: targets[i].path, error: String(r.reason) })
  })
  return { mirrored, failed }
}

interface MirrorAllDeps {
  adopt?: (wt: Worktree) => Promise<Session>
}

export async function mirrorAllWorktrees(
  projectPath: string,
  hostId?: string | null,
  deps: MirrorAllDeps = {}
): Promise<MirrorAllResult> {
  if (hostId) return mirrorAllRemoteWorktrees(hostId, projectPath, deps)

  const worktrees = await gitWorktrees(projectPath)
  const existingPaths = new Set<string>()
  for (const e of sessions.values()) existingPaths.add(canonicalPath(e.session.worktreePath))

  const targets = worktrees.filter((wt) => !wt.isMain && !existingPaths.has(canonicalPath(wt.path)))

  const adopt = deps.adopt ?? ((wt: Worktree) => createSessionForWorktree(projectPath, wt.path))
  return adoptTargets(targets, adopt)
}

async function mirrorAllRemoteWorktrees(
  hostId: string,
  projectPath: string,
  deps: MirrorAllDeps = {}
): Promise<MirrorAllResult> {
  const host = getRequiredHost(hostId)
  const worktrees = await gitRemoteWorktrees(host, projectPath)
  const adopted = new Set<string>()
  for (const e of sessions.values()) {
    if (e.session.hostId === hostId) adopted.add(e.session.worktreePath)
  }

  const targets = worktrees.filter((wt) => !wt.isMain && !adopted.has(wt.path))

  // Concurrent remote Codex adoptions race on the shared remote ~/.codex/
  // config.toml (written via temp file + mv during hook install), so serialize
  // them — matching createSessionsForNumbers' remote-Codex batch path.
  const serialize = getConfig().defaultTool === 'codex'
  const adopt =
    deps.adopt ?? ((wt: Worktree) => createRemoteSessionForWorktree(hostId, projectPath, wt.path))
  return adoptTargets(targets, adopt, serialize)
}

async function installRemoteAgentHooks(
  tool: AgentTool,
  host: Host,
  worktreePath: string,
  notifyScriptPath: string
): Promise<void> {
  const remote = (argv: string[], opts?: { timeoutMs?: number }) => execRemote(host, argv, opts)
  if (tool === 'codex') {
    const snapshot = await installRemoteCodexHooks(remote, worktreePath, notifyScriptPath)
    try {
      await ensureRemoteCodexHooksFeatureFlag(remote)
    } catch (err) {
      await rollbackRemoteCodexHooks(remote, snapshot)
      throw err
    }
    await commitRemoteCodexHooks(remote, snapshot)
    return
  }
  await installRemoteHooks(remote, worktreePath, notifyScriptPath)
}

// In-flight adoptions for remote worktrees, keyed by `${hostId} ${worktreePath}`.
// Mirrors `inflightAdoptions` (local) so a double-click or a concurrent
// mirror-all only creates one session/PTY per remote worktree.
const inflightRemoteAdoptions = new Map<string, InflightAdoption>()

// Adopts an EXISTING remote worktree as a pewpew session: it installs hooks and
// attaches a PTY but never runs `git worktree add`. This is the remote analogue
// of createSessionForWorktree/adoptWorktree.
export async function createRemoteSessionForWorktree(
  hostId: string,
  projectPath: string,
  worktreePath: string,
  label?: string,
  tool?: AgentTool
): Promise<Session> {
  const effectiveTool: AgentTool = tool ?? getConfig().defaultTool

  for (const e of sessions.values()) {
    if (e.session.hostId === hostId && e.session.worktreePath === worktreePath) {
      if (e.session.tool !== effectiveTool) {
        throw new Error(
          `Worktree already has a ${e.session.tool} session; mixed tools per worktree are not supported`
        )
      }
      return e.session
    }
  }

  const key = `${hostId} ${worktreePath}`
  const inflight = inflightRemoteAdoptions.get(key)
  if (inflight) {
    if (inflight.tool !== effectiveTool) {
      throw new Error(
        `Worktree already has a ${inflight.tool} session in-flight; mixed tools per worktree are not supported`
      )
    }
    return inflight.promise
  }

  const promise = adoptRemoteWorktree(hostId, projectPath, worktreePath, label, effectiveTool)
  inflightRemoteAdoptions.set(key, { promise, tool: effectiveTool })
  try {
    return await promise
  } finally {
    inflightRemoteAdoptions.delete(key)
  }
}

async function adoptRemoteWorktree(
  hostId: string,
  projectPath: string,
  worktreePath: string,
  label: string | undefined,
  tool: AgentTool
): Promise<Session> {
  const host = getRequiredHost(hostId)
  const remoteProject = getRemoteProject(hostId, projectPath)
  const worktreeName = label || posix.basename(worktreePath)
  const id = randomUUID().slice(0, 8)
  const tmuxSession = `pewpew-${id}`

  const branch = await remoteHostRuntime.withPreparedHost(
    host,
    async ({ notifyScriptPath, agentPaths }) => {
      const agentPath = agentPaths[tool]
      if (!agentPath) {
        throw new Error(`${tool} is not installed on host ${host.label || host.alias}`)
      }

      const isWorktree = (
        await expectRemoteOk(
          host,
          ['git', '-C', worktreePath, 'rev-parse', '--is-inside-work-tree'],
          'Failed to validate remote worktree'
        )
      ).trim()
      if (isWorktree !== 'true') {
        throw new Error(`${worktreePath} is not a valid git worktree`)
      }

      const resolvedBranch =
        (
          await expectRemoteOk(
            host,
            ['git', '-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
            'Failed to resolve remote branch'
          )
        ).trim() || 'HEAD'

      await installRemoteAgentHooks(tool, host, worktreePath, notifyScriptPath)
      await createRemotePty(id, worktreePath, host, { tool, agentPath })
      return resolvedBranch
    }
  )

  const session: Session = {
    id,
    hostId,
    projectPath,
    projectName: remoteProject.name,
    worktreeName,
    worktreePath,
    branch,
    issueNumber: parseIssueNumber(worktreeName, branch),
    pid: 0,
    tmuxSession,
    status: 'running',
    connectionState: 'live',
    lastActivity: Date.now(),
    hookEvents: [],
    tool,
    ...(remoteProject.repoFingerprint ? { repoFingerprint: remoteProject.repoFingerprint } : {}),
  }

  sessions.set(id, { session })
  onSessionsChanged()
  return session
}

async function createRemoteSession(
  hostId: string,
  projectPath: string,
  name?: string,
  options: CreateSessionOptions = {}
): Promise<Session> {
  const effectiveTool: AgentTool = options.tool ?? getConfig().defaultTool
  const host = getRequiredHost(hostId)
  const remoteProject = getRemoteProject(hostId, projectPath)
  const worktreeName = name || `session-${randomUUID().slice(0, 8)}`
  const worktreePath = posix.join(projectPath, '.claude', 'worktrees', worktreeName)

  for (const e of sessions.values()) {
    if (
      e.session.hostId === hostId &&
      e.session.worktreePath === worktreePath &&
      e.session.tool !== effectiveTool
    ) {
      throw new Error(
        `Worktree already has a ${e.session.tool} session; mixed tools per worktree are not supported`
      )
    }
  }

  const id = randomUUID().slice(0, 8)
  const tmuxSession = `pewpew-${id}`
  const branchName = `${sanitizeBranchPrefix(remoteProject.name)}/${worktreeName}`
  const baseRef = effectiveWorktreeBase(options)

  const branch = await remoteHostRuntime.withPreparedHost(
    host,
    async ({ notifyScriptPath, agentPaths }) => {
      const agentPath = agentPaths[effectiveTool]
      if (!agentPath) {
        throw new Error(`${effectiveTool} is not installed on host ${host.label || host.alias}`)
      }

      if (baseRef === 'origin-default') {
        const originRef = await resolveOriginDefaultBase((argv) =>
          expectRemoteOk(host, ['git', '-C', projectPath, ...argv], 'git failed').then(
            (stdout) => ({
              stdout,
            })
          )
        )
        try {
          await expectRemoteOk(
            host,
            [
              'git',
              '-C',
              projectPath,
              'worktree',
              'add',
              worktreePath,
              '--no-track',
              '-b',
              branchName,
              originRef,
            ],
            'Failed to create remote worktree'
          )
        } catch (err) {
          if (!(await remoteBranchExists(host, projectPath, branchName))) throw err
          await expectRemoteOk(
            host,
            ['git', '-C', projectPath, 'worktree', 'add', worktreePath, branchName],
            'Failed to create remote worktree'
          )
        }
      } else {
        const addWithBranch = await execRemote(host, [
          'git',
          '-C',
          projectPath,
          'worktree',
          'add',
          worktreePath,
          '-b',
          branchName,
        ])
        if (addWithBranch.timedOut || addWithBranch.code !== 0) {
          await expectRemoteOk(
            host,
            ['git', '-C', projectPath, 'worktree', 'add', worktreePath],
            'Failed to create remote worktree'
          )
        }
      }

      const resolvedBranch =
        (
          await expectRemoteOk(
            host,
            ['git', '-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
            'Failed to resolve remote branch'
          )
        ).trim() || branchName

      await installRemoteAgentHooks(effectiveTool, host, worktreePath, notifyScriptPath)
      await createRemotePty(id, worktreePath, host, { tool: effectiveTool, agentPath })
      return resolvedBranch
    }
  )

  const session: Session = {
    id,
    hostId,
    projectPath,
    projectName: remoteProject.name,
    worktreeName,
    worktreePath,
    branch,
    issueNumber: parseIssueNumber(worktreeName, branch),
    pid: 0,
    tmuxSession,
    status: 'running',
    connectionState: 'live',
    lastActivity: Date.now(),
    hookEvents: [],
    tool: effectiveTool,
    ...(remoteProject.repoFingerprint ? { repoFingerprint: remoteProject.repoFingerprint } : {}),
  }

  sessions.set(id, { session })
  onSessionsChanged()
  return session
}

// Fields gh returns for a PR. Beyond head branch/state/title we read the
// cross-repository flag and the head repo identity so a fork PR can be both
// checked out (via refs/pull/<n>/head) and marked as such on the session.
async function localBranchExists(runGit: GitRunner, branch: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

async function createRemotePrSession(
  hostId: string,
  projectPath: string,
  prNumber: number,
  options: CreateSessionOptions = {}
): Promise<Session | string> {
  const host = getRequiredHost(hostId)
  const remoteProject = getRemoteProject(hostId, projectPath)

  const worktreeName = `pr-${prNumber}`
  const worktreePath = posix.join(projectPath, '.claude', 'worktrees', worktreeName)

  for (const e of sessions.values()) {
    if (e.session.hostId === hostId && e.session.worktreePath === worktreePath) {
      return e.session
    }
  }

  return remoteHostRuntime.withPreparedHost(host, async ({ notifyScriptPath, agentPaths }) => {
    const ghProbe = await probeRemoteGh(host)
    if (!ghProbe.ok) {
      return ghProbe.error
    }

    let prInfo: PrViewInfo
    const viewResult = await execRemote(host, [
      'sh',
      '-c',
      `cd "$1" && gh pr view "$2" --json ${PR_VIEW_FIELDS}`,
      '_',
      projectPath,
      String(prNumber),
    ])
    if (viewResult.timedOut || viewResult.code !== 0) {
      const detail =
        viewResult.stderr.trim() || viewResult.stdout.trim() || `exit ${viewResult.code}`
      return describePrLookupFailure(prNumber, detail)
    }
    try {
      prInfo = JSON.parse(viewResult.stdout)
    } catch {
      return `Failed to parse PR metadata for #${prNumber}.`
    }

    if (prInfo.state !== 'OPEN') {
      return `PR #${prNumber} is ${prInfo.state.toLowerCase()}, not open.`
    }

    const effectiveTool: AgentTool = options.tool ?? getConfig().defaultTool
    const agentPath = agentPaths[effectiveTool]
    if (!agentPath) {
      return `${effectiveTool} is not installed on host ${host.label || host.alias}.`
    }

    const branch = prInfo.headRefName
    const forkFields = forkFieldsFromPr(prInfo)
    const isFork = forkFields.prIsFork === true
    const id = randomUUID().slice(0, 8)
    const tmuxSession = `pewpew-${id}`

    // A fork PR's head branch name isn't unique across forks, so check it out
    // under a PR-scoped local branch namespaced under `pewpew/` — both to avoid
    // colliding with a different fork that shares the name and so the forced
    // fetch below can't clobber an unrelated user branch named `pr-<n>`. Same-
    // repo PRs keep the real branch name so pushes update the PR via
    // origin/<branch>.
    const localBranch = isFork ? `pewpew/${worktreeName}` : branch

    // Fetch the PR head into the local branch we'll check out. A fork PR head
    // is ONLY authoritative via GitHub's refs/pull/<n>/head: never fetch
    // origin/<branch>, because if the fork's head branch name also exists on
    // the base repo (e.g. a fork whose head branch is `main`) that fetch would
    // succeed and we'd check out the base repo's branch instead of the PR's
    // commits. A same-repo PR head lives on origin/<branch>, so fetch that.
    if (isFork) {
      // Forced refspec (`+`): a removed session can leave the pewpew/ branch
      // behind, and a later PR force-push makes a non-forced fetch reject as
      // non-fast-forward, so remoteBranchExists would see the stale branch and
      // the worktree would check out old commits. The pewpew/ branch is
      // pewpew-owned and must track the current PR head.
      await execRemote(host, [
        'git',
        '-C',
        projectPath,
        'fetch',
        'origin',
        `+pull/${prNumber}/head:${localBranch}`,
      ]).catch(() => undefined)
    } else {
      await execRemote(host, ['git', '-C', projectPath, 'fetch', 'origin', branch]).catch(
        () => undefined
      )
    }

    // Pick the worktree-add form by probing for the local branch first instead
    // of try-then-fallback. The fallback masked real failures (e.g. branch
    // already checked out in a stale worktree) by surfacing the second
    // attempt's misleading "branch already exists" error.
    const branchExistsLocally = await remoteBranchExists(host, projectPath, localBranch)
    if (isFork && !branchExistsLocally) {
      // The pull-ref fetch should have created pr-<n>; if it didn't there's no
      // valid origin fallback for a fork (origin/<branch> isn't the PR head).
      return `Failed to create worktree for branch "${branch}": could not fetch refs/pull/${prNumber}/head`
    }
    const addArgv = branchExistsLocally
      ? ['git', '-C', projectPath, 'worktree', 'add', worktreePath, localBranch]
      : [
          'git',
          '-C',
          projectPath,
          'worktree',
          'add',
          worktreePath,
          '-b',
          localBranch,
          `origin/${branch}`,
        ]
    try {
      await expectRemoteOk(host, addArgv, 'Failed to create remote worktree')
    } catch (err) {
      return `Failed to create worktree for branch "${branch}": ${(err as Error).message}`
    }

    const resolvedBranch =
      (
        await expectRemoteOk(
          host,
          ['git', '-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
          'Failed to resolve remote branch'
        )
      ).trim() || branch

    await installRemoteAgentHooks(effectiveTool, host, worktreePath, notifyScriptPath)
    await createRemotePty(id, worktreePath, host, { tool: effectiveTool, agentPath })

    const session: Session = {
      id,
      hostId,
      projectPath,
      projectName: remoteProject.name,
      worktreeName,
      worktreePath,
      branch: resolvedBranch,
      prNumber,
      ...forkFields,
      issueNumber: parseIssueNumber(worktreeName, resolvedBranch, prInfo.title),
      pid: 0,
      tmuxSession,
      status: 'running',
      connectionState: 'live',
      lastActivity: Date.now(),
      hookEvents: [],
      tool: effectiveTool,
      ...(remoteProject.repoFingerprint ? { repoFingerprint: remoteProject.repoFingerprint } : {}),
    }

    sessions.set(id, { session })
    onSessionsChanged()
    return session
  })
}

export async function createSession(
  projectPath: string,
  name?: string,
  hostId: string | null = null,
  options: CreateSessionOptions = {}
): Promise<Session> {
  if (hostId) return createRemoteSession(hostId, projectPath, name, options)

  const worktreeName = name || `session-${randomUUID().slice(0, 8)}`
  const worktreePath = join(projectPath, '.claude', 'worktrees', worktreeName)
  const branchName = `${sanitizeBranchPrefix(basename(projectPath))}/${worktreeName}`
  const baseRef = effectiveWorktreeBase(options)

  if (baseRef === 'origin-default') {
    const originRef = await resolveOriginDefaultBase(async (argv) => {
      const { stdout } = await execFileAsync('git', ['-C', projectPath, ...argv], {
        timeout: 30000,
      })
      return { stdout: String(stdout) }
    })
    try {
      await execFileAsync('git', [
        '-C',
        projectPath,
        'worktree',
        'add',
        worktreePath,
        '--no-track',
        '-b',
        branchName,
        originRef,
      ])
    } catch (err) {
      if (!(await branchExists(projectPath, branchName))) throw err
      await execFileAsync('git', ['-C', projectPath, 'worktree', 'add', worktreePath, branchName])
    }
  } else {
    try {
      await execFileAsync('git', [
        '-C',
        projectPath,
        'worktree',
        'add',
        worktreePath,
        '-b',
        branchName,
      ])
    } catch {
      // Branch may already exist — try without -b
      await execFileAsync('git', ['-C', projectPath, 'worktree', 'add', worktreePath])
    }
  }

  return createSessionForWorktree(projectPath, worktreePath, worktreeName, options.tool)
}

function realizeIntent(intent: SideEffectIntent): void {
  switch (intent.kind) {
    case 'notifyNeedsInput': {
      const e = sessions.get(intent.sessionId)
      if (e) notifyNeedsInput(e.session)
      return
    }
    case 'promptCleanup':
      // Fire-and-forget, but attach a catch so a remote removeSession failure
      // doesn't become an unhandled rejection in the main process.
      promptCleanup(intent.sessionId).catch((err) => {
        console.error(`promptCleanup(${intent.sessionId}) failed:`, err)
      })
      return
  }
}

export function handleHookEvent(
  method: string,
  params: Record<string, unknown>,
  originHostId: string | null = null
): boolean {
  const currentState = new Map<string, Session>()
  for (const e of sessions.values()) currentState.set(e.session.id, e.session)

  const result = applyHookEvent(currentState, { method, params, originHostId }, Date.now())
  if (!result.matched) return false

  let mutated = false
  for (const [id, nextSession] of result.state) {
    const entry = sessions.get(id)
    if (entry && entry.session !== nextSession) {
      entry.session = nextSession
      mutated = true
    }
  }
  for (const intent of result.intents) realizeIntent(intent)

  if (mutated) onSessionsChanged()
  return true
}

export async function killSession(id: string): Promise<void> {
  const entry = sessions.get(id)
  if (!entry) return
  reconnectScheduler.cancel(id)
  if (entry.session.hostId) {
    const host = getRequiredHost(entry.session.hostId)
    await destroyRemotePty(id, host)
    entry.session.connectionState = 'offline'
    updateSession(id, 'dead')
    return
  }
  detachPty(id)
  // Clear any lazy-restore `pending` flag so the renderer mount effects
  // don't fire attachSession against a dead entry once kill broadcasts.
  entry.session.connectionState = undefined
  updateSession(id, 'dead')
}

interface ReconnectOutcome {
  state: HostConnectionState | undefined
  lease: PreparedRemoteHostLease
}

// In-flight reconnect promises keyed by session id. Two concurrent clicks on
// the same pending card (fast double-click, or a click that races the
// auto-fired batch probe) coalesce into one SSH attempt.
const inflightReconnects = new Map<string, Promise<ReconnectOutcome>>()

// Probe-only reconnect for a remote session. If the remote tmux session is
// present we reattach and mark `live`; if it is gone we mark the session
// `dead` (matches issue #12 AC #4: "either reattach the PTY or marks the
// session dead"). Creating a fresh remote tmux session is `reviveSession`'s
// job — that requires explicit user intent ("Restart terminal" on dead).
//
// On SSH failure we classify via `runtimeStateFor` (set by host-connection's
// `startRuntime` before ensureHostConnection rejects), so auth-failed vs.
// network-unreachable get distinct UI states without re-parsing stderr.
export async function reconnectRemoteSession(id: string): Promise<void> {
  const existing = inflightReconnects.get(id)
  if (existing) {
    await existing
    return
  }

  // Capture hostId BEFORE the await: if `removeSession(id)` runs while this
  // reconnect is in flight, `sessions.get(id)` would return undefined after
  // the await and we'd neither release the host retain nor run the sibling
  // batch — leaking the ControlMaster for the lifetime of the app.
  const initialHostId = sessions.get(id)?.session.hostId ?? null

  const promise = doReconnectRemoteSession(id)
  inflightReconnects.set(id, promise)
  let reconnectError: unknown = undefined
  let outcome: ReconnectOutcome | undefined
  try {
    outcome = await promise
  } catch (err) {
    reconnectError = err
  } finally {
    inflightReconnects.delete(id)
  }
  const successState = outcome?.state
  const leaseForBatch = outcome?.lease
  // Fire-and-forget the sibling batch probe — the caller should not block on
  // it. `probePendingSessionsOnHost` is idempotent so concurrent clicks on
  // multiple cards of the same host still collapse to a single batch.
  //
  // Always attempt the batch probe, even when the clicked reconnect rejected:
  // - on success (runtime was `live`), we reconcile siblings over the
  //   now-live ControlMaster
  // - on auth-failed / unreachable, the batch's short-circuit cascades that
  //   state to every pending sibling without any new SSH I/O (spec AC #8)
  //
  // Skip only when there's no host at all (orphaned hostId / missing registry
  // entry) or we couldn't determine any state — there's nothing to probe.
  const hostId = sessions.get(id)?.session.hostId ?? initialHostId
  const tagged = (reconnectError as { hostConnectionState?: HostConnectionState } | null)
    ?.hostConnectionState
  const stateHint = successState ?? tagged ?? (hostId ? runtimeStateFor(hostId) : undefined)
  if (hostId && stateHint) {
    // Fire-and-forget: user's first click should not wait for sibling
    // reconciliation. The prepared-host lease is released after the batch,
    // keeping the ControlMaster alive while siblings reuse one SSH handshake.
    ;(async () => {
      try {
        await probePendingSessionsOnHost(hostId, stateHint)
      } catch (err) {
        console.error(`probePendingSessionsOnHost(${hostId}) failed:`, err)
      } finally {
        await leaseForBatch?.release()
      }
    })()
  } else {
    await leaseForBatch?.release()
  }
  if (reconnectError !== undefined) throw reconnectError
}

async function doReconnectRemoteSession(id: string): Promise<ReconnectOutcome> {
  const entry = sessions.get(id)
  if (!entry) throw new Error(`Session ${id} not found`)
  const session = entry.session
  if (!session.hostId) {
    throw new Error(`Session ${id} is not a remote session`)
  }
  const hostId = session.hostId
  const host = getHost(hostId)
  if (!host) {
    session.connectionState = 'unreachable'
    onSessionsChanged()
    throw new Error(`Host configuration for "${hostId}" was removed`)
  }
  session.connectionState = 'connecting'
  onSessionsChanged()

  let lease: PreparedRemoteHostLease | null = null
  try {
    lease = await remoteHostRuntime.acquirePreparedHost(host)
    const probe = await probeRemoteTmuxSession(id, host)
    if (probe === 'present') {
      await reattachRemotePty(id, host)
      session.connectionState = 'live'
      if (session.status === 'running') session.status = 'idle'
      session.lastActivity = Date.now()
      onSessionsChanged()
    } else if (probe === 'absent') {
      // Remote confirmed the tmux session is gone — mark dead. The user can
      // invoke "Restart terminal" (reviveSession) to spawn a fresh one.
      session.connectionState = 'offline'
      session.status = 'dead'
      session.lastActivity = Date.now()
      onSessionsChanged()
    } else {
      // SSH-level failure probing an otherwise-live control connection. Treat
      // as unreachable and let the user retry; do NOT mark dead because the
      // remote Claude may still be running.
      session.connectionState = 'unreachable'
      onSessionsChanged()
    }
  } catch (err) {
    // Prefer the state captured by remote-host-runtime (attached to the error
    // before stopHostConnection wipes the runtime entry). Fall back to the
    // live runtime when the failure happened after the host was prepared
    // (e.g. bootstrap / PTY attach step).
    const tagged = (err as { hostConnectionState?: HostConnectionState } | null)
      ?.hostConnectionState
    const runtimeState = tagged ?? runtimeStateFor(hostId)
    if (runtimeState === 'auth-failed') {
      session.connectionState = 'auth-failed'
    } else if (runtimeState === 'unreachable') {
      session.connectionState = 'unreachable'
    } else {
      session.connectionState = 'offline'
    }
    onSessionsChanged()
    await lease?.release()
    throw err
  }
  const finalState = runtimeStateFor(hostId)
  if (!lease) throw new Error(`Session ${id} did not acquire a remote host lease`)
  return { state: finalState, lease }
}

// One auto-reconnect attempt for a remote session that dropped. Delegates to
// the manual reconnect (so we inherit its probe/reattach, concurrency
// coalescing, sibling batch, and auth classification) and maps the resulting
// session state to a scheduler outcome. The scheduler owns the backoff loop.
export async function attemptAutoReconnect(id: string): Promise<AttemptOutcome> {
  const entry = sessions.get(id)
  if (!entry) return 'gave-up'
  const session = entry.session
  if (!session.hostId) return 'gave-up'
  // The session ended normally (completed/error) between scheduling and now —
  // don't probe/reattach, which would flip it to 'dead' with a bogus toast.
  if (session.status === 'completed' || session.status === 'error') return 'gave-up'
  const host = getHost(session.hostId)
  const label = host?.label || host?.alias || session.hostId

  // A manual reconnect (or the user's Retry click) may have already reattached
  // between the drop and this tick. Detect a genuine live attach via the pty —
  // connectionState alone is stale ('live' is never reset on a bare drop).
  if (session.connectionState === 'live' && hasPty(id)) return 'recovered'

  try {
    await reconnectRemoteSession(id)
  } catch {
    // connectionState set inside doReconnectRemoteSession is authoritative.
  }

  const after = sessions.get(id)?.session
  if (!after) return 'gave-up'

  if (after.connectionState === 'live') {
    emitToast({ severity: 'info', title: `Reconnected to ${label}` })
    return 'recovered'
  }
  if (after.status === 'dead') {
    // Remote tmux confirmed gone — retrying is futile.
    emitToast({ severity: 'error', title: `${label}: remote session ended` })
    return 'gave-up'
  }
  if (after.connectionState === 'auth-failed') {
    emitToast({ severity: 'error', title: `SSH authentication failed on ${label}` })
    return 'gave-up'
  }
  return 'retry'
}

const reconnectScheduler = createReconnectScheduler({
  attempt: attemptAutoReconnect,
  config: getReconnectConfig,
})

export function stopSessionManager(): void {
  reconnectScheduler.shutdown()
}

// Eager batch probe for remaining `pending` sessions on a host that just
// became live. Runs `tmux has-session` per sibling over the live ControlMaster
// (no new SSH handshakes). If the runtime state is `auth-failed` /
// `unreachable` we short-circuit: all siblings inherit that state without any
// network I/O, satisfying spec AC #8 "auth failures transition directly to
// host-auth-failed with no further attempts".
const inflightBatchProbes = new Map<string, Promise<void>>()

export async function probePendingSessionsOnHost(
  hostId: string,
  stateHint?: HostConnectionState
): Promise<void> {
  const existing = inflightBatchProbes.get(hostId)
  if (existing) return existing
  const promise = doProbePendingSessionsOnHost(hostId, stateHint)
  inflightBatchProbes.set(hostId, promise)
  try {
    await promise
  } finally {
    inflightBatchProbes.delete(hostId)
  }
}

async function doProbePendingSessionsOnHost(
  hostId: string,
  stateHint?: HostConnectionState
): Promise<void> {
  const host = getHost(hostId)
  if (!host) return
  const reconnectHost = host

  const pending: Session[] = []
  for (const entry of sessions.values()) {
    if (entry.session.hostId === hostId && entry.session.connectionState === 'pending') {
      pending.push(entry.session)
    }
  }
  if (pending.length === 0) return

  // Short-circuit the cascade if the runtime is known-failed. Prefer
  // stateHint: on an ensureHostConnection failure the runtime entry has been
  // deleted by stopHostConnection, so runtimeStateFor would return undefined
  // and we'd fall through to the probe loop — defeating the "no further
  // attempts" contract on auth-failed cascades.
  const runtime = stateHint ?? runtimeStateFor(hostId)
  if (runtime === 'auth-failed' || runtime === 'unreachable') {
    for (const s of pending) s.connectionState = runtime
    onSessionsChanged()
    return
  }

  async function reconnectNext(index: number): Promise<void> {
    const s = pending[index]
    if (!s) return
    // The snapshot was taken once at batch entry; by the time we get here
    // another concurrent reconnect (e.g. user clicking a sibling card) may
    // have already advanced this session out of `pending`. Skip — otherwise
    // we'd duplicate the remote reattach and leak the earlier runtime retain.
    if (s.connectionState !== 'pending') {
      await reconnectNext(index + 1)
      return
    }
    try {
      const probe = await probeRemoteTmuxSession(s.id, reconnectHost)
      if (probe === 'present') {
        await reattachRemotePty(s.id, reconnectHost)
        s.connectionState = 'live'
        if (s.status === 'running') s.status = 'idle'
        s.lastActivity = Date.now()
      } else if (probe === 'absent') {
        s.connectionState = 'offline'
        s.status = 'dead'
        s.lastActivity = Date.now()
      } else {
        // SSH probe failed (timeout / auth / network) — the remote may still be
        // running. Mark unreachable and bail so we don't mis-classify the rest
        // of the batch as dead on a transient failure.
        s.connectionState = 'unreachable'
        return
      }
    } catch (err) {
      // A mid-batch SSH failure means the host dropped. Mark this sibling
      // unreachable and stop — remaining siblings stay `pending` for a
      // later manual reconnect, avoiding a flood of follow-up SSH attempts.
      console.error(`probePendingSessionsOnHost(${hostId}) aborted on ${s.id}:`, err)
      s.connectionState = 'unreachable'
      return
    }
    await reconnectNext(index + 1)
  }

  await reconnectNext(0)
  onSessionsChanged()
}

export async function reviveSession(id: string): Promise<void> {
  const entry = sessions.get(id)
  if (!entry) throw new Error(`Session ${id} not found`)
  reconnectScheduler.cancel(id)

  const session = entry.session
  if (session.status !== 'dead')
    throw new Error(`Session ${id} is not dead (status: ${session.status})`)

  if (session.hostId) {
    const host = getRequiredHost(session.hostId)
    session.connectionState = 'connecting'
    onSessionsChanged()
    try {
      await remoteHostRuntime.withPreparedHost(host, async ({ agentPaths }) => {
        if (await hasRemoteTmuxSession(id, host)) {
          await reattachRemotePty(id, host)
        } else {
          const agentPath = agentPaths[session.tool]
          if (!agentPath) {
            throw new Error(`${session.tool} is not installed on host ${host.label || host.alias}`)
          }
          const canResume = await canResumeRemoteAgent(session, host)
          if (!canResume) {
            console.warn(
              `Session ${id} (${session.tool}) has no prior conversation on host ${host.alias}; spawning fresh instead of resuming`
            )
          }
          await createRemotePty(id, session.worktreePath, host, {
            continueSession: canResume,
            tool: session.tool,
            agentSessionId: session.agentSessionId,
            agentPath,
          })
        }
      })
    } catch (err) {
      session.connectionState = 'offline'
      onSessionsChanged()
      throw err
    }
    session.connectionState = 'live'
    updateSession(id, 'idle')
    return
  }

  // Clear any lazy-restore `pending` flag BEFORE we (re)create the pty —
  // otherwise a concurrent renderer mount effect could see pending+live pty
  // and fire attachLocalSession, whose reattachPty would replace the
  // just-created node-pty and leak the original exit handler.
  session.connectionState = undefined
  if (hasTmuxSession(id)) {
    reattachPty(id)
  } else {
    const canResume = canResumeAgent(session)
    if (!canResume) {
      console.warn(
        `Session ${id} (${session.tool}) has no prior conversation; spawning fresh instead of resuming`
      )
    }
    createPty(id, session.worktreePath, {
      continueSession: canResume,
      tool: session.tool,
      agentSessionId: session.agentSessionId,
    })
  }
  updateSession(id, 'idle')
}

// Decides whether resuming an agent will work. For claude, --continue exits
// non-zero when there's no per-worktree project directory in ~/.claude/projects,
// killing the tmux pane on spawn. For codex, `codex resume <id>` requires the
// captured agentSessionId from the SessionStart hook.
function canResumeAgent(session: Session): boolean {
  if (session.tool === 'codex') return !!session.agentSessionId
  return hasClaudeConversationHistory(session.worktreePath)
}

// Remote analogue of canResumeAgent. The remote branch of reviveSession used to
// hardcode `--continue`, so reviving a remote session with no prior
// conversation (e.g. a freshly mirrored worktree that was never talked to) made
// `claude --continue` print "No conversation found to continue" and collapse
// the pane on spawn. Probe the remote first and spawn fresh when there's
// nothing to resume, matching the local guard.
async function canResumeRemoteAgent(session: Session, host: Host): Promise<boolean> {
  if (session.tool === 'codex') return !!session.agentSessionId
  return hasRemoteClaudeConversationHistory(host, session.worktreePath)
}

// On-demand local attach for sessions deferred during restoreSessions().
// Idempotent: if the pty is already live (or the session is remote/dead),
// it's a no-op. Renderer calls this when the user opens a pending card so
// startup doesn't fan out N concurrent agent processes.
export async function attachLocalSession(id: string): Promise<void> {
  const entry = sessions.get(id)
  if (!entry) return
  const session = entry.session
  if (session.hostId) return
  if (session.connectionState !== 'pending') return

  if (!existsSync(session.worktreePath)) {
    session.connectionState = undefined
    updateSession(id, 'dead')
    return
  }

  try {
    if (hasTmuxSession(id)) {
      reattachPty(id)
    } else {
      const canResume = canResumeAgent(session)
      if (!canResume) {
        console.warn(
          `Session ${id} (${session.tool}) has no prior conversation; spawning fresh instead of resuming`
        )
      }
      createPty(id, session.worktreePath, {
        continueSession: canResume,
        tool: session.tool,
        agentSessionId: session.agentSessionId,
      })
    }
    session.connectionState = undefined
    onSessionsChanged()
  } catch (err) {
    session.connectionState = undefined
    updateSession(id, 'dead')
    throw err
  }
}

export async function attachPendingLocalSessions(ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await attachLocalSession(id)
    } catch (err) {
      console.error(`Failed to attach session ${id}:`, err)
    }
  }
}

export async function removeWorktree(id: string): Promise<void> {
  const entry = sessions.get(id)
  if (!entry) return

  if (entry.session.hostId) {
    const host = getRequiredHost(entry.session.hostId)
    try {
      await execRemote(host, [
        'git',
        '-C',
        entry.session.projectPath,
        'worktree',
        'remove',
        entry.session.worktreePath,
        '--force',
      ])
    } catch {
      // Remote worktree may already be removed or host unavailable.
    }
    return
  }

  try {
    await execFileAsync('git', [
      '-C',
      entry.session.projectPath,
      'worktree',
      'remove',
      entry.session.worktreePath,
      '--force',
    ])
  } catch {
    // Worktree may already be removed or path invalid
  }
}

export async function removeSession(id: string): Promise<void> {
  const entry = sessions.get(id)
  reconnectScheduler.cancel(id)
  if (entry?.session.hostId) {
    const host = getRequiredHost(entry.session.hostId)
    await destroyRemotePty(id, host)
  } else {
    destroyPty(id)
  }
  await removeWorktree(id)
  sessions.delete(id)
  onSessionsChanged()
}

// Local-only forget: detach the PTY wrapper for every session bound to the
// host (releases the host-connection refcount via releaseRemoteEntry without
// talking to the remote tmux), then drop the entries so they vanish from
// sessions.json on the next persist. Worktrees, remote tmux sessions, and the
// remote ~/.config/pewpew/ tree are intentionally left alone — that is the
// v1 host-delete contract (issue #14).
export function removeSessionsForHost(hostId: string): void {
  let removed = false
  for (const [id, entry] of sessions) {
    if (entry.session.hostId !== hostId) continue
    reconnectScheduler.cancel(id)
    detachPty(id)
    sessions.delete(id)
    removed = true
  }
  if (removed) onSessionsChanged()
}

const cleanupInProgress = new Set<string>()

async function promptCleanup(id: string): Promise<void> {
  if (cleanupInProgress.has(id)) return
  cleanupInProgress.add(id)
  // The agent ended normally (this fires from the session.end hook, which only
  // arrives over a live connection). Cancel any auto-reconnect a racing PTY
  // exit scheduled so it can't flip the session to 'dead' mid-cleanup.
  reconnectScheduler.cancel(id)
  try {
    const entry = sessions.get(id)
    if (!entry) return

    const session = entry.session
    const parentWindow = getMainWindow()

    const options = {
      type: 'question' as const,
      title: 'Session ended',
      message: `Session "${session.projectName}/${session.worktreeName}" ended.\nClean up worktree?`,
      buttons: ['Delete worktree', 'Keep worktree', 'Keep and open in file manager'],
      defaultId: 1,
      cancelId: 1,
    }

    const { response } = parentWindow
      ? await dialog.showMessageBox(parentWindow, options)
      : await dialog.showMessageBox(options)

    if (response === 0) {
      await removeSession(id)
    } else if (response === 1) {
      updateSession(id, 'completed')
    } else if (response === 2) {
      updateSession(id, 'completed')
      shell.openPath(session.worktreePath)
    }
  } finally {
    cleanupInProgress.delete(id)
  }
}

export function selectNumbersToOpen<T extends { number: number }>(
  items: T[],
  existing: Set<number>
): { toCreate: T[]; toSkip: number[] } {
  const toCreate: T[] = []
  const toSkip: number[] = []
  const seen = new Set(existing)
  for (const item of items) {
    if (seen.has(item.number)) {
      toSkip.push(item.number)
    } else {
      seen.add(item.number)
      toCreate.push(item)
    }
  }
  return { toCreate, toSkip }
}

type ListNumberedItems = (
  projectPath: string,
  hostId: string | null
) => Promise<NumberedGhItem[] | string>
type CreateNumberedSession = (
  projectPath: string,
  number: number,
  hostId: string | null,
  options?: CreateSessionOptions
) => Promise<Session | string>
type RemoteGhProbe = { ok: true } | { ok: false; error: string }

interface OpenSessionsDeps {
  listPrs?: ListNumberedItems
  listIssues?: ListNumberedItems
  createPrSession?: CreateNumberedSession
  createIssueSession?: CreateNumberedSession
}

interface CreateIssueSessionDeps {
  runGit?: GitRunner
  branchExists?: (projectPath: string, branchName: string) => Promise<boolean>
  createSessionForWorktree?: (
    projectPath: string,
    worktreePath: string,
    label?: string,
    tool?: AgentTool
  ) => Promise<Session>
}

interface CreatePrSessionDeps {
  runGit?: GitRunner
  prView?: (projectPath: string, prNumber: number) => Promise<PrViewInfo>
  createSessionForWorktree?: (
    projectPath: string,
    worktreePath: string,
    label?: string,
    tool?: AgentTool
  ) => Promise<Session>
}

async function listLocalOpenGhItems(
  projectPath: string,
  kind: 'pr' | 'issue',
  label?: string
): Promise<NumberedGhItem[] | string> {
  try {
    const { stdout: repoStdout } = await execFileAsync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      { cwd: projectPath, timeout: 30000 }
    )
    const repo = String(repoStdout).trim()
    const { stdout } = await execFileAsync('gh', ghApiOpenItemsArgs(kind, repo, label), {
      cwd: projectPath,
      timeout: 30000,
    })
    return parseNumberedGhLines(String(stdout), kind === 'pr' ? 'PR' : 'issue')
  } catch (err) {
    return `Failed to list open ${kind === 'pr' ? 'PRs' : 'issues'}: ${describeGhError(err)}`
  }
}

async function listRemoteOpenGhItems(
  projectPath: string,
  hostId: string,
  kind: 'pr' | 'issue',
  label?: string
): Promise<NumberedGhItem[] | string> {
  const host = getRequiredHost(hostId)
  const ghProbe = await probeRemoteGh(host)
  if (!ghProbe.ok) return ghProbe.error

  const labelQuery = kind === 'issue' && label ? `&labels=${encodeURIComponent(label)}` : ''
  try {
    const stdout = await expectRemoteOk(
      host,
      [
        'sh',
        '-c',
        [
          'set -e',
          'cd "$1"',
          'repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)',
          'if [ "$2" = pr ]; then',
          '  gh api --paginate "repos/$repo/pulls?state=open&per_page=100" --jq ".[].number"',
          'else',
          '  gh api --paginate "repos/$repo/issues?state=open&per_page=100$3" --jq ".[] | select(.pull_request | not) | .number"',
          'fi',
        ].join('\n'),
        '_',
        projectPath,
        kind,
        labelQuery,
      ],
      'gh failed'
    )
    return parseNumberedGhLines(stdout, kind === 'pr' ? 'PR' : 'issue')
  } catch (err) {
    return `Failed to list open ${kind === 'pr' ? 'PRs' : 'issues'}: ${describeGhError(err)}`
  }
}

async function listOpenPrs(
  projectPath: string,
  hostId: string | null
): Promise<NumberedGhItem[] | string> {
  return hostId === null
    ? listLocalOpenGhItems(projectPath, 'pr')
    : listRemoteOpenGhItems(projectPath, hostId, 'pr')
}

async function listOpenIssues(
  projectPath: string,
  hostId: string | null,
  label?: string
): Promise<NumberedGhItem[] | string> {
  return hostId === null
    ? listLocalOpenGhItems(projectPath, 'issue', label)
    : listRemoteOpenGhItems(projectPath, hostId, 'issue', label)
}

export async function countOpenIssues(
  projectPath: string,
  hostId: string | null = null,
  label?: string,
  deps: { listIssues?: ListNumberedItems } = {}
): Promise<number | string> {
  const list = deps.listIssues ?? ((p: string, h: string | null) => listOpenIssues(p, h, label))
  try {
    const items = await list(projectPath, hostId)
    if (typeof items === 'string') return items
    return items.length
  } catch (err) {
    return describeGhError(err)
  }
}

export async function listRepoLabels(
  projectPath: string,
  hostId: string | null = null
): Promise<string[] | string> {
  if (hostId === null) {
    try {
      const { stdout: repoStdout } = await execFileAsync(
        'gh',
        ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
        { cwd: projectPath, timeout: 30000 }
      )
      const repo = String(repoStdout).trim()
      const { stdout } = await execFileAsync(
        'gh',
        ['api', '--paginate', `repos/${repo}/labels?per_page=100`, '--jq', '.[].name'],
        { cwd: projectPath, timeout: 30000 }
      )
      return parseLabelLines(String(stdout))
    } catch (err) {
      return `Failed to list labels: ${describeGhError(err)}`
    }
  }

  const host = getRequiredHost(hostId)
  const ghProbe = await probeRemoteGh(host)
  if (!ghProbe.ok) return ghProbe.error

  try {
    const stdout = await expectRemoteOk(
      host,
      [
        'sh',
        '-c',
        [
          'set -e',
          'cd "$1"',
          'repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)',
          'gh api --paginate "repos/$repo/labels?per_page=100" --jq ".[].name"',
        ].join('\n'),
        '_',
        projectPath,
      ],
      'gh failed'
    )
    return parseLabelLines(stdout)
  } catch (err) {
    return `Failed to list labels: ${describeGhError(err)}`
  }
}

function findSessionByBranch(
  projectPath: string,
  hostId: string | null,
  branch: string
): Session | undefined {
  for (const entry of sessions.values()) {
    const session = entry.session
    if (
      session.hostId === hostId &&
      session.projectPath === projectPath &&
      session.branch === branch
    ) {
      return session
    }
  }
  return undefined
}

function findSessionByPrNumber(
  projectPath: string,
  hostId: string | null,
  prNumber: number
): Session | undefined {
  for (const entry of sessions.values()) {
    const session = entry.session
    if (
      session.hostId === hostId &&
      session.projectPath === projectPath &&
      session.prNumber === prNumber
    ) {
      return session
    }
  }
  return undefined
}

async function createSessionsForNumbers(
  projectPath: string,
  hostId: string | null,
  field: 'prNumber' | 'issueNumber',
  numbers: number[],
  createSession: CreateNumberedSession,
  options: CreateSessionOptions = {}
): Promise<OpenSessionsSummary> {
  const existing = new Set<number>()
  for (const entry of sessions.values()) {
    if (entry.session.hostId !== hostId || entry.session.projectPath !== projectPath) continue
    const number = entry.session[field]
    if (number !== undefined) existing.add(number)
  }

  // Snapshot ids that already exist so we can tell a freshly-created session
  // apart from one that createSession reused (it returns a pre-existing session
  // when the requested branch is already checked out).
  const preexistingIds = new Set<string>()
  for (const entry of sessions.values()) preexistingIds.add(entry.session.id)

  const { toCreate, toSkip } = selectNumbersToOpen(
    numbers.map((n) => ({ number: n })),
    existing
  )
  const created: Session[] = []
  const reused: Session[] = []
  const failed: { number: number; error: string }[] = []
  type CreateSessionResult = { session: Session } | { number: number; error: string }
  const createOne = async (item: { number: number }): Promise<CreateSessionResult> => {
    try {
      const result = await createSession(projectPath, item.number, hostId, options)
      if (typeof result === 'string') {
        return { number: item.number, error: result }
      }
      return { session: result }
    } catch (err) {
      return { number: item.number, error: describeGhError(err) }
    }
  }

  const effectiveTool = options.tool ?? getConfig().defaultTool
  const createSerially = async (
    index: number,
    results: CreateSessionResult[]
  ): Promise<CreateSessionResult[]> => {
    const item = toCreate[index]
    if (!item) return results
    results.push(await createOne(item))
    return createSerially(index + 1, results)
  }

  const results: CreateSessionResult[] =
    hostId !== null && effectiveTool === 'codex'
      ? await createSerially(0, [])
      : await Promise.all(toCreate.map((item) => createOne(item)))

  for (const result of results) {
    if ('session' in result) {
      if (preexistingIds.has(result.session.id)) {
        reused.push(result.session)
      } else {
        created.push(result.session)
      }
    } else {
      failed.push(result)
    }
  }

  return { created, reused, skipped: toSkip, failed }
}

async function openSessionsForNumberedItems(
  projectPath: string,
  hostId: string | null,
  field: 'prNumber' | 'issueNumber',
  listItems: ListNumberedItems,
  createSession: CreateNumberedSession
): Promise<OpenSessionsSummary | string> {
  let items: NumberedGhItem[] | string
  try {
    items = await listItems(projectPath, hostId)
  } catch (err) {
    return describeGhError(err)
  }
  if (typeof items === 'string') return items

  return createSessionsForNumbers(
    projectPath,
    hostId,
    field,
    items.map((i) => i.number),
    createSession
  )
}

function describeRemoteGhProbeFailure(
  host: Host,
  result: { code: number; stderr: string; timedOut: boolean }
): string {
  const label = host.label || host.alias
  if (result.timedOut) return `Cannot reach ${label}: ssh timed out while checking for gh.`

  const { reason, message } = classifySshExit({ exitCode: result.code, stderr: result.stderr })
  if (reason === 'auth-failed') return `SSH authentication failed on ${label}: ${message}`
  if (reason === 'network') return `Cannot reach ${label}: ${message}`
  if (reason === 'bind-unlink') {
    return `${label}: remote sshd needs StreamLocalBindUnlink yes: ${message}`
  }
  if (reason === 'dep-missing') return `${label}: remote shell dependency missing: ${message}`

  return `gh CLI is not installed on host ${label}.`
}

async function probeRemoteGh(host: Host): Promise<RemoteGhProbe> {
  const result = await execRemote(host, ['sh', '-c', 'command -v gh >/dev/null 2>&1'])
  if (result.code === 0 && !result.timedOut) return { ok: true }
  return { ok: false, error: describeRemoteGhProbeFailure(host, result) }
}

export async function createPrSession(
  projectPath: string,
  prNumber: number,
  hostId: string | null = null,
  options: CreateSessionOptions = {},
  deps: CreatePrSessionDeps = {}
): Promise<Session | string> {
  if (hostId !== null) return createRemotePrSession(hostId, projectPath, prNumber, options)

  const runGit =
    deps.runGit ??
    (async (argv: string[]) => {
      const { stdout } = await execFileAsync('git', ['-C', projectPath, ...argv])
      return { stdout: String(stdout) }
    })
  const prView =
    deps.prView ??
    (async (cwd: string, number: number): Promise<PrViewInfo> => {
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'view', String(number), '--json', PR_VIEW_FIELDS],
        { cwd }
      )
      return JSON.parse(stdout)
    })
  const adopt = deps.createSessionForWorktree ?? createSessionForWorktree

  // Look up PR via gh CLI
  let prInfo: PrViewInfo
  try {
    prInfo = await prView(projectPath, prNumber)
  } catch (err) {
    return describePrLookupFailure(prNumber, describeGhError(err))
  }

  if (prInfo.state !== 'OPEN') {
    return `PR #${prNumber} is ${prInfo.state.toLowerCase()}, not open.`
  }

  const branch = prInfo.headRefName
  const forkFields = forkFieldsFromPr(prInfo)
  const isFork = forkFields.prIsFork === true

  const worktreeName = `pr-${prNumber}`

  // Reuse an existing session for this PR. First match by PR number (the only
  // globally-unique key), then — for a same-repo PR whose head branch name
  // uniquely identifies it — by branch, so a session opened earlier as an issue
  // gets tagged instead of failing on `worktree add`. A fork PR's head branch
  // name is NOT unique (two forks can share `fix`), so we never reuse a fork PR
  // by branch: that would hijack a different fork's session.
  const existing =
    findSessionByPrNumber(projectPath, hostId, prNumber) ??
    (isFork ? undefined : findSessionByBranch(projectPath, hostId, branch))
  if (existing) {
    // `gh pr view <prNumber>` just confirmed this branch belongs to the
    // requested PR, so overwrite any stale prNumber rather than only filling
    // an empty one — otherwise the requested PR is reported as linked but the
    // session keeps a different number and the PR gets offered again.
    existing.prNumber = prNumber
    existing.prIsFork = forkFields.prIsFork
    existing.prHeadRepo = forkFields.prHeadRepo
    if (existing.issueNumber === undefined) {
      existing.issueNumber = parseIssueNumber(prInfo.title)
    }
    onSessionsChanged()
    return existing
  }

  const worktreePath = join(projectPath, '.claude', 'worktrees', worktreeName)

  // The local branch to check out. A fork PR's head branch name isn't unique
  // across forks, so give it a PR-scoped local branch. We namespace it under
  // `pewpew/` (rather than a bare `pr-<n>`) so the forced fetch below can never
  // clobber an unrelated user branch that happens to be named `pr-<n>`. Same-
  // repo PRs keep the real branch name so pushes from the worktree update the
  // PR via origin/<branch>.
  const localBranch = isFork ? `pewpew/${worktreeName}` : branch

  // Fetch the PR head into the local branch we'll check out. A fork PR head is
  // ONLY authoritative via GitHub's refs/pull/<n>/head: we must not fetch
  // origin/<branch>, because if the fork's head branch name also exists on the
  // base repo (e.g. a fork whose head branch is `main`) that fetch would
  // succeed and we'd later check out the base repo's branch instead of the
  // PR's commits. A same-repo PR head lives on origin/<branch>, so fetch that.
  if (isFork) {
    // Forced refspec (`+`): a removed session leaves refs/heads/pewpew/pr-<n>
    // behind, and a later PR force-push makes a non-forced fetch reject as
    // non-fast-forward — silently reopening stale commits. The pewpew/ branch
    // is pewpew-owned and must always track the current PR head, and same-PR
    // reuse already returned above, so it isn't checked out here.
    try {
      await runGit(['fetch', 'origin', `+pull/${prNumber}/head:${localBranch}`])
    } catch {
      // Offline, or the namespaced branch is already present locally.
    }
    // The pull ref must have produced the local branch. If the fetch failed and
    // it doesn't exist, do NOT run `git worktree add <path> <localBranch>`:
    // with no local branch, git DWIMs the name to a remote-tracking
    // origin/<localBranch> (if one exists) and silently checks out the wrong
    // commits. Fail explicitly instead, mirroring the remote path.
    if (!(await localBranchExists(runGit, localBranch))) {
      return `Failed to create worktree for branch "${branch}": could not fetch refs/pull/${prNumber}/head`
    }
  } else {
    try {
      await runGit(['fetch', 'origin', branch])
    } catch {
      // May already be available locally.
    }
  }

  // Create worktree from the PR branch
  try {
    await runGit(['worktree', 'add', worktreePath, localBranch])
  } catch (err) {
    // A fork PR has no valid origin fallback — origin/<branch> is not its head.
    if (isFork) {
      return `Failed to create worktree for branch "${branch}": ${(err as Error).message}`
    }
    // Same-repo branch may not exist locally yet — create it tracking origin.
    try {
      await runGit(['worktree', 'add', worktreePath, '-b', localBranch, `origin/${branch}`])
    } catch (fallbackErr) {
      return `Failed to create worktree for branch "${branch}": ${(fallbackErr as Error).message}`
    }
  }

  const session = await adopt(projectPath, worktreePath, worktreeName, options.tool)
  // We already know the PR number; set it directly so it shows immediately
  // (the async lookup fired by adoptWorktree will no-op since prNumber is set).
  session.prNumber = prNumber
  session.prIsFork = forkFields.prIsFork
  session.prHeadRepo = forkFields.prHeadRepo
  // Prefer an issue number parsed from the PR title if the name/branch didn't yield one.
  if (session.issueNumber === undefined) {
    session.issueNumber = parseIssueNumber(prInfo.title)
  }
  onSessionsChanged()
  return session
}

export async function createPrSessions(
  projectPath: string,
  prNumbers: number[],
  hostId: string | null = null,
  options: CreateSessionOptions = {},
  deps: { createPrSession?: CreateNumberedSession } = {}
): Promise<OpenSessionsSummary | string> {
  const deduped = Array.from(new Set(prNumbers)).sort((a, b) => a - b)
  return createSessionsForNumbers(
    projectPath,
    hostId,
    'prNumber',
    deduped,
    deps.createPrSession ?? createPrSession,
    options
  )
}

export async function createIssueSession(
  projectPath: string,
  issueNumber: number,
  hostId: string | null = null,
  options: CreateSessionOptions = {},
  deps: CreateIssueSessionDeps = {}
): Promise<Session | string> {
  if (hostId !== null) return createRemoteIssueSession(hostId, projectPath, issueNumber, options)

  const branch = `issue-${issueNumber}`
  const worktreeName = `issue-${issueNumber}`
  const worktreePath = join(projectPath, '.claude', 'worktrees', worktreeName)

  for (const e of sessions.values()) {
    if (e.session.hostId === null && e.session.worktreePath === worktreePath) {
      return e.session
    }
  }

  const runGit =
    deps.runGit ??
    (async (argv: string[]) => {
      const { stdout } = await execFileAsync('git', ['-C', projectPath, ...argv], {
        timeout: 30000,
      })
      return { stdout: String(stdout) }
    })
  const hasBranch =
    deps.branchExists ?? ((root: string, branchName: string) => branchExists(root, branchName))
  const adopt = deps.createSessionForWorktree ?? createSessionForWorktree

  let originRef: string
  try {
    originRef = await resolveOriginDefaultBase(runGit)
  } catch (err) {
    const msg = (err as Error).message
    if (msg === 'no-origin-remote') return 'This project has no origin remote.'
    if (msg === 'no-origin-default-branch') return "Could not determine origin's default branch."
    return `Failed to resolve origin default: ${msg}`
  }

  try {
    await runGit(['worktree', 'add', worktreePath, '--no-track', '-b', branch, originRef])
  } catch (err) {
    if (!(await hasBranch(projectPath, branch))) {
      return `Failed to create worktree for branch "${branch}": ${(err as Error).message}`
    }
    try {
      await runGit(['worktree', 'add', worktreePath, branch])
    } catch (fallbackErr) {
      return `Failed to create worktree for branch "${branch}": ${(fallbackErr as Error).message}`
    }
  }

  const session = await adopt(projectPath, worktreePath, worktreeName, options.tool)
  session.issueNumber = issueNumber
  onSessionsChanged()
  return session
}

async function createRemoteIssueSession(
  hostId: string,
  projectPath: string,
  issueNumber: number,
  options: CreateSessionOptions = {}
): Promise<Session | string> {
  const host = getRequiredHost(hostId)
  const remoteProject = getRemoteProject(hostId, projectPath)

  const branch = `issue-${issueNumber}`
  const worktreeName = `issue-${issueNumber}`
  const worktreePath = posix.join(projectPath, '.claude', 'worktrees', worktreeName)

  for (const e of sessions.values()) {
    if (e.session.hostId === hostId && e.session.worktreePath === worktreePath) {
      return e.session
    }
  }

  return remoteHostRuntime.withPreparedHost(host, async ({ notifyScriptPath, agentPaths }) => {
    const effectiveTool: AgentTool = options.tool ?? getConfig().defaultTool
    const agentPath = agentPaths[effectiveTool]
    if (!agentPath) {
      return `${effectiveTool} is not installed on host ${host.label || host.alias}.`
    }

    const id = randomUUID().slice(0, 8)
    const tmuxSession = `pewpew-${id}`
    let originRef: string
    try {
      originRef = await resolveOriginDefaultBase((argv) =>
        expectRemoteOk(host, ['git', '-C', projectPath, ...argv], 'git failed').then((stdout) => ({
          stdout,
        }))
      )
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'no-origin-remote') return 'This project has no origin remote.'
      if (msg === 'no-origin-default-branch') return "Could not determine origin's default branch."
      return `Failed to resolve origin default: ${msg}`
    }

    try {
      await expectRemoteOk(
        host,
        [
          'git',
          '-C',
          projectPath,
          'worktree',
          'add',
          worktreePath,
          '--no-track',
          '-b',
          branch,
          originRef,
        ],
        'Failed to create remote worktree'
      )
    } catch (err) {
      if (!(await remoteBranchExists(host, projectPath, branch))) {
        return `Failed to create worktree for branch "${branch}": ${(err as Error).message}`
      }
      try {
        await expectRemoteOk(
          host,
          ['git', '-C', projectPath, 'worktree', 'add', worktreePath, branch],
          'Failed to create remote worktree'
        )
      } catch (fallbackErr) {
        return `Failed to create worktree for branch "${branch}": ${(fallbackErr as Error).message}`
      }
    }

    const resolvedBranch =
      (
        await expectRemoteOk(
          host,
          ['git', '-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
          'Failed to resolve remote branch'
        )
      ).trim() || branch

    await installRemoteAgentHooks(effectiveTool, host, worktreePath, notifyScriptPath)
    await createRemotePty(id, worktreePath, host, { tool: effectiveTool, agentPath })

    const session: Session = {
      id,
      hostId,
      projectPath,
      projectName: remoteProject.name,
      worktreeName,
      worktreePath,
      branch: resolvedBranch,
      issueNumber,
      pid: 0,
      tmuxSession,
      status: 'running',
      connectionState: 'live',
      lastActivity: Date.now(),
      hookEvents: [],
      tool: effectiveTool,
      ...(remoteProject.repoFingerprint ? { repoFingerprint: remoteProject.repoFingerprint } : {}),
    }

    sessions.set(id, { session })
    onSessionsChanged()
    return session
  })
}

export async function openSessionsForOpenPrs(
  projectPath: string,
  hostId: string | null = null,
  deps: OpenSessionsDeps = {}
): Promise<OpenSessionsSummary | string> {
  return openSessionsForNumberedItems(
    projectPath,
    hostId,
    'prNumber',
    deps.listPrs ?? listOpenPrs,
    deps.createPrSession ?? createPrSession
  )
}

export async function openSessionsForOpenIssues(
  projectPath: string,
  hostId: string | null = null,
  label?: string,
  deps: OpenSessionsDeps = {}
): Promise<OpenSessionsSummary | string> {
  return openSessionsForNumberedItems(
    projectPath,
    hostId,
    'issueNumber',
    deps.listIssues ?? ((p, h) => listOpenIssues(p, h, label)),
    deps.createIssueSession ?? createIssueSession
  )
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id)?.session
}

export function getSessions(): Session[] {
  return Array.from(sessions.values()).map((e) => e.session)
}

export async function relocateProject(
  oldProjectPath: string,
  newProjectPath: string
): Promise<{ migratedCount: number }> {
  if (!existsSync(join(newProjectPath, '.git'))) {
    throw new Error(`${newProjectPath} is not a git repository`)
  }

  const toMigrate: SessionEntry[] = []
  for (const entry of sessions.values()) {
    if (entry.session.hostId === null && entry.session.projectPath === oldProjectPath) {
      toMigrate.push(entry)
    }
  }

  const fingerprint = await getRepoFingerprint(newProjectPath)

  // Stored session paths are canonical, so canonicalize the old managed root
  // too before prefix-matching (oldProjectPath may be a symlink form).
  const oldManagedRoot = canonicalPath(join(oldProjectPath, '.claude', 'worktrees')) + sep
  for (const entry of toMigrate) {
    const s = entry.session
    s.projectPath = newProjectPath
    s.projectName = basename(newProjectPath)
    // Only rewrite worktreePath for managed worktrees under the old project's
    // .claude/worktrees tree, preserving the exact subpath (worktreeName may be
    // a branch label like "<project>/feat-x" that doesn't match the dirname).
    // External mirrored paths are kept verbatim.
    if (s.worktreePath.startsWith(oldManagedRoot)) {
      const suffix = s.worktreePath.slice(oldManagedRoot.length)
      s.worktreePath = join(newProjectPath, '.claude', 'worktrees', suffix)
    }
    if (fingerprint) s.repoFingerprint = fingerprint

    // Recreate PTY so tmux gets the new worktree cwd
    if (hasPty(s.id)) {
      destroyPty(s.id)
      if (existsSync(s.worktreePath)) {
        createPty(s.id, s.worktreePath, { tool: s.tool })
        s.status = 'idle'
      } else {
        s.status = 'dead'
      }
    }
  }

  const config = getConfig()
  if (config.clusterPositions[oldProjectPath]) {
    config.clusterPositions[newProjectPath] = config.clusterPositions[oldProjectPath]
    delete config.clusterPositions[oldProjectPath]
  }

  if (!config.pinnedPaths.includes(newProjectPath)) {
    config.pinnedPaths.push(newProjectPath)
  }
  saveConfig(config)

  const toolsInUse = new Set(toMigrate.map((e) => e.session.tool))
  if (toolsInUse.has('claude') || toolsInUse.size === 0) {
    await installHooks(newProjectPath)
  }
  if (toolsInUse.has('codex')) {
    await installCodexHooks(newProjectPath)
    ensureCodexHooksFeatureFlag()
  }
  onSessionsChanged()

  return { migratedCount: toMigrate.length }
}

// claude stores per-worktree conversations under
// `~/.claude/projects/<encoded-path>/`, where the encoding replaces any
// character outside [a-zA-Z0-9-] with '-'. We use this to decide whether
// `claude --continue` would succeed on revival: if the directory is missing,
// claude prints "No conversation found to continue" and exits with code 1,
// which collapses the tmux pane immediately and leaves the session unusable.
// In that case we spawn fresh instead, matching the existing codex fallback
// (no agentSessionId → spawn fresh) in `restoreSessions`.
//
// Claude keys the per-worktree directory off the *canonical* path, so we
// canonicalize here too. `restoreSessions` migrates legacy symlink-form
// `worktreePath`s only after the auto-recovery branch runs, so without this
// `realpathSync` a migrated session would probe an encoded symlink path,
// find nothing, and silently lose its conversation history on reboot.
function hasClaudeConversationHistory(worktreePath: string): boolean {
  const encoded = canonicalPath(worktreePath).replace(/[^a-zA-Z0-9-]/g, '-')
  return existsSync(join(homedir(), '.claude', 'projects', encoded))
}

// Remote analogue of hasClaudeConversationHistory. Claude keys the per-worktree
// directory off the *canonical* path, so we resolve symlinks on the remote
// before applying the same `[^a-zA-Z0-9-]` → '-' encoding, then test for the
// directory under the remote $HOME. Canonicalization uses `cd -P`/`pwd -P`
// (POSIX shell builtins) rather than `readlink -f`, which is GNU-only — BSD
// (macOS) readlink has no `-f` and would silently leave the symlink path
// unresolved, missing the conversation. Runs as a single positional-arg `sh -c`
// so paths with shell metacharacters stay inert. Any SSH/probe failure returns
// false, so revival falls back to a fresh spawn rather than risk
// `claude --continue` exiting immediately.
async function hasRemoteClaudeConversationHistory(
  host: Host,
  worktreePath: string
): Promise<boolean> {
  const script =
    'p=$(CDPATH= cd -P -- "$1" 2>/dev/null && pwd -P); [ -n "$p" ] || p="$1"; ' +
    "enc=$(printf '%s' \"$p\" | sed 's/[^a-zA-Z0-9-]/-/g'); " +
    '[ -d "$HOME/.claude/projects/$enc" ]'
  try {
    const result = await execRemote(host, ['sh', '-c', script, '_', worktreePath], {
      timeoutMs: 10000,
    })
    return !result.timedOut && result.code === 0
  } catch {
    return false
  }
}

// Backfill / reconcile fields added in later versions. For local sessions
// (worktreePath exists on this machine) the live git branch trumps whatever
// was persisted — an earlier version stored a wrong default that we self-heal
// here. Remote sessions can't access git without SSH, so they keep the
// persisted branch and only fall back when it's missing.
function backfillDerivedFields(session: Session): void {
  if (!session.hostId && existsSync(session.worktreePath)) {
    session.branch = resolveBranchFromWorktree(
      session.worktreePath,
      session.worktreeName,
      session.projectName
    )
  } else if (!session.branch) {
    session.branch = `${sanitizeBranchPrefix(session.projectName)}/${session.worktreeName}`
  }
  if (session.issueNumber === undefined) {
    session.issueNumber = parseIssueNumber(session.worktreeName, session.branch)
  }
  if (session.prNumber === undefined) {
    const m = session.worktreeName.match(/^pr-(\d+)$/)
    if (m) session.prNumber = parseInt(m[1], 10)
  }
  if (!session.tool) session.tool = 'claude'
}

export function restoreSessions(): void {
  if (!existsSync(SESSIONS_PATH)) return

  try {
    const data: Session[] = JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8'))
    const liveTmuxIds = new Set(discoverTmuxSessions())
    // One-time tmux precheck so we don't fire a blocking error modal per
    // session on startup when tmux is missing from PATH.
    const tmuxAvailable = isTmuxAvailable()
    let deferredCount = 0
    let skippedForNoTmux = 0

    for (const session of data) {
      session.hostId = session.hostId ?? null
      if (session.hostId) {
        // Lazy restore: a remote session materializes in `pending` until the
        // user's first click (or reconnectRemoteSession) opens the host's SSH
        // control connection and probes tmux. No network I/O here.
        // `running` → `idle` matches the local "resumedStatus" mapping; a
        // persisted status of `dead` means the remote tmux is confirmed gone
        // and there is nothing to reconnect to, so leave connectionState unset.
        if (session.status === 'running') {
          session.status = 'idle'
        }
        if (session.status !== 'dead') {
          session.connectionState = 'pending'
        }
        backfillDerivedFields(session)
        sessions.set(session.id, { session })
        continue
      }

      // Drop any persisted `connectionState`; the lazy-restore branch below
      // will set it back to 'pending'. Without this, a session that ended up
      // 'dead' on a later run (worktree gone, tmux unavailable, or completed/
      // error with no live tmux) would still carry the previous run's
      // 'pending', causing the renderer mount effects + attachLocalSession to
      // try to materialize an entry that's supposed to stay terminated.
      session.connectionState = undefined

      if (
        session.status === 'running' ||
        session.status === 'idle' ||
        session.status === 'needs_input'
      ) {
        // Preserve `needs_input` so the tray/status-bar attention signals
        // (tray.ts, StatusBar.tsx) survive a restart — claude --continue
        // resumes mid-wait, so the user still needs to answer.
        const resumedStatus: SessionStatus =
          session.status === 'needs_input' ? 'needs_input' : 'idle'
        if (liveTmuxIds.has(session.id)) {
          session.status = resumedStatus
        } else if (!existsSync(session.worktreePath)) {
          session.status = 'dead'
        } else if (!tmuxAvailable) {
          session.status = 'dead'
          skippedForNoTmux++
        } else {
          // Lazy restore (mirrors the remote arm above): mark the session
          // 'pending' and defer the tmux + agent spawn until the user opens
          // the card. Spawning all persisted sessions up-front cost ~1 GB
          // each (claude RSS) and OOM'd the box when many sessions existed.
          // attachLocalSession() drives the on-demand spawn.
          session.status = resumedStatus
          session.connectionState = 'pending'
          deferredCount++
        }
      } else if (session.status === 'completed' || session.status === 'error') {
        // Terminal states: if the tmux session is gone, the card shouldn't
        // claim the session is still alive. Don't auto-recover — the
        // conversation already ended.
        if (!liveTmuxIds.has(session.id)) {
          session.status = 'dead'
        }
      }
      // Migrate legacy symlink-form paths to canonical so renderer matches work.
      session.worktreePath = canonicalPath(session.worktreePath)
      backfillDerivedFields(session)
      if (session.status !== 'dead') {
        session.lastActivity = Date.now()
      }
      sessions.set(session.id, { session })
    }

    if (skippedForNoTmux > 0) {
      console.warn(
        `tmux not found — ${skippedForNoTmux} session(s) left as 'dead'. Install tmux to enable auto-recovery.`
      )
    }

    // Reattach ptys after all sessions are in the map. Local sessions
    // without a live tmux were deferred (connectionState='pending'); the
    // liveTmuxIds filter here correctly skips them.
    for (const session of data) {
      if (
        (session.status === 'idle' || session.status === 'needs_input') &&
        liveTmuxIds.has(session.id)
      ) {
        try {
          reattachPty(session.id)
        } catch (err) {
          console.error(`Failed to reattach pty for ${session.id}:`, err)
        }
      }
    }

    if (deferredCount > 0) {
      console.log(`Deferred ${deferredCount} session(s) — will attach on demand`)
    }

    // Lazily resolve PR numbers for any restored session that doesn't have one
    for (const session of data) {
      if (session.prNumber === undefined) resolvePrNumberAsync(session.id)
    }

    onSessionsChanged()
  } catch {
    // Corrupted sessions file — start fresh
  }
}
