import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join, resolve } from 'path'
import { copyFileSync, mkdirSync, chmodSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  getConfig,
  saveConfig,
  resolvePath,
  CONFIG_DIR,
  shouldWarnGitignore,
  markGitignoreWarned,
  type CanvasState,
} from './config'
import { scanProjects } from './project-scanner'
import { installHooks, isSettingsGitignored } from './hook-installer'
import { startHookServer, stopHookServer } from './hook-server'
import { createTray } from './tray'
import { registerWindow, broadcastToAll, safeSend } from './window-registry'
import {
  initPtyManager,
  stopPtyManager,
  writePty,
  resizePty,
  destroyPty,
  getScrollback,
  captureThumbnails,
} from './pty-manager'
import {
  initSessionManager,
  createSession,
  createSessionForWorktree,
  createRemoteSessionForWorktree,
  gitRemoteWorktrees,
  mirrorAllWorktrees,
  createPrSession,
  createPrSessions,
  openSessionsForOpenPrs,
  openSessionsForOpenIssues,
  getSession,
  getSessions,
  restoreSessions,
  killSession,
  reviveSession,
  reconnectRemoteSession,
  attachLocalSession,
  attachPendingLocalSessions,
  removeWorktree,
  removeSession,
  removeSessionsForHost,
  relocateProject,
  updateLastKnownStatesBatch,
  stopSessionManager,
} from './session-manager'
import { countOpenIssues, listRepoLabels, getRepoChoices } from './github-items'
import {
  collectReviewDiff,
  listReviewBranches,
  resolveReviewDefaultBranch,
  readTextFileUnderLimit,
  type GitRunner,
} from './review'
import { listHosts, addHost, updateHost, deleteHost, getHost } from './host-registry'
import {
  testConnection,
  validateRemoteRepo,
  stopAllHostConnections,
  stopHostConnection,
  setOnHostConnectionStopped,
} from './host-connection'
import { invalidateBootstrap } from './host-bootstrap'
import { clearSshLog } from './ssh-log-buffer'
import { stopHookServerForHost } from './hook-server'
import {
  listRemoteProjects,
  addRemoteProject as persistRemoteProject,
  removeRemoteProject,
  removeRemoteProjectsForHost,
  toProject as remoteToProject,
  validateRemotePath,
} from './remote-project-registry'
import type {
  CreateSessionOptions,
  DiffMode,
  ReviewBranchesResult,
  ReviewDefaultBranchResult,
  ReviewDiffResult,
  ValidateRemoteRepoReason,
} from '../shared/types'

const execFileAsync = promisify(execFile)

// Largest untracked file that gets synthesized into the review diff; bigger or
// binary files are skipped so the review view stays responsive.
const MAX_UNTRACKED_FILE_SIZE = 1_000_000

// A GitRunner (review.ts seam) bound to a session's worktree. The generous
// maxBuffer covers large diffs and long file/branch listings.
const reviewGit =
  (cwd: string): GitRunner =>
  (argv) =>
    execFileAsync('git', argv, { cwd, maxBuffer: 10_000_000 })

// Use native Wayland rendering when available (avoids Xwayland scaling artifacts)
app.commandLine.appendSwitch('ozone-platform-hint', 'auto')

// Chromium stores one value per switch key, so a plain appendSwitch on a
// feature-list flag overwrites whatever the user passed via argv. Merge our
// additions into the existing value so launch flags like
// `--disable-features=Foo` survive.
function mergeFeatureSwitch(
  name: 'enable-features' | 'disable-features',
  additions: string[]
): void {
  const existing = app.commandLine.getSwitchValue(name)
  const merged = new Set([...(existing ? existing.split(',').filter(Boolean) : []), ...additions])
  app.commandLine.appendSwitch(name, [...merged].join(','))
}

// Linux dual-GPU workaround: ANGLE/EGL initialization can fail inside AppImages
// or on systems with multiple GPUs (e.g. Intel iGPU + NVIDIA dGPU) because the
// bundled Chromium can't access the right driver libraries. If the user passed
// --disable-gpu on the command line, honour it; otherwise enable the Vulkan ANGLE
// backend which handles dual-GPU setups more reliably than the default EGL path.
if (process.platform === 'linux') {
  if (process.argv.includes('--disable-gpu')) {
    app.disableHardwareAcceleration()
  } else {
    // Vulkan ANGLE sidesteps EGL/GBM init failures on hybrid Intel+NVIDIA
    // laptops, but the Wayland ozone backend can't render Vulkan surfaces and
    // logs `--ozone-platform=wayland is not compatible with Vulkan`. Honour
    // an explicit `--ozone-platform=<value>` argv first so a user forcing X11
    // inside a Wayland login still gets the Vulkan workaround; otherwise
    // infer from the session env vars (the same signal `ozone-platform-hint
    // =auto` resolves against). Only request Vulkan on X11; on Wayland let
    // Chromium pick its default GL ANGLE backend.
    const ozoneArg = process.argv.find((a) => a.startsWith('--ozone-platform='))?.split('=')[1]
    const isWayland =
      ozoneArg === 'wayland' ||
      (ozoneArg !== 'x11' &&
        (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY))
    if (!isWayland) {
      app.commandLine.appendSwitch('use-angle', 'vulkan')
      mergeFeatureSwitch('enable-features', ['Vulkan'])
      // If Vulkan also fails, Chromium will fall back to SwiftShader automatically.
    }
  }

  // pewpew never plays video, but Chromium still tries to bring up VA-API
  // at startup. Inside AppImages the bundled libva can't load the host's
  // matching driver, producing a noisy `vaInitialize failed: unknown libva
  // error`. The feature-flag disable alone doesn't gate the probe in
  // vaapi_wrapper.cc, so also pass the switch-level flags that
  // short-circuit accelerated video init entirely.
  app.commandLine.appendSwitch('disable-accelerated-video-decode')
  app.commandLine.appendSwitch('disable-accelerated-video-encode')
  mergeFeatureSwitch('disable-features', [
    'VaapiVideoDecoder',
    'VaapiVideoEncoder',
    'VaapiVideoDecodeLinuxGL',
  ])
}

// Apply UI scale to the entire app (native menu bar + web content) before app is ready
const uiScale = getConfig().uiScale ?? 1.2
app.commandLine.appendSwitch('force-device-scale-factor', uiScale.toString())

function installBundledHookScripts(): void {
  const hooksDir = join(CONFIG_DIR, 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  for (const name of ['notify.sh', 'worktree-guard.sh']) {
    const src = join(__dirname, '../../hooks', name)
    const dest = join(hooksDir, name)
    copyFileSync(src, dest)
    chmodSync(dest, 0o755)
  }
}

// Tracks the last auto-reload per window so a renderer that crashes again right
// after we reload it doesn't get hammered into a tight reload loop.
const lastRendererReload = new WeakMap<BrowserWindow, number>()

// Recovers a window whose renderer process died (the "white window"). The main
// process owns the node-pty/tmux state, so a reload re-feeds the terminals from
// their buffers + tmux capture rather than losing the session.
function attachRendererCrashHandlers(win: BrowserWindow, label: string): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `[renderer] ${label} render process gone: reason=${details.reason} exitCode=${details.exitCode}`
    )
    if (details.reason === 'clean-exit' || win.isDestroyed()) return
    const now = Date.now()
    const prev = lastRendererReload.get(win) ?? 0
    if (now - prev < 5000) {
      console.error(
        `[renderer] ${label} crashed again within 5s of a reload; not auto-reloading to avoid a crash loop`
      )
      return
    }
    lastRendererReload.set(win, now)
    win.reload()
  })
  win.webContents.on('unresponsive', () => {
    console.error(`[renderer] ${label} renderer became unresponsive`)
  })
}

function createWindow(): BrowserWindow {
  const config = getConfig()
  const ws = config.windowState

  const mainWindow = new BrowserWindow({
    width: ws?.width ?? 1200,
    height: ws?.height ?? 800,
    x: ws?.x,
    y: ws?.y,
    title: 'pewpew',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Let Chromium throttle timers/rAF when the window is hidden. This is the
      // default, but pewpew is routinely left idle in the background, so make
      // the intent explicit (see issue #185).
      backgroundThrottling: true,
    },
  })

  if (ws?.maximized) {
    mainWindow.maximize()
  }

  mainWindow.on('close', () => {
    const bounds = mainWindow.getBounds()
    const maximized = mainWindow.isMaximized()
    const cfg = getConfig()
    cfg.windowState = { ...bounds, maximized }
    saveConfig(cfg)
  })

  attachRendererCrashHandlers(mainWindow, 'main')

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../../dist/index.html'))
  }

  return mainWindow
}

app.whenReady().then(async () => {
  if (process.env.ELECTRON_RENDERER_URL) {
    try {
      const { default: installExtension, REACT_DEVELOPER_TOOLS } =
        await import('electron-devtools-installer')
      await installExtension(REACT_DEVELOPER_TOOLS)
    } catch {
      // React DevTools install can fail in some environments
    }
  }

  installBundledHookScripts()

  ipcMain.handle('projects:scan', async () => {
    const config = getConfig()
    const dirs = config.scanDirs.map(resolvePath)
    const pinned = (config.pinnedPaths || []).map(resolvePath)
    const local = await scanProjects(dirs, pinned, config.followSymlinks, config.scanDepth)
    const remote = listRemoteProjects().map(remoteToProject)
    return [...local, ...remote].sort((a, b) => a.name.localeCompare(b.name))
  })

  ipcMain.handle('projects:pick-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('projects:relocate', async (_event, oldPath: string, newPath: string) => {
    return relocateProject(oldPath, newPath)
  })

  ipcMain.handle('projects:pin-path', async (_event, path: string) => {
    const config = getConfig()
    const resolved = resolve(path)
    if (!config.pinnedPaths.includes(resolved)) {
      config.pinnedPaths.push(resolved)
      saveConfig(config)
    }
  })

  ipcMain.handle('projects:add-remote', async (_event, input: { hostId: string; path: string }) => {
    const host = getHost(input.hostId)
    if (!host) throw new Error('Unknown host')
    // Normalize the path before the SSH probe so the remote check, dedup,
    // and persistence all see the same canonical form.
    const path = validateRemotePath(input.path)
    const result = await validateRemoteRepo(host.alias, path)
    if (!result.ok) {
      const labels: Record<ValidateRemoteRepoReason, string> = {
        'not-a-git-repo': 'Not a git repository',
        'auth-failed': 'Auth failed',
        network: 'Network error',
        'dep-missing': 'Missing dependency',
        unknown: 'ssh error',
      }
      const label = labels[result.reason ?? 'unknown']
      throw new Error(`${label}: ${result.message ?? 'unknown'}`)
    }
    return persistRemoteProject({
      hostId: input.hostId,
      path,
      repoFingerprint: result.fingerprint,
    })
  })

  ipcMain.handle('projects:remove-remote', async (_event, hostId: string, path: string) => {
    removeRemoteProject(hostId, path)
  })

  ipcMain.handle('projects:setup', async (_event, projectPath: string) => {
    await installHooks(projectPath)
  })

  ipcMain.handle('projects:create', async (_event, name: string) => {
    const config = getConfig()
    const dir = resolvePath(config.scanDirs[0] || '~/dev')
    const repoPath = join(dir, name)
    mkdirSync(repoPath, { recursive: true })
    await execFileAsync('git', ['init', repoPath])
  })

  ipcMain.handle('projects:open-file-manager', async (_event, path: string) => {
    await shell.openPath(path)
  })

  ipcMain.handle(
    'sessions:create',
    async (
      _event,
      projectPath: string,
      name?: string,
      hostId?: string | null,
      options?: CreateSessionOptions
    ) => {
      return createSession(projectPath, name, hostId ?? null, options ?? {})
    }
  )

  ipcMain.handle(
    'sessions:create-pr',
    async (
      _event,
      projectPath: string,
      prNumber: number,
      hostId?: string | null,
      options?: CreateSessionOptions
    ) => {
      return createPrSession(projectPath, prNumber, hostId ?? null, options ?? {})
    }
  )

  ipcMain.handle(
    'sessions:create-prs',
    async (
      _event,
      projectPath: string,
      prNumbers: number[],
      hostId?: string | null,
      options?: CreateSessionOptions
    ) => {
      return createPrSessions(projectPath, prNumbers, hostId ?? null, options ?? {})
    }
  )

  ipcMain.handle(
    'sessions:open-all-prs',
    async (_event, projectPath: string, hostId?: string | null, repo?: string | null) => {
      return openSessionsForOpenPrs(projectPath, hostId ?? null, repo ?? null)
    }
  )

  ipcMain.handle(
    'sessions:open-all-issues',
    async (
      _event,
      projectPath: string,
      hostId?: string | null,
      label?: string | null,
      repo?: string | null
    ) => {
      return openSessionsForOpenIssues(
        projectPath,
        hostId ?? null,
        label ?? undefined,
        repo ?? null
      )
    }
  )

  ipcMain.handle(
    'sessions:count-open-issues',
    async (
      _event,
      projectPath: string,
      hostId?: string | null,
      label?: string | null,
      repo?: string | null
    ) => {
      return countOpenIssues(projectPath, hostId ?? null, label ?? undefined, {}, repo ?? null)
    }
  )

  ipcMain.handle(
    'repo:list-labels',
    async (_event, projectPath: string, hostId?: string | null, repo?: string | null) => {
      return listRepoLabels(projectPath, hostId ?? null, repo ?? null)
    }
  )

  ipcMain.handle('repo:choices', async (_event, projectPath: string, hostId?: string | null) => {
    return getRepoChoices(projectPath, hostId ?? null)
  })

  async function gitignoreWarning(
    projectPath: string,
    checkPaths: string[]
  ): Promise<'gitignore' | undefined> {
    if (!shouldWarnGitignore(projectPath) || checkPaths.length === 0) return undefined
    const ignored = await Promise.all(checkPaths.map(isSettingsGitignored))
    if (ignored.some((isIgnored) => !isIgnored)) {
      markGitignoreWarned(projectPath)
      return 'gitignore'
    }
    // All checked worktrees ignore the file. Leave the project un-warned so a
    // later mirror of a branch that doesn't ignore it can still surface the
    // prompt.
    return undefined
  }

  ipcMain.handle(
    'sessions:mirror',
    async (_event, projectPath: string, worktreePath: string, hostId?: string | null) => {
      if (hostId) {
        const session = await createRemoteSessionForWorktree(hostId, projectPath, worktreePath)
        // The gitignore warning inspects the local filesystem, which has no
        // bearing on a remote worktree — skip it.
        return { session, warning: undefined }
      }
      const session = await createSessionForWorktree(projectPath, worktreePath)
      const warning = await gitignoreWarning(projectPath, [session.worktreePath])
      return { session, warning }
    }
  )

  ipcMain.handle(
    'sessions:mirror-all',
    async (_event, projectPath: string, hostId?: string | null) => {
      const result = await mirrorAllWorktrees(projectPath, hostId)
      if (hostId) return { result, warning: undefined }
      const warning = await gitignoreWarning(
        projectPath,
        result.mirrored.map((s) => s.worktreePath)
      )
      return { result, warning }
    }
  )

  ipcMain.handle('projects:list-remote-worktrees', async (_event, hostId: string, path: string) => {
    const host = getHost(hostId)
    if (!host) throw new Error('Unknown host')
    return gitRemoteWorktrees(host, path)
  })

  ipcMain.handle('sessions:list', () => {
    return getSessions()
  })

  // Single-session handlers log and re-throw so the renderer can react (e.g.
  // DetailPane.handleRevive clears its "Reviving..." state on rejection).
  // Batch handlers below swallow per-session errors so one failure doesn't
  // abort a multi-select operation.
  ipcMain.handle('sessions:kill', async (_event, id: string) => {
    try {
      await killSession(id)
    } catch (err) {
      console.error(`Failed to kill session ${id}:`, err)
      throw err
    }
  })

  ipcMain.handle('sessions:revive', async (_event, id: string) => {
    try {
      await reviveSession(id)
    } catch (err) {
      console.error(`Failed to revive session ${id}:`, err)
      throw err
    }
  })

  ipcMain.handle('sessions:reconnect', async (_event, id: string) => {
    try {
      await reconnectRemoteSession(id)
    } catch (err) {
      console.error(`Failed to reconnect session ${id}:`, err)
      throw err
    }
  })

  ipcMain.handle('sessions:attach', async (_event, id: string) => {
    try {
      await attachLocalSession(id)
    } catch (err) {
      console.error(`Failed to attach session ${id}:`, err)
      throw err
    }
  })

  ipcMain.handle('sessions:remove-worktree', async (_event, id: string) => {
    await removeWorktree(id)
  })

  ipcMain.handle('sessions:remove', async (_event, id: string) => {
    try {
      await removeSession(id)
    } catch (err) {
      console.error(`Failed to remove session ${id}:`, err)
      throw err
    }
  })

  ipcMain.handle('sessions:kill-batch', async (_event, ids: string[]) => {
    await Promise.all(
      ids.map(async (id) => {
        try {
          await killSession(id)
        } catch (err) {
          console.error(`Failed to kill session ${id}:`, err)
        }
      })
    )
  })

  ipcMain.handle('sessions:revive-batch', async (_event, ids: string[]) => {
    await Promise.all(
      ids.map(async (id) => {
        try {
          await reviveSession(id)
        } catch (err) {
          console.error(`Failed to revive session ${id}:`, err)
        }
      })
    )
  })

  ipcMain.handle('sessions:remove-batch', async (_event, ids: string[]) => {
    await Promise.all(
      ids.map(async (id) => {
        try {
          await removeSession(id)
        } catch (err) {
          console.error(`Failed to remove session ${id}:`, err)
        }
      })
    )
  })

  ipcMain.handle('pty:write', (_event, sessionId: string, data: string) => {
    writePty(sessionId, data)
  })

  ipcMain.handle('pty:write-batch', async (_event, ids: string[], data: string) => {
    await attachPendingLocalSessions(ids)
    for (const id of ids) writePty(id, data)
  })

  ipcMain.handle('pty:resize', (_event, sessionId: string, cols: number, rows: number) => {
    resizePty(sessionId, cols, rows)
  })

  ipcMain.handle('pty:destroy', (_event, sessionId: string) => {
    destroyPty(sessionId)
  })

  ipcMain.handle('pty:scrollback', (_event, sessionId: string) => {
    return getScrollback(sessionId)
  })

  ipcMain.handle(
    'review:get-diff',
    async (
      _event,
      sessionId: string,
      mode: DiffMode,
      baseBranch?: string
    ): Promise<ReviewDiffResult> => {
      const session = getSession(sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)
      if (session.hostId != null) {
        return { ok: false, reason: 'remote-unsupported' }
      }
      const cwd = session.worktreePath || session.projectPath
      const files = await collectReviewDiff(reviewGit(cwd), mode, baseBranch, (relativePath) =>
        readTextFileUnderLimit(join(cwd, relativePath), MAX_UNTRACKED_FILE_SIZE)
      )
      return { ok: true, files }
    }
  )

  ipcMain.handle(
    'review:list-branches',
    async (_event, sessionId: string): Promise<ReviewBranchesResult> => {
      const session = getSession(sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)
      if (session.hostId != null) {
        return { ok: false, reason: 'remote-unsupported' }
      }
      const cwd = session.worktreePath || session.projectPath
      return { ok: true, branches: await listReviewBranches(reviewGit(cwd)) }
    }
  )

  ipcMain.handle(
    'review:get-default-branch',
    async (_event, sessionId: string): Promise<ReviewDefaultBranchResult> => {
      const session = getSession(sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)
      if (session.hostId != null) {
        return { ok: false, reason: 'remote-unsupported' }
      }
      const cwd = session.worktreePath || session.projectPath
      return { ok: true, branch: await resolveReviewDefaultBranch(reviewGit(cwd)) }
    }
  )

  ipcMain.handle('config:get-canvas', () => {
    return getConfig().canvas
  })

  ipcMain.handle('config:save-canvas', (_event, canvas: CanvasState) => {
    const config = getConfig()
    config.canvas = canvas
    saveConfig(config)
  })

  ipcMain.handle('config:get-clusters', () => {
    return getConfig().clusterPositions
  })

  ipcMain.handle(
    'config:save-clusters',
    (_event, positions: Record<string, { x: number; y: number }>) => {
      const config = getConfig()
      config.clusterPositions = positions
      saveConfig(config)
    }
  )

  ipcMain.handle('config:get-sidebar-width', () => {
    return getConfig().sidebarWidth
  })

  ipcMain.handle('config:save-sidebar-width', (_event, width: number) => {
    const config = getConfig()
    config.sidebarWidth = width
    saveConfig(config)
  })

  ipcMain.handle('config:get-ui-scale', () => {
    return getConfig().uiScale
  })

  ipcMain.handle('config:get-default-tool', () => {
    return getConfig().defaultTool
  })

  ipcMain.handle('config:get-bulk-open-confirm-threshold', () => {
    return getConfig().bulkOpenConfirmThreshold
  })

  ipcMain.handle('config:get-worktree-base', () => {
    return getConfig().worktreeBase
  })

  ipcMain.handle('config:get-theme', () => {
    return getConfig().theme
  })

  ipcMain.handle('config:save-theme', (_event, theme: 'dark' | 'light') => {
    const config = getConfig()
    config.theme = theme
    saveConfig(config)
    // Broadcast to every renderer so secondary windows (Swim Lanes etc.)
    // pick up the new theme without needing to reload. The sender no-ops
    // on its own broadcast because state.theme already matches.
    for (const win of BrowserWindow.getAllWindows()) {
      safeSend(win, 'theme:changed', theme)
    }
  })

  ipcMain.handle('config:get-reduce-animations', () => {
    return getConfig().reduceAnimations
  })

  ipcMain.handle('config:save-reduce-animations', (_event, reduce: boolean) => {
    const config = getConfig()
    config.reduceAnimations = reduce
    saveConfig(config)
    // Broadcast to every renderer so secondary windows (Swim Lanes etc.)
    // pick up the change without a reload.
    for (const win of BrowserWindow.getAllWindows()) {
      safeSend(win, 'reduce-animations:changed', reduce)
    }
  })

  ipcMain.handle('swim-lanes:open', (_event, sessionIds: string[]) => {
    const swimWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      title: `pewpew — Swimming Lanes (${sessionIds.length})`,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: true,
      },
    })

    registerWindow(swimWindow)
    attachRendererCrashHandlers(swimWindow, 'swim-lanes')

    const query = `?sessions=${sessionIds.join(',')}`
    if (process.env.ELECTRON_RENDERER_URL) {
      swimWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/swim-lanes.html${query}`)
    } else {
      swimWindow.loadFile(join(__dirname, '../../dist/swim-lanes.html'), { search: query })
    }
  })

  ipcMain.handle('hosts:list', () => listHosts())
  ipcMain.handle('hosts:add', (_event, alias: string, label: string) => addHost({ alias, label }))
  ipcMain.handle('hosts:update', async (_event, hostId: string, alias: string, label: string) => {
    const previous = getHost(hostId)
    const updated = updateHost(hostId, { alias, label })
    if (previous && previous.alias !== alias) {
      invalidateBootstrap(hostId)
      await stopHostConnection(hostId).catch(() => undefined)
    }
    return updated
  })
  // Local-only forget cascade for issue #14. Order matters:
  //   1. Detach PTYs and drop sessions for the host. detachPty releases the
  //      host-connection refcount; if refs hit zero this synchronously runs
  //      stopHostConnection (which then fires the setOnHostConnectionStopped
  //      callback to close the per-host hook listener).
  //   2. stopHostConnection — idempotent if step 1 already tore it down.
  //      Inside: ssh -O exit closes the -R reverse forward FIRST, then the
  //      ControlPath socket is unlinked, then onConnectionStopped fires
  //      stopHookServerForHost. That ordering is what the AC's
  //      "-R forward gone before any StreamLocalBindUnlink race" requires.
  //   3. stopHookServerForHost — explicit belt-and-braces for the offline
  //      path (no runtime → no callback fires); idempotent otherwise.
  //   4. Drop bootstrap cache, remote projects, and finally the host itself.
  // Remote tmux/worktrees and the remote ~/.config/pewpew/ are untouched.
  ipcMain.handle('hosts:delete', async (_event, hostId: string) => {
    removeSessionsForHost(hostId)
    await stopHostConnection(hostId).catch(() => undefined)
    stopHookServerForHost(hostId)
    invalidateBootstrap(hostId)
    clearSshLog(hostId)
    removeRemoteProjectsForHost(hostId)
    deleteHost(hostId)
  })
  ipcMain.handle('hosts:test-connection', async (_event, hostId: string) => {
    const host = getHost(hostId)
    if (!host) throw new Error('Unknown host')
    return testConnection(host.alias)
  })

  const mainWindow = createWindow()
  registerWindow(mainWindow, true)
  startHookServer()
  // Tear down the per-host hook listener whenever its SSH control connection
  // goes away, so long-running apps that cycle through many hosts don't
  // accumulate idle Unix-socket servers and ipc-<hostId>.sock files.
  setOnHostConnectionStopped((hostId) => stopHookServerForHost(hostId))
  initSessionManager()
  createTray()
  initPtyManager()
  restoreSessions()

  // Periodic text thumbnail capture from tmux.
  // Also snapshots `lastKnownState` from every live PTY buffer (local + remote)
  // so a remote session's cached preview survives the next app restart without
  // any new SSH traffic (issue #12 AC #1 / #9). The batch helper applies the
  // 10s per-session rate limit and emits a single persist + broadcast per
  // tick, avoiding an O(N) write storm when many sessions unlock the window
  // simultaneously.
  // Ticks run independently — no in-flight guard. Per-call timeoutMs in
  // captureRemotePaneTexts caps each tick at ~3 s, so at most two ticks
  // overlap at the 3 s/3 s boundary (the slow ssh from the previous tick is
  // still waiting on its timeout while the next tick fans out fresh
  // captures). updateLastKnownStatesBatch is sync with a 10 s per-session
  // rate limit + identical-text dedup, so two concurrent persists are safe.
  // Gating the next tick on the slowest exec would have re-introduced the
  // 6 s update cadence that the per-session onCapture broadcast was meant
  // to fix.
  const thumbInterval = setInterval(() => {
    void (async () => {
      const captured = await captureThumbnails({
        // Broadcast each thumbnail the instant its capture lands so a wedged
        // remote session timing out at the 3 s cap can't delay healthy
        // siblings' updates.
        onCapture: (sessionId, text) =>
          broadcastToAll('thumbnails:text-updated', { [sessionId]: text }),
      })
      // Persist directly from the captured Record. The Record is a snapshot
      // of capture-pane text at capture time, so it can't race the live PTY
      // stream.
      const updates = Object.entries(captured).map(([id, text]) => ({ id, text }))
      if (updates.length > 0) updateLastKnownStatesBatch(updates)
    })().catch((err) => {
      console.error('thumbnail tick failed:', err)
    })
  }, 3000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createWindow()
      registerWindow(win, true)
    }
  })

  // before-quit fires synchronously; Electron won't wait for async work unless
  // we preventDefault. Pattern: first fire → preventDefault, run teardown,
  // app.quit() re-enters and we let it through.
  let teardownStarted = false
  app.on('before-quit', (event) => {
    if (teardownStarted) return
    teardownStarted = true
    event.preventDefault()
    clearInterval(thumbInterval)
    stopPtyManager()
    stopSessionManager()
    stopHookServer()
    void (async () => {
      // Bound teardown so an unreachable host can't wedge shutdown.
      await Promise.race([
        stopAllHostConnections().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ])
      app.quit()
    })()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
