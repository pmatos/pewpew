import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { AgentTool, Host, RemoteProject, Theme, WorktreeBase } from '../shared/types'

export interface CanvasState {
  zoom: number
  panX: number
  panY: number
}

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export interface ReconnectConfig {
  enabled: boolean
  initialDelayMs: number
  maxDelayMs: number
}

export interface SandboxConfig {
  enabled: boolean
  // Extra paths re-opened for write access inside the bwrap sandbox, on top
  // of the session worktree and the agent state dir. The sandbox mounts the
  // host read-only by default (--ro-bind / /), so this is the only way a
  // session regains write access to a host path outside its worktree, e.g.
  // a shared build cache. Entries that equal, nest under, or are an
  // ancestor of the project root are dropped instead (they would re-open
  // the project read-write — see agent-sandbox.ts), and missing sources are
  // tolerated via --bind-try. `~/` prefixes are resolved against the local
  // home directory before use, so this has no effect on remote sessions (a
  // remote host's home directory can't be resolved locally).
  extraWritablePaths: string[]
}

export interface AppConfig {
  scanDirs: string[]
  pinnedPaths: string[]
  followSymlinks: boolean
  scanDepth: number
  canvas: CanvasState
  clusterPositions: Record<string, { x: number; y: number }>
  windowState?: WindowState
  sidebarWidth: number
  uiScale: number
  hosts: Host[]
  gitignoreWarned: string[]
  remoteProjects: RemoteProject[]
  defaultTool: AgentTool
  worktreeBase: WorktreeBase
  theme: Theme
  reduceAnimations: boolean
  bulkOpenConfirmThreshold: number
  reconnect: ReconnectConfig
  sandbox: SandboxConfig
}

export const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'pewpew')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

const DEFAULT_CONFIG: AppConfig = {
  scanDirs: ['~/dev'],
  pinnedPaths: [],
  followSymlinks: true,
  scanDepth: 3,
  canvas: { zoom: 0.7, panX: 0, panY: 0 },
  clusterPositions: {},
  sidebarWidth: 250,
  uiScale: 1.2,
  hosts: [],
  gitignoreWarned: [],
  remoteProjects: [],
  defaultTool: 'claude',
  worktreeBase: 'local',
  theme: 'dark',
  reduceAnimations: false,
  bulkOpenConfirmThreshold: 20,
  reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 30000 },
  sandbox: { enabled: true, extraWritablePaths: [] },
}

export function shouldWarnGitignore(projectPath: string): boolean {
  return !getConfig().gitignoreWarned.includes(projectPath)
}

export function markGitignoreWarned(projectPath: string): void {
  const config = getConfig()
  if (config.gitignoreWarned.includes(projectPath)) return
  config.gitignoreWarned = [...config.gitignoreWarned, projectPath]
  saveConfig(config)
}

export function resolvePath(p: string): string {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2))
  }
  return p
}

export function getConfig(): AppConfig {
  mkdirSync(CONFIG_DIR, { recursive: true })

  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2))
    return DEFAULT_CONFIG
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8')
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_CONFIG
  }
}

// getConfig is a shallow merge over DEFAULT_CONFIG, so a hand-edited partial
// `reconnect` object in config.json would clobber the sibling defaults. Fill
// per-field so the scheduler never sees an undefined tunable.
export function getReconnectConfig(): ReconnectConfig {
  return { ...DEFAULT_CONFIG.reconnect, ...(getConfig().reconnect ?? {}) }
}

export function getSandboxConfig(): SandboxConfig {
  return { ...DEFAULT_CONFIG.sandbox, ...(getConfig().sandbox ?? {}) }
}

export function saveConfig(config: AppConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}
