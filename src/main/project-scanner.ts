import { readdirSync, existsSync, readFileSync, statSync, lstatSync, realpathSync } from 'fs'
import { join, basename } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Project, Worktree } from '../shared/types'

const execFileAsync = promisify(execFile)

async function gitBranches(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'branch', '--list'], {
      timeout: 5000,
    })
    return stdout.split('\n').flatMap((line) => {
      const branch = line.replace(/^\*?\s+/, '').trim()
      return branch ? [branch] : []
    })
  } catch {
    return []
  }
}

export function parseWorktreeList(
  stdout: string,
  baseName: (p: string) => string = basename
): Worktree[] {
  const worktrees: Worktree[] = []
  const blocks = stdout.split('\n\n').filter(Boolean)

  for (const block of blocks) {
    const lines = block.split('\n')
    let path = ''
    let branch = ''

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length)
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch refs/heads/'.length)
      }
    }

    if (path) {
      worktrees.push({
        name: baseName(path),
        path,
        branch: branch || 'HEAD',
        isMain: worktrees.length === 0,
      })
    }
  }

  return worktrees
}

export async function gitWorktrees(repoPath: string): Promise<Worktree[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'worktree', 'list', '--porcelain'],
      { timeout: 5000 }
    )
    return parseWorktreeList(stdout)
  } catch {
    return []
  }
}

export function detectSetupState(repoPath: string): 'ready' | 'unsetup' {
  const settingsPath = join(repoPath, '.claude', 'settings.local.json')
  if (!existsSync(settingsPath)) return 'unsetup'

  try {
    const raw = readFileSync(settingsPath, 'utf-8')
    const content = JSON.stringify(JSON.parse(raw))
    return content.includes('/pewpew/hooks/') ? 'ready' : 'unsetup'
  } catch {
    return 'unsetup'
  }
}

const EXCLUDED_DIR_NAMES = new Set(['node_modules'])

function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

export function discoverRepos(
  scanDirs: string[],
  pinnedPaths: string[],
  followSymlinks: boolean,
  maxDepth: number
): { name: string; path: string }[] {
  const depth = Math.max(1, Math.min(6, maxDepth))
  const repos: { name: string; path: string }[] = []
  const seen = new Set<string>()

  function walk(dir: string, currentDepth: number): void {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }

    for (const entry of entries) {
      const entryPath = join(dir, entry)

      try {
        if (!followSymlinks && lstatSync(entryPath).isSymbolicLink()) continue
        if (!statSync(entryPath).isDirectory()) continue
      } catch {
        continue
      }

      const realPath = followSymlinks ? safeRealpath(entryPath) : entryPath
      if (realPath === null) continue
      if (seen.has(realPath)) continue
      seen.add(realPath)

      if (existsSync(join(entryPath, '.git'))) {
        repos.push({ name: entry, path: entryPath })
        continue
      }

      if (currentDepth < depth && !entry.startsWith('.') && !EXCLUDED_DIR_NAMES.has(entry)) {
        walk(entryPath, currentDepth + 1)
      }
    }
  }

  for (const dir of scanDirs) {
    if (!existsSync(dir)) continue
    walk(dir, 1)
  }

  for (const pinned of pinnedPaths) {
    const realPinned = followSymlinks ? safeRealpath(pinned) : pinned
    if (realPinned === null) continue
    if (seen.has(realPinned)) continue
    try {
      if (!followSymlinks && lstatSync(pinned).isSymbolicLink()) continue
      if (!statSync(pinned).isDirectory()) continue
    } catch {
      continue
    }
    if (!existsSync(join(pinned, '.git'))) continue
    repos.push({ name: basename(pinned), path: pinned })
    seen.add(realPinned)
  }

  return repos.sort((a, b) => a.name.localeCompare(b.name))
}

async function enrichRepo(repo: { name: string; path: string }): Promise<Project> {
  const [branches, worktrees] = await Promise.all([gitBranches(repo.path), gitWorktrees(repo.path)])

  return {
    name: repo.name,
    path: repo.path,
    branches,
    worktrees,
    setupState: detectSetupState(repo.path),
    hostId: null,
  }
}

const CONCURRENCY = 10

export async function getRepoFingerprint(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-list', '--max-parents=0', 'HEAD'],
      { timeout: 5000 }
    )
    const firstLine = stdout.trim().split('\n')[0]
    return firstLine || undefined
  } catch {
    return undefined
  }
}

export async function scanProjects(
  scanDirs: string[],
  pinnedPaths?: string[],
  followSymlinks?: boolean,
  scanDepth?: number
): Promise<Project[]> {
  const repos = discoverRepos(scanDirs, pinnedPaths || [], followSymlinks ?? true, scanDepth ?? 3)
  const projects: Project[] = []

  async function enrichBatch(start: number): Promise<void> {
    if (start >= repos.length) return
    const batch = repos.slice(start, start + CONCURRENCY)
    const results = await Promise.all(batch.map(enrichRepo))
    projects.push(...results)
    await enrichBatch(start + CONCURRENCY)
  }

  // Process in batches to avoid spawning hundreds of git processes.
  await enrichBatch(0)

  return projects.sort((a, b) => a.name.localeCompare(b.name))
}
