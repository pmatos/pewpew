import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, basename, sep } from 'path'
import { posix } from 'path'
import { randomUUID } from 'crypto'
import { dialog, shell } from 'electron'
import { canonicalPath } from './agent-state-paths'
import { canResumeLocal, canResumeRemote } from './agent-resumability'
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
import { getRequiredHost, expectRemoteOk } from './remote-command'
import {
  describeGhError,
  listOpenPrs,
  listOpenIssues,
  probeRemoteGh,
  type NumberedGhItem,
  type ListNumberedItems,
} from './github-items'
import { applyHookEvent, type SideEffectIntent } from './session-state-machine'
import { deriveRestoredState } from './restore-planner'
import { applyProbeTransition, computeProbeTransition } from './probe-transition'
import { planIssueWorktree } from './worktree-plan'
import { planRelocation } from './relocation-plan'
import {
  PR_VIEW_FIELDS,
  describePrLookupFailure,
  forkPullRefUnavailableMessage,
  planPrWorktree,
  type PrViewInfo,
} from './pr-worktree-planner'
import { exec as execRemote, runtimeStateFor, type HostConnectionState } from './host-connection'
import { remoteHostRuntime, type PreparedRemoteHostLease } from './remote-host-runtime'
import { createPrLookup, parseOwnerFromRemoteUrl } from './github'
import { parseIssueNumber, worktreeBranchName } from './branch-naming'
import { resolveOriginDefaultBase, type GitRunner } from './origin-base'
import { branchRefExists } from './branch-ref'
import { classifyAutoReconnectResult } from './reconnect-outcome'
import { deriveSessionFields } from './session-fields'
import {
  numbersInUse,
  selectNumbersToOpen,
  shouldCreateSerially,
  summarizeCreations,
  type CreateOutcome,
} from './numbered-session-plan'
import {
  assertNoConflictingToolOnWorktree,
  assertToolCompatible,
  findSessionByBranch,
  findSessionByPrNumber,
  findSessionOnCanonicalWorktree,
  findSessionOnWorktree,
  occupiedWorktreePaths,
  worktreePathsForHost,
} from './session-queries'
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
  return worktreeBranchName(projectName, worktreeName)
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

// Live view of the session set for the pure lookups in session-queries.
function* allSessions(): Iterable<Session> {
  for (const entry of sessions.values()) yield entry.session
}

function getRemoteProject(hostId: string, projectPath: string): RemoteProject {
  const project = listRemoteProjects().find((p) => p.hostId === hostId && p.path === projectPath)
  if (!project) throw new Error('Remote project is not registered')
  return project
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
  return branchRefExists(
    (argv) => execFileAsync('git', ['-C', projectPath, ...argv], { timeout: 5000 }),
    branchName
  )
}

async function remoteBranchExists(
  host: Host,
  projectPath: string,
  branchName: string
): Promise<boolean> {
  return branchRefExists(
    (argv) =>
      expectRemoteOk(host, ['git', '-C', projectPath, ...argv], 'git failed').then((stdout) => ({
        stdout,
      })),
    branchName
  )
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

// A newly spawned process can exit before its Session record is inserted
// (remote tmux failures make this window especially easy to hit). Keep that
// signal and replay it as soon as registration completes; dropping it leaves a
// dead PTY recorded as connectionState='live', which renders a black terminal.
const pendingUnexpectedExits = new Set<string>()

function handleUnexpectedPtyExit(sessionId: string): boolean {
  const entry = sessions.get(sessionId)
  if (!entry) return false
  if (entry.session.status === 'dead') return true

  if (!entry.session.hostId) {
    updateSession(sessionId, 'dead')
    return true
  }

  // A normally-ended remote session (agent exited → session.end hook →
  // promptCleanup) must not be auto-reconnected: its remote tmux is gone, so a
  // probe would flip it to 'dead' with a misleading "remote session ended"
  // toast and could clobber a user-chosen 'completed'. Terminal statuses and
  // an in-flight cleanup both mark a genuine end — a network drop delivers no
  // session.end hook, so it never trips these.
  if (entry.session.status === 'completed' || entry.session.status === 'error') return true
  if (cleanupInProgress.has(sessionId)) return true

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
  return true
}

function registerSpawnedSession(session: Session): void {
  sessions.set(session.id, { session })
  if (pendingUnexpectedExits.delete(session.id)) {
    handleUnexpectedPtyExit(session.id)
  }
}

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
    if (!handleUnexpectedPtyExit(sessionId)) {
      pendingUnexpectedExits.add(sessionId)
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
  const existing = findSessionOnCanonicalWorktree(allSessions(), worktreePath, canonicalPath)
  if (existing) {
    assertToolCompatible(existing, effectiveTool)
    return existing
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
  if (tool === 'omp') {
    // omp's hook bridge is passed via `--hook <path>` in buildAgentArgs, not
    // written into the project — nothing to install here.
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
  const sandboxed = createPty(id, worktreePath, { tool, projectPath })

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
    sandboxed,
  }

  registerSpawnedSession(session)

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
  const existingPaths = occupiedWorktreePaths(allSessions(), canonicalPath)

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
  const adopted = worktreePathsForHost(allSessions(), hostId)

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
  notifyScriptPath: string,
  guardScriptPath: string
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
  if (tool === 'omp') {
    // omp's hook bridge is installed as a plain file by bootstrapHost (see
    // ompHookScriptPath) and passed via `--hook <path>` in buildAgentArgs —
    // no settings/hooks JSON to merge into the remote worktree here.
    return
  }
  await installRemoteHooks(remote, worktreePath, notifyScriptPath, guardScriptPath)
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

  const existing = findSessionOnWorktree(allSessions(), hostId, worktreePath)
  if (existing) {
    assertToolCompatible(existing, effectiveTool)
    return existing
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

  const { branch, sandboxed } = await remoteHostRuntime.withPreparedHost(
    host,
    async ({
      notifyScriptPath,
      guardScriptPath,
      ompHookScriptPath,
      remoteSocketPath,
      sandboxAvailable,
      agentPaths,
    }) => {
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

      await installRemoteAgentHooks(tool, host, worktreePath, notifyScriptPath, guardScriptPath)
      const wasSandboxed = await createRemotePty(id, worktreePath, host, {
        tool,
        agentPath,
        projectPath,
        notifyHookPath: ompHookScriptPath,
        remoteSocketPath,
        sandboxAvailable,
      })
      return { branch: resolvedBranch, sandboxed: wasSandboxed }
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
    sandboxed,
    ...(remoteProject.repoFingerprint ? { repoFingerprint: remoteProject.repoFingerprint } : {}),
  }

  registerSpawnedSession(session)
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

  // A same-tool session on this path is left to fall through (a new named
  // session is created); only a tool mismatch is rejected. Scan every match,
  // not just the first: restored data can hold duplicate records for one
  // worktree, so a same-tool first record must not mask a mismatched later one.
  assertNoConflictingToolOnWorktree(allSessions(), hostId, worktreePath, effectiveTool)

  const id = randomUUID().slice(0, 8)
  const tmuxSession = `pewpew-${id}`
  const branchName = worktreeBranchName(remoteProject.name, worktreeName)
  const baseRef = effectiveWorktreeBase(options)

  const { branch, sandboxed } = await remoteHostRuntime.withPreparedHost(
    host,
    async ({
      notifyScriptPath,
      guardScriptPath,
      ompHookScriptPath,
      remoteSocketPath,
      sandboxAvailable,
      agentPaths,
    }) => {
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

      await installRemoteAgentHooks(
        effectiveTool,
        host,
        worktreePath,
        notifyScriptPath,
        guardScriptPath
      )
      const wasSandboxed = await createRemotePty(id, worktreePath, host, {
        tool: effectiveTool,
        agentPath,
        projectPath,
        notifyHookPath: ompHookScriptPath,
        remoteSocketPath,
        sandboxAvailable,
      })
      return { branch: resolvedBranch, sandboxed: wasSandboxed }
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
    sandboxed,
    ...(remoteProject.repoFingerprint ? { repoFingerprint: remoteProject.repoFingerprint } : {}),
  }

  registerSpawnedSession(session)
  onSessionsChanged()
  return session
}

// `gh pr view` args for a PR, targeting an explicit repo (a fork's upstream)
// when given so gh doesn't resolve the wrong default repo.
export function ghPrViewArgs(prNumber: number, repo?: string | null): string[] {
  const args = ['pr', 'view', String(prNumber), '--json', PR_VIEW_FIELDS]
  return repo ? [...args, '--repo', repo] : args
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

  const existing = findSessionOnWorktree(allSessions(), hostId, worktreePath)
  if (existing) return existing

  return remoteHostRuntime.withPreparedHost(
    host,
    async ({
      notifyScriptPath,
      guardScriptPath,
      ompHookScriptPath,
      remoteSocketPath,
      sandboxAvailable,
      agentPaths,
    }) => {
      const ghProbe = await probeRemoteGh(host)
      if (!ghProbe.ok) {
        return ghProbe.error
      }

      // Target an explicit repo (a fork's upstream) when given so gh doesn't
      // resolve the wrong default repo; the repo is passed as $3 and inlined only
      // when present.
      const externalRepo = options.repo || undefined
      let prInfo: PrViewInfo
      const viewResult = await execRemote(host, [
        'sh',
        '-c',
        `cd "$1" && gh pr view "$2" --json ${PR_VIEW_FIELDS}${externalRepo ? ' --repo "$3"' : ''}`,
        '_',
        projectPath,
        String(prNumber),
        externalRepo ?? '',
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

      const planResult = planPrWorktree(prNumber, prInfo, externalRepo)
      if (!planResult.ok) return planResult.message
      const { branch, localBranch, isFork, forkFields, fetchRemote, fetchRefspec } = planResult.plan

      const effectiveTool: AgentTool = options.tool ?? getConfig().defaultTool
      const agentPath = agentPaths[effectiveTool]
      if (!agentPath) {
        return `${effectiveTool} is not installed on host ${host.label || host.alias}.`
      }

      const id = randomUUID().slice(0, 8)
      const tmuxSession = `pewpew-${id}`

      // Fetch the PR head into the local branch we'll check out; planPrWorktree
      // picked the remote (origin, or the overridden repo's URL when a fork clone
      // opens an upstream PR) and the refspec (a head-elsewhere PR head is
      // force-fetched from refs/pull/<n>/head into its pewpew-namespaced branch, a
      // same-repo head from origin/<branch>). A failure is tolerated — the branch
      // may already be present locally, and a head-elsewhere PR that genuinely
      // couldn't fetch is caught by the probe below.
      const fetchResult = await execRemote(host, [
        'git',
        '-C',
        projectPath,
        'fetch',
        fetchRemote,
        fetchRefspec,
      ]).catch(() => undefined)
      // Keep the fetch's stderr: an override fetch runs over the upstream repo's
      // URL (not origin), so an auth/transport failure surfaces here and would
      // otherwise be lost behind the generic "could not fetch" message.
      const fetchError =
        fetchResult && fetchResult.code !== 0
          ? fetchResult.stderr.trim() || `git fetch exited ${fetchResult.code}`
          : undefined

      // Pick the worktree-add form by probing for the local branch first instead
      // of try-then-fallback. The fallback masked real failures (e.g. branch
      // already checked out in a stale worktree) by surfacing the second
      // attempt's misleading "branch already exists" error.
      const branchExistsLocally = await remoteBranchExists(host, projectPath, localBranch)
      if (isFork && !branchExistsLocally) {
        // The pull-ref fetch should have created the pewpew/ branch; if it didn't
        // there's no valid origin fallback for a head-elsewhere PR (origin/<branch>
        // isn't the PR head).
        return forkPullRefUnavailableMessage(branch, prNumber, fetchError)
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

      await installRemoteAgentHooks(
        effectiveTool,
        host,
        worktreePath,
        notifyScriptPath,
        guardScriptPath
      )
      const sandboxed = await createRemotePty(id, worktreePath, host, {
        tool: effectiveTool,
        agentPath,
        projectPath,
        notifyHookPath: ompHookScriptPath,
        remoteSocketPath,
        sandboxAvailable,
      })

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
        sandboxed,
        ...(remoteProject.repoFingerprint
          ? { repoFingerprint: remoteProject.repoFingerprint }
          : {}),
      }

      registerSpawnedSession(session)
      onSessionsChanged()
      return session
    }
  )
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
  const branchName = worktreeBranchName(basename(projectPath), worktreeName)
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
  // A terminal session is done — never re-probe/reconnect it. attemptAutoReconnect
  // already bails on 'completed'/'error' before calling; guard the manual/IPC entry
  // point too, so triggering Reconnect on a kept ('completed') or errored session
  // can't probe-and-flip it back to 'dead', silently undoing the user's Keep.
  // Defense-in-depth: deriveRestoredState now restores terminal remotes as 'live'
  // (not 'pending'), so the UI no longer offers Reconnect for them — but this keeps
  // any other caller that reaches here with a stale non-live terminal session a
  // no-op. Mirrors the status guard in attemptAutoReconnect.
  const current = sessions.get(id)?.session
  if (current && (current.status === 'completed' || current.status === 'error')) return

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
    // Pure decision core in probe-transition.ts. `null` = the session resolved to
    // a terminal state while this probe was in flight (e.g. a delayed session.end
    // hook drove promptCleanup and the user chose Keep). Applying the probe result
    // now would clobber that decision ('absent' → 'dead'), re-exposing cleanup and
    // risking deletion of the kept worktree. Leave it untouched; the lease is still
    // returned below so the caller reconciles/releases it.
    let transition = computeProbeTransition(session.status, probe, Date.now())
    if (transition?.reattach) {
      // Reattach before applying the delta so a reattach failure leaves the
      // session's fields untouched and falls through to the catch below. The
      // reattach await is a real window in which a concurrent session.end → Keep
      // can drive status to terminal, so re-derive against the now-current status:
      // a stale 'running → idle' delta must not revert a session the user kept.
      await reattachRemotePty(id, host)
      transition = computeProbeTransition(session.status, probe, Date.now())
    }
    if (transition) {
      applyProbeTransition(session, transition)
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

  const { outcome, effect } = classifyAutoReconnectResult({
    status: after.status,
    connectionState: after.connectionState,
  })
  switch (effect) {
    case 'toast-reconnected':
      emitToast({ severity: 'info', title: `Reconnected to ${label}` })
      break
    case 'prompt-cleanup':
      // Remote tmux confirmed gone: the agent ended. The session.end hook that
      // drives promptCleanup for a live session is unreliable over a remote link
      // (it races the ControlMaster/reverse-forward teardown as the PTY drops, so
      // the message is often lost before it arrives), leaving remote sessions
      // without the "Clean up worktree?" dialog local sessions get on exit. This
      // probe result is the dependable "session ended" signal, so prompt the same
      // cleanup here — otherwise the card is silently left dead and the user
      // removes it by hand, deleting the worktree with no confirmation. Fire and
      // forget (the dialog awaits user input); promptCleanup's own in-progress
      // guard makes a late-arriving session.end hook a no-op.
      void promptCleanup(id).catch((err) => {
        console.error(`promptCleanup(${id}) failed:`, err)
        // If the dialog itself failed (no window available, Electron dialog IPC
        // error), still surface the "session ended" signal the old synchronous
        // toast guaranteed — a dialog failure must not silently swallow it.
        emitToast({ severity: 'error', title: `${label}: remote session ended` })
      })
      break
    case 'toast-auth-failed':
      emitToast({ severity: 'error', title: `SSH authentication failed on ${label}` })
      break
    case 'none':
      break
  }
  return outcome
}

const reconnectScheduler = createReconnectScheduler({
  attempt: attemptAutoReconnect,
  config: getReconnectConfig,
})

export function stopSessionManager(): void {
  reconnectScheduler.shutdown()
  pendingUnexpectedExits.clear()
  setUnexpectedExitListener(null)
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
    // Skip terminal (completed/error) sessions from the pending pool: probing one
    // would find its tmux gone and flip it to 'dead', silently reverting a session
    // the user chose to keep. deriveRestoredState now restores terminal remotes as
    // 'live' (not 'pending'), so they shouldn't reach here — this is defense-in-depth
    // against any other path leaving a terminal session 'pending'. Mirrors the
    // guards in attemptAutoReconnect and reconnectRemoteSession.
    if (
      entry.session.hostId === hostId &&
      entry.session.connectionState === 'pending' &&
      entry.session.status !== 'completed' &&
      entry.session.status !== 'error'
    ) {
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
      // Same pure decision core as doReconnectRemoteSession (probe-transition.ts).
      // `null` = the session resolved to terminal (a concurrent session.end →
      // promptCleanup → Keep) while this probe was in flight — the snapshot filter
      // above only catches sessions already terminal at batch entry. Skip it and
      // move on without clobbering that decision.
      let transition = computeProbeTransition(s.status, probe, Date.now())
      if (transition === null) {
        await reconnectNext(index + 1)
        return
      }
      if (transition.reattach) {
        // The reattach await is a real window in which a concurrent session.end →
        // Keep can resolve this session to terminal; re-derive against the
        // now-current status so a stale 'running → idle' delta can't revert it.
        await reattachRemotePty(s.id, reconnectHost)
        transition = computeProbeTransition(s.status, probe, Date.now())
        if (transition === null) {
          await reconnectNext(index + 1)
          return
        }
      }
      applyProbeTransition(s, transition)
      // An SSH probe failure (unreachable — timeout / auth / network) means the
      // remote may still be running. The transition already marked it; bail so we
      // don't mis-classify the rest of the batch as dead on a transient failure.
      if (probe === 'unreachable') return
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
      await remoteHostRuntime.withPreparedHost(
        host,
        async ({
          agentPaths,
          notifyScriptPath,
          guardScriptPath,
          ompHookScriptPath,
          remoteSocketPath,
          sandboxAvailable,
        }) => {
          if (await hasRemoteTmuxSession(id, host)) {
            await reattachRemotePty(id, host)
          } else {
            const agentPath = agentPaths[session.tool]
            if (!agentPath) {
              throw new Error(
                `${session.tool} is not installed on host ${host.label || host.alias}`
              )
            }
            const canResume = await canResumeRemote(session, host, execRemote)
            if (!canResume) {
              console.warn(
                `Session ${id} (${session.tool}) has no prior conversation on host ${host.alias}; spawning fresh instead of resuming`
              )
            }
            // See the local branch above: reinstall hooks before spawning so
            // a long-since-created remote worktree picks up hook fixes that
            // landed after its last install, instead of running forever
            // against whatever was current at creation time. Mirrors the
            // local branch's existsSync guard: installRemoteAgentHooks runs
            // mkdir -p on the worktree path, which would otherwise silently
            // resurrect a deleted remote worktree as an empty, non-git
            // directory instead of letting the tmux spawn below fail loudly.
            if (await hasRemoteWorktree(host, session.worktreePath)) {
              await installRemoteAgentHooks(
                session.tool,
                host,
                session.worktreePath,
                notifyScriptPath,
                guardScriptPath
              )
            }
            session.sandboxed = await createRemotePty(id, session.worktreePath, host, {
              continueSession: canResume,
              tool: session.tool,
              agentSessionId: session.agentSessionId,
              agentPath,
              projectPath: session.projectPath,
              notifyHookPath: ompHookScriptPath,
              remoteSocketPath,
              sandboxAvailable,
            })
          }
        }
      )
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
    const canResume = canResumeLocal(session)
    if (!canResume) {
      console.warn(
        `Session ${id} (${session.tool}) has no prior conversation; spawning fresh instead of resuming`
      )
    }
    // Reinstall hooks before spawning: the agent process reads its hook
    // config at process start (see the relocateProject comment above), and a
    // session revived here may have been created long before its worktree's
    // settings.local.json last saw an installHooks() call — any hook fix
    // that landed since (e.g. worktree-guard.sh's /tmp exemption) would
    // otherwise never reach this worktree until it's relocated or recreated.
    if (existsSync(session.worktreePath)) {
      await installAgentHooks(session.tool, session.worktreePath)
    }
    session.sandboxed = createPty(id, session.worktreePath, {
      continueSession: canResume,
      tool: session.tool,
      agentSessionId: session.agentSessionId,
      projectPath: session.projectPath,
    })
  }
  updateSession(id, 'idle')
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
      const canResume = canResumeLocal(session)
      if (!canResume) {
        console.warn(
          `Session ${id} (${session.tool}) has no prior conversation; spawning fresh instead of resuming`
        )
      }
      // See reviveSession's local branch: reinstall hooks before spawning so
      // a session that's been pending since long before its worktree's last
      // installHooks() call picks up hook fixes landed since then. Best
      // effort: unlike reviveSession, this path had no hook-install call (and
      // so no way to fail on one) before this change — a pending session
      // always spawned successfully regardless of hook file state. Swallow a
      // failure here rather than let it flip an otherwise-healthy attach to
      // 'dead', since a stale-hooks spawn is strictly better than no spawn.
      try {
        await installAgentHooks(session.tool, session.worktreePath)
      } catch (err) {
        console.error(`Session ${id}: failed to reinstall hooks before attach`, err)
      }
      session.sandboxed = createPty(id, session.worktreePath, {
        continueSession: canResume,
        tool: session.tool,
        agentSessionId: session.agentSessionId,
        projectPath: session.projectPath,
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
  // Suppress a racing session.end → promptCleanup dialog: destroyPty/
  // destroyRemotePty below deliver a real kill signal to the agent process
  // (unlike killSession's detach-only local path), and some tools' hooks
  // complete fast enough over that signal to land while removeWorktree's git
  // subprocess is still running — before this session is even out of the
  // `sessions` map. Without this guard that races the explicit, dialog-free
  // delete here against a "clean up worktree?" prompt for a worktree that's
  // already being (or already was) force-removed. Released below on both paths:
  // on failure: getRequiredHost throws synchronously for a removed host
  // config, and destroyRemotePty throws on SSH failures — both reachable
  // since this is called directly from the sessions:remove(-batch) IPC
  // handlers, not just via promptCleanup, so the failure path must not leave
  // the surviving session permanently wedged out of future cleanup-dialog
  // prompts. The success path also releases it (rather than leaving it "safe
  // to leak forever since the id can't be revived") so this process-lifetime
  // Set doesn't grow by one entry for every session ever removed.
  cleanupInProgress.add(id)
  try {
    if (entry?.session.hostId) {
      const host = getRequiredHost(entry.session.hostId)
      await destroyRemotePty(id, host)
    } else {
      destroyPty(id)
    }
    await removeWorktree(id)
    sessions.delete(id)
    cleanupInProgress.delete(id)
    onSessionsChanged()
  } catch (err) {
    cleanupInProgress.delete(id)
    throw err
  }
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

    // A terminal cleanup decision was already made for this session, so bail
    // rather than prompt again. The Keep branches below are the only producer
    // of 'completed', and Delete removes the entry outright — so reaching
    // promptCleanup for a 'completed'/'error' session means a late remote
    // session.end hook (or a second probe) raced in after the first decision
    // cleared cleanupInProgress. Re-opening the dialog would show a duplicate
    // prompt and let a Delete destroy a worktree the user just chose to keep.
    // Mirrors the terminal-state guards in the unexpected-exit listener and
    // attemptAutoReconnect.
    if (session.status === 'completed' || session.status === 'error') return

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
      try {
        await removeSession(id)
      } catch (err) {
        // Surface a Delete failure (host config removed → getRequiredHost throws,
        // or the remote SSH teardown fails) with its own accurate error. Letting
        // it propagate to attemptAutoReconnect's `.catch` would mislabel it
        // "remote session ended" and mask a worktree that's still there.
        console.error(`removeSession(${id}) failed:`, err)
        emitToast({
          severity: 'error',
          title: `Failed to remove worktree "${session.projectName}/${session.worktreeName}"`,
        })
      }
    } else if (response === 1 || response === 2) {
      // Keep (1) / Keep-and-open (2): the session is finished. The probe-absent
      // path reaches here with connectionState 'offline' (the remote tmux is
      // gone). Leaving it non-live would make SessionCard/DetailPane treat this
      // kept session as a droppable remote and offer a Reconnect/Retry that
      // silently reverts it to 'dead', undoing the Keep. Normalize to 'live' —
      // the same terminal state a live-connection completion already lands in —
      // so a kept remote session is uniformly terminal. (Local sessions have no
      // hostId and keep connectionState undefined.)
      if (session.hostId) session.connectionState = 'live'
      updateSession(id, 'completed')
      if (response === 2) shell.openPath(session.worktreePath)
    }
  } finally {
    cleanupInProgress.delete(id)
  }
}

export { selectNumbersToOpen }

type CreateNumberedSession = (
  projectPath: string,
  number: number,
  hostId: string | null,
  options?: CreateSessionOptions
) => Promise<Session | string>

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
  prView?: (projectPath: string, prNumber: number, repo?: string | null) => Promise<PrViewInfo>
  createSessionForWorktree?: (
    projectPath: string,
    worktreePath: string,
    label?: string,
    tool?: AgentTool
  ) => Promise<Session>
}

async function createSessionsForNumbers(
  projectPath: string,
  hostId: string | null,
  field: 'prNumber' | 'issueNumber',
  numbers: number[],
  createSession: CreateNumberedSession,
  options: CreateSessionOptions = {}
): Promise<OpenSessionsSummary> {
  // Snapshot the session registry once: which numbers are already taken, and
  // which ids exist before the batch runs (so a reused session — one createSession
  // hands back when its branch is already checked out — is told apart from a
  // freshly-created one).
  const currentSessions = Array.from(sessions.values(), (e) => e.session)
  const existing = numbersInUse(currentSessions, projectPath, hostId, field)
  const preexistingIds = new Set(currentSessions.map((s) => s.id))

  const { toCreate, toSkip } = selectNumbersToOpen(
    numbers.map((n) => ({ number: n })),
    existing
  )
  const createOne = async (item: { number: number }): Promise<CreateOutcome> => {
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
    results: CreateOutcome[]
  ): Promise<CreateOutcome[]> => {
    const item = toCreate[index]
    if (!item) return results
    results.push(await createOne(item))
    return createSerially(index + 1, results)
  }

  const results: CreateOutcome[] = shouldCreateSerially(hostId, effectiveTool)
    ? await createSerially(0, [])
    : await Promise.all(toCreate.map((item) => createOne(item)))

  return summarizeCreations(results, preexistingIds, toSkip)
}

async function openSessionsForNumberedItems(
  projectPath: string,
  hostId: string | null,
  field: 'prNumber' | 'issueNumber',
  listItems: ListNumberedItems,
  createSession: CreateNumberedSession,
  options: CreateSessionOptions = {}
): Promise<OpenSessionsSummary | string> {
  let items: NumberedGhItem[] | string
  try {
    items = await listItems(projectPath, hostId, options.repo ?? null)
  } catch (err) {
    return describeGhError(err)
  }
  if (typeof items === 'string') return items

  return createSessionsForNumbers(
    projectPath,
    hostId,
    field,
    items.map((i) => i.number),
    createSession,
    options
  )
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
    (async (cwd: string, number: number, repo?: string | null): Promise<PrViewInfo> => {
      const { stdout } = await execFileAsync('gh', ghPrViewArgs(number, repo), { cwd })
      return JSON.parse(stdout)
    })
  const adopt = deps.createSessionForWorktree ?? createSessionForWorktree

  // Look up PR via gh CLI, targeting an explicit repo (a fork's upstream) when given.
  let prInfo: PrViewInfo
  try {
    prInfo = await prView(projectPath, prNumber, options.repo)
  } catch (err) {
    return describePrLookupFailure(prNumber, describeGhError(err))
  }

  const planResult = planPrWorktree(prNumber, prInfo, options.repo)
  if (!planResult.ok) return planResult.message
  const { worktreeName, branch, localBranch, isFork, forkFields, fetchRemote, fetchRefspec } =
    planResult.plan

  // Reuse an existing session for this PR. First match by PR number (the only
  // globally-unique key), then — for a same-repo PR whose head branch name
  // uniquely identifies it — by branch, so a session opened earlier as an issue
  // gets tagged instead of failing on `worktree add`. A fork PR's head branch
  // name is NOT unique (two forks can share `fix`), so we never reuse a fork PR
  // by branch: that would hijack a different fork's session.
  const existing =
    findSessionByPrNumber(allSessions(), projectPath, hostId, prNumber) ??
    (isFork ? undefined : findSessionByBranch(allSessions(), projectPath, hostId, branch))
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

  // Fetch the PR head into the local branch we'll check out; planPrWorktree
  // picked the remote (origin, or the overridden repo's URL when a fork clone
  // opens an upstream PR) and the refspec (a head-elsewhere PR head is
  // force-fetched from refs/pull/<n>/head into its pewpew-namespaced branch, a
  // same-repo head from origin/<branch>).
  // Keep the fetch error: an override fetch runs over the upstream repo's URL
  // (not origin), so an auth/transport failure surfaces here and would otherwise
  // be lost behind the generic "could not fetch" message.
  let fetchError: string | undefined
  try {
    await runGit(['fetch', fetchRemote, fetchRefspec])
  } catch (err) {
    // Offline, or the branch is already present locally.
    fetchError = describeGhError(err)
  }
  // The pull ref must have produced the local branch. If the fetch failed and it
  // doesn't exist, do NOT run `git worktree add <path> <localBranch>`: with no
  // local branch, git DWIMs the name to a remote-tracking origin/<localBranch>
  // (if one exists) and silently checks out the wrong commits. Fail explicitly
  // instead, mirroring the remote path.
  if (isFork && !(await branchRefExists(runGit, localBranch, { quiet: true }))) {
    return forkPullRefUnavailableMessage(branch, prNumber, fetchError)
  }

  // Create worktree from the PR branch
  try {
    await runGit(['worktree', 'add', worktreePath, localBranch])
  } catch (err) {
    // A head-elsewhere PR has no valid origin fallback — origin/<branch> is not
    // its head.
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

  const { worktreeName, branch } = planIssueWorktree(issueNumber)
  const worktreePath = join(projectPath, '.claude', 'worktrees', worktreeName)

  // Exact (non-canonical) compare, matching the historical local-issue lookup.
  const existing = findSessionOnWorktree(allSessions(), null, worktreePath)
  if (existing) return existing

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

  const { worktreeName, branch } = planIssueWorktree(issueNumber)
  const worktreePath = posix.join(projectPath, '.claude', 'worktrees', worktreeName)

  const existing = findSessionOnWorktree(allSessions(), hostId, worktreePath)
  if (existing) return existing

  return remoteHostRuntime.withPreparedHost(
    host,
    async ({
      notifyScriptPath,
      guardScriptPath,
      ompHookScriptPath,
      remoteSocketPath,
      sandboxAvailable,
      agentPaths,
    }) => {
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
          expectRemoteOk(host, ['git', '-C', projectPath, ...argv], 'git failed').then(
            (stdout) => ({
              stdout,
            })
          )
        )
      } catch (err) {
        const msg = (err as Error).message
        if (msg === 'no-origin-remote') return 'This project has no origin remote.'
        if (msg === 'no-origin-default-branch')
          return "Could not determine origin's default branch."
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

      await installRemoteAgentHooks(
        effectiveTool,
        host,
        worktreePath,
        notifyScriptPath,
        guardScriptPath
      )
      const sandboxed = await createRemotePty(id, worktreePath, host, {
        tool: effectiveTool,
        agentPath,
        projectPath,
        notifyHookPath: ompHookScriptPath,
        remoteSocketPath,
        sandboxAvailable,
      })

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
        sandboxed,
        ...(remoteProject.repoFingerprint
          ? { repoFingerprint: remoteProject.repoFingerprint }
          : {}),
      }

      registerSpawnedSession(session)
      onSessionsChanged()
      return session
    }
  )
}

export async function openSessionsForOpenPrs(
  projectPath: string,
  hostId: string | null = null,
  options: CreateSessionOptions = {},
  deps: OpenSessionsDeps = {}
): Promise<OpenSessionsSummary | string> {
  return openSessionsForNumberedItems(
    projectPath,
    hostId,
    'prNumber',
    deps.listPrs ?? listOpenPrs,
    deps.createPrSession ?? createPrSession,
    options
  )
}

export async function openSessionsForOpenIssues(
  projectPath: string,
  hostId: string | null = null,
  label?: string,
  repo: string | null = null,
  deps: OpenSessionsDeps = {}
): Promise<OpenSessionsSummary | string> {
  return openSessionsForNumberedItems(
    projectPath,
    hostId,
    'issueNumber',
    deps.listIssues ?? ((p, h, r) => listOpenIssues(p, h, label, r)),
    deps.createIssueSession ?? createIssueSession,
    repo ? { repo } : {}
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

  // Stored session paths are canonical, so canonicalize the old managed root
  // too before prefix-matching (oldProjectPath may be a symlink form). The pure
  // path/name policy — which sessions move and where — lives in `planRelocation`.
  const oldManagedRoot = canonicalPath(join(oldProjectPath, '.claude', 'worktrees')) + sep
  const plan = planRelocation(
    Array.from(sessions.values(), (entry) => entry.session),
    { oldProjectPath, newProjectPath, oldManagedRoot }
  )

  const fingerprint = await getRepoFingerprint(newProjectPath)

  const toolsInUse = new Set<AgentTool>()
  for (const remap of plan) {
    const entry = sessions.get(remap.id)
    if (!entry) continue
    const s = entry.session
    toolsInUse.add(s.tool)
    s.projectPath = remap.projectPath
    s.projectName = remap.projectName
    s.worktreePath = remap.worktreePath
    if (fingerprint) s.repoFingerprint = fingerprint

    // worktree-guard.sh bakes the root in as an argv literal at install
    // time; relocating the project changes that path out from under it, so
    // the guard's own `cd "$root"` starts failing and denies every write in
    // the relocated worktree. Reinstall the hook with the fresh worktreePath
    // BEFORE recreating the PTY below — Claude reads its hook config at
    // process start, so if the PTY launched first it would run its entire
    // lifetime against the stale, now-failing guard command.
    if (s.tool === 'claude' && existsSync(s.worktreePath)) {
      await installHooks(s.worktreePath, { skipGitignore: true })
    }

    // Recreate PTY so tmux gets the new worktree cwd
    if (hasPty(s.id)) {
      destroyPty(s.id)
      if (existsSync(s.worktreePath)) {
        s.sandboxed = createPty(s.id, s.worktreePath, { tool: s.tool, projectPath: s.projectPath })
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

  if (toolsInUse.has('claude') || toolsInUse.size === 0) {
    await installHooks(newProjectPath)
  }
  if (toolsInUse.has('codex')) {
    await installCodexHooks(newProjectPath)
    ensureCodexHooksFeatureFlag()
  }
  onSessionsChanged()

  return { migratedCount: plan.length }
}

// Guards reviveSession's remote fresh-spawn branch against a deleted remote
// worktree, mirroring the local branch's plain existsSync check — deliberately
// a bare directory-existence test rather than the stricter `git rev-parse
// --is-inside-work-tree` used by createRemoteSessionForWorktree, so a worktree
// with a valid directory but transiently broken git metadata still spawns
// exactly as it did before this reinstall-hooks change.
//
// `execRemote` never rejects — SSH-level failures resolve as a nonzero `code`
// (255 for a connection failure, 127 if the local `ssh` binary is missing),
// same as a genuinely failed `test -d`. Only a clean `code === 1` means the
// worktree doesn't exist; a timeout or any other code is a transport/exec
// failure, not proof of absence, and must throw so it reaches reviveSession's
// outer try/catch (which marks the session offline) instead of being treated
// the same as a missing worktree — which would silently skip the hook
// reinstall while still letting the spawn below proceed once the connection
// recovers, defeating the point of this reinstall-on-revive change.
async function hasRemoteWorktree(host: Host, worktreePath: string): Promise<boolean> {
  const result = await execRemote(host, ['test', '-d', worktreePath], { timeoutMs: 10000 })
  if (result.timedOut) {
    throw new Error(`Timed out checking whether ${worktreePath} exists on host ${host.alias}`)
  }
  if (result.code === 0) return true
  if (result.code === 1) return false
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
  throw new Error(`Failed to check whether ${worktreePath} exists on host ${host.alias}: ${detail}`)
}

// Backfill / reconcile fields added in later versions. The reconciliation rules
// live in the pure `deriveSessionFields` decision core; here we resolve the one
// IO fact it needs — a local worktree's live git branch — and apply the result.
function backfillDerivedFields(session: Session): void {
  const resolvedLocalBranch =
    !session.hostId && existsSync(session.worktreePath)
      ? resolveBranchFromWorktree(session.worktreePath, session.worktreeName, session.projectName)
      : undefined
  const derived = deriveSessionFields(session, { resolvedLocalBranch })
  session.branch = derived.branch
  session.issueNumber = derived.issueNumber
  session.prNumber = derived.prNumber
  session.tool = derived.tool
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

      // Pure decision core: given the persisted status and local environment,
      // derive the restored status/connectionState. See restore-planner.ts.
      // The `existsSync` probe is guarded to local sessions — a remote worktree
      // path must never be stat'd on the host running the app.
      const derived = deriveRestoredState(session, {
        hasLiveTmux: liveTmuxIds.has(session.id),
        worktreeExists: !session.hostId && existsSync(session.worktreePath),
        tmuxAvailable,
      })
      session.status = derived.status
      session.connectionState = derived.connectionState
      if (derived.outcome === 'defer') deferredCount++
      if (derived.outcome === 'dead-no-tmux') skippedForNoTmux++

      if (session.hostId) {
        backfillDerivedFields(session)
        sessions.set(session.id, { session })
        continue
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
