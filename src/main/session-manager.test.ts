import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, RemoteProject, Session, WorktreeBase } from '../shared/types'

// Hoisted state so vi.mock factories can reach mutable per-test values before
// the SUT imports run.
const state = vi.hoisted(() => ({
  configDir: '',
  liveTmuxIds: [] as string[],
  tmuxAvailable: true,
  repoFingerprint: undefined as string | undefined,
  hosts: [] as Host[],
  remoteProjects: [] as RemoteProject[],
  worktreeBase: 'local' as WorktreeBase,
  runtimeStates: new Map<string, string>(),
  // Call logs for assertion.
  ensureHostConnectionCalls: [] as string[],
  createRemotePtyCalls: [] as { sessionId: string; cwd: string; hostId: string }[],
  reattachRemotePtyCalls: [] as { sessionId: string; hostId: string }[],
  createPtyCalls: [] as { sessionId: string; cwd: string }[],
  reattachPtyCalls: [] as string[],
  detachPtyCalls: [] as string[],
  hasRemoteTmuxResult: new Map<string, boolean>(),
  probeRemoteTmuxResult: new Map<string, 'present' | 'absent' | 'unreachable'>(),
  // Captures the listener registered via setUnexpectedExitListener so tests
  // can invoke it synchronously without spinning up a real node-pty.
  unexpectedExitListener: null as null | ((sessionId: string) => void),
  // Per-session side effect fired before the probe resolves. Lets tests
  // simulate a concurrent reconnect advancing another session's state while
  // the batch is in flight.
  probeSideEffect: new Map<string, () => void>(),
  runtimeRefs: new Map<string, number>(),
  sessionsUpdatedBroadcasts: 0,
  execRemoteCalls: [] as { hostId: string; argv: string[] }[],
  execRemoteResults: new Map<
    string,
    { stdout: string; stderr: string; code: number; timedOut: boolean }
  >(),
  // Toggle to simulate ensureHostConnection throwing.
  ensureHostConnectionThrows: null as null | { message: string; runtimeStateAfter: string },
  // When set, delays next ensureHostConnection resolution (used for idempotency
  // and cascade tests).
  ensureHostConnectionGate: null as null | Promise<void>,
}))

vi.mock('./config', () => ({
  get CONFIG_DIR() {
    return state.configDir
  },
  getConfig: () => ({
    scanDirs: [],
    pinnedPaths: [],
    followSymlinks: true,
    canvas: { zoom: 1, panX: 0, panY: 0 },
    clusterPositions: {},
    sidebarWidth: 250,
    uiScale: 1,
    hosts: state.hosts,
    remoteProjects: [],
    defaultTool: 'claude',
    worktreeBase: state.worktreeBase,
  }),
  saveConfig: vi.fn(),
}))

vi.mock('./window-registry', () => ({
  broadcastToAll: (channel: string) => {
    if (channel === 'sessions:updated') state.sessionsUpdatedBroadcasts++
  },
  getMainWindow: () => null,
}))

vi.mock('./tray', () => ({
  updateTray: vi.fn(),
  createTray: vi.fn(),
}))

vi.mock('./notifications', () => ({
  notifyNeedsInput: vi.fn(),
  emitToast: vi.fn(),
}))

vi.mock('electron', () => ({
  dialog: {
    showMessageBox: async () => ({ response: 1 }),
  },
  shell: {
    openPath: async () => '',
  },
}))

vi.mock('./project-scanner', () => ({
  getRepoFingerprint: vi.fn(async () => state.repoFingerprint),
  gitWorktrees: vi.fn(async () => []),
}))

vi.mock('./hook-installer', () => ({
  installHooks: vi.fn(async () => undefined),
  installRemoteHooks: vi.fn(async () => undefined),
}))

vi.mock('./host-registry', () => ({
  getHost: (hostId: string) => state.hosts.find((h) => h.hostId === hostId),
  setHostAgentPaths: vi.fn(),
}))

vi.mock('./remote-project-registry', () => ({
  listRemoteProjects: () => state.remoteProjects,
}))

vi.mock('./hook-server', () => ({
  listenHookServerForHost: (hostId: string) => `/tmp/pewpew-ipc-${hostId}.sock`,
}))

vi.mock('./host-bootstrap', () => ({
  HostBootstrapError: class HostBootstrapError extends Error {
    kind: string
    missingDeps: string[]

    constructor(kind: string, message: string, missingDeps: string[] = []) {
      super(message)
      this.kind = kind
      this.missingDeps = missingDeps
    }
  },
  bootstrapHost: vi.fn(async () => ({
    notifyScriptPath: '/tmp/notify-v1.sh',
    agentPaths: { claude: '/r/bin/claude', codex: '/r/bin/codex' },
  })),
}))

vi.mock('./pty-manager', () => ({
  createPty: (sessionId: string, cwd: string) => {
    state.createPtyCalls.push({ sessionId, cwd })
  },
  detachPty: (sessionId: string) => {
    state.detachPtyCalls.push(sessionId)
  },
  destroyPty: vi.fn(),
  destroyRemotePty: vi.fn(async () => undefined),
  hasPty: vi.fn(() => false),
  hasTmuxSession: vi.fn(() => false),
  hasRemoteTmuxSession: vi.fn(async (sessionId: string) => {
    return state.hasRemoteTmuxResult.get(sessionId) ?? false
  }),
  probeRemoteTmuxSession: vi.fn(async (sessionId: string) => {
    const effect = state.probeSideEffect.get(sessionId)
    if (effect) effect()
    const explicit = state.probeRemoteTmuxResult.get(sessionId)
    if (explicit) return explicit
    // Back-compat for tests written against hasRemoteTmuxResult: true →
    // present, false → absent. Tests that need 'unreachable' set it via
    // probeRemoteTmuxResult directly.
    return state.hasRemoteTmuxResult.get(sessionId) ? 'present' : 'absent'
  }),
  isTmuxAvailable: () => state.tmuxAvailable,
  discoverTmuxSessions: () => [...state.liveTmuxIds],
  reattachPty: (sessionId: string) => {
    state.reattachPtyCalls.push(sessionId)
  },
  reattachRemotePty: async (sessionId: string, host: Host) => {
    state.reattachRemotePtyCalls.push({ sessionId, hostId: host.hostId })
    // Match production: reattachRemotePty retains the host runtime for the
    // PTY's lifetime so the runtime survives the caller's release.
    state.runtimeRefs.set(host.hostId, (state.runtimeRefs.get(host.hostId) ?? 0) + 1)
  },
  createRemotePty: async (sessionId: string, cwd: string, host: Host) => {
    state.createRemotePtyCalls.push({ sessionId, cwd, hostId: host.hostId })
    state.runtimeRefs.set(host.hostId, (state.runtimeRefs.get(host.hostId) ?? 0) + 1)
  },
  setUnexpectedExitListener: (fn: null | ((sessionId: string) => void)) => {
    state.unexpectedExitListener = fn
  },
}))

vi.mock('./host-connection', () => ({
  ensureHostConnection: async (host: Host) => {
    state.ensureHostConnectionCalls.push(host.hostId)
    if (state.ensureHostConnectionGate) await state.ensureHostConnectionGate
    if (state.ensureHostConnectionThrows) {
      const stateAfter = state.ensureHostConnectionThrows.runtimeStateAfter
      state.runtimeStates.set(host.hostId, stateAfter)
      throw new Error(state.ensureHostConnectionThrows.message)
    }
    state.runtimeStates.set(host.hostId, 'live')
    return { remoteSocketPath: '/tmp/remote.sock', controlPath: '/tmp/cm.sock' }
  },
  exec: async (hostOrAlias: Host | string, argv: string[]) => {
    const hostId = typeof hostOrAlias === 'string' ? hostOrAlias : hostOrAlias.hostId
    state.execRemoteCalls.push({ hostId, argv })
    const configured = state.execRemoteResults.get(argv.join(' '))
    if (configured) return configured
    return { stdout: '', stderr: '', code: 0, timedOut: false }
  },
  retainHostConnection: vi.fn((hostId: string) => {
    state.runtimeRefs.set(hostId, (state.runtimeRefs.get(hostId) ?? 0) + 1)
  }),
  // Match production: releaseHostConnection decrements refcount; on zero it
  // delegates to stopHostConnection which wipes the runtime entry. That delete
  // is what makes the sibling-batch cascade dependent on a state hint
  // captured BEFORE the release.
  releaseHostConnection: vi.fn(async (hostId: string) => {
    const refs = (state.runtimeRefs.get(hostId) ?? 0) - 1
    if (refs <= 0) {
      state.runtimeRefs.delete(hostId)
      state.runtimeStates.delete(hostId)
    } else {
      state.runtimeRefs.set(hostId, refs)
    }
  }),
  stopHostConnection: vi.fn(async (hostId: string) => {
    state.runtimeRefs.delete(hostId)
    state.runtimeStates.delete(hostId)
  }),
  runtimeStateFor: (hostId: string) => state.runtimeStates.get(hostId),
  classifyConnectionFailure: (_code: number | null, _stderr: string) => 'offline',
  startBootstrapWindow: () => () => {},
}))

// Import SUT after all mocks are registered.
async function loadSessionManager(): Promise<typeof import('./session-manager')> {
  vi.resetModules()
  return import('./session-manager')
}

function writeSessionsJson(sessions: Partial<Session>[]): void {
  writeFileSync(join(state.configDir, 'sessions.json'), JSON.stringify(sessions))
}

function baseRemoteSession(overrides: Partial<Session>): Session {
  return {
    id: 'r1',
    hostId: 'h1',
    projectPath: '/remote/proj',
    projectName: 'proj',
    worktreeName: 'feat',
    worktreePath: '/remote/proj/.claude/worktrees/feat',
    branch: 'pewpew/feat',
    pid: 0,
    tmuxSession: 'pewpew-r1',
    status: 'idle',
    lastActivity: 1000,
    hookEvents: [],
    tool: 'claude',
    ...overrides,
  }
}

function baseLocalSession(overrides: Partial<Session>): Session {
  return {
    id: 'l1',
    hostId: null,
    projectPath: '/local/proj',
    projectName: 'proj',
    worktreeName: 'local-feat',
    worktreePath: join(state.configDir, 'local-wt'),
    branch: 'pewpew/local-feat',
    pid: 0,
    tmuxSession: 'pewpew-l1',
    status: 'idle',
    lastActivity: 1000,
    hookEvents: [],
    tool: 'claude',
    ...overrides,
  }
}

const canRunGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

beforeEach(() => {
  state.configDir = mkdtempSync(join(tmpdir(), 'sess-mgr-'))
  state.liveTmuxIds = []
  state.tmuxAvailable = true
  state.repoFingerprint = undefined
  state.hosts = [{ hostId: 'h1', alias: 'devbox', label: 'Dev' }]
  state.remoteProjects = []
  state.worktreeBase = 'local'
  state.runtimeStates = new Map()
  state.ensureHostConnectionCalls = []
  state.createRemotePtyCalls = []
  state.reattachRemotePtyCalls = []
  state.createPtyCalls = []
  state.reattachPtyCalls = []
  state.detachPtyCalls = []
  state.hasRemoteTmuxResult = new Map()
  state.probeRemoteTmuxResult = new Map()
  state.runtimeRefs = new Map()
  state.sessionsUpdatedBroadcasts = 0
  state.probeSideEffect = new Map()
  state.execRemoteCalls = []
  state.execRemoteResults = new Map()
  state.ensureHostConnectionThrows = null
  state.ensureHostConnectionGate = null
  state.unexpectedExitListener = null
})

afterEach(() => {
  rmSync(state.configDir, { recursive: true, force: true })
})

describe('resolveOriginDefaultBase', () => {
  function fakeGitRunner(script: Record<string, string | Error>) {
    return async (argv: string[]) => {
      const key = argv.join(' ')
      const result = script[key]
      if (result === undefined) throw new Error(`unexpected git ${key}`)
      if (result instanceof Error) throw result
      return { stdout: result }
    }
  }

  it('returns origin/HEAD when symbolic-ref resolves and validates', async () => {
    const sm = await loadSessionManager()

    await expect(
      sm.resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': '',
          'ls-remote --symref origin HEAD': new Error('unavailable'),
          'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n',
          'rev-parse --verify refs/remotes/origin/main': 'abc123\n',
        })
      )
    ).resolves.toBe('refs/remotes/origin/main')
  })

  it('prefers ls-remote default branch over stale local origin/HEAD', async () => {
    const sm = await loadSessionManager()

    await expect(
      sm.resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': '',
          'ls-remote --symref origin HEAD': 'ref: refs/heads/develop\tHEAD\nabc123\tHEAD\n',
          'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n',
          'rev-parse --verify refs/remotes/origin/develop': 'abc123\n',
          'rev-parse --verify refs/remotes/origin/main': 'def456\n',
        })
      )
    ).resolves.toBe('refs/remotes/origin/develop')
  })

  it('validates fully qualified remote-tracking refs to avoid local branch ambiguity', async () => {
    const sm = await loadSessionManager()

    await expect(
      sm.resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': '',
          'ls-remote --symref origin HEAD': 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
          'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n',
          'rev-parse --verify refs/remotes/origin/main': 'abc123\n',
        })
      )
    ).resolves.toBe('refs/remotes/origin/main')
  })

  it('throws no-origin-remote when origin is missing', async () => {
    const sm = await loadSessionManager()

    await expect(
      sm.resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': new Error('No such remote'),
        })
      )
    ).rejects.toThrow(/^no-origin-remote$/)
  })

  it('adds context when fetch fails', async () => {
    const sm = await loadSessionManager()

    await expect(
      sm.resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': new Error('network down'),
        })
      )
    ).rejects.toThrow(/Failed to fetch origin: network down/)
  })

  it('falls back to origin/main when origin/HEAD is unset', async () => {
    const sm = await loadSessionManager()

    await expect(
      sm.resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': '',
          'ls-remote --symref origin HEAD': new Error('unset'),
          'symbolic-ref --short refs/remotes/origin/HEAD': new Error('unset'),
          'rev-parse --verify refs/remotes/origin/main': 'abc123\n',
        })
      )
    ).resolves.toBe('refs/remotes/origin/main')
  })

  it('uses ls-remote default branch when origin/HEAD is unset', async () => {
    const sm = await loadSessionManager()

    await expect(
      sm.resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': '',
          'ls-remote --symref origin HEAD': 'ref: refs/heads/develop\tHEAD\nabc123\tHEAD\n',
          'symbolic-ref --short refs/remotes/origin/HEAD': new Error('unset'),
          'rev-parse --verify refs/remotes/origin/develop': 'abc123\n',
        })
      )
    ).resolves.toBe('refs/remotes/origin/develop')
  })

  it('falls back to origin/master when origin/main is absent', async () => {
    const sm = await loadSessionManager()

    await expect(
      sm.resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': '',
          'ls-remote --symref origin HEAD': new Error('unset'),
          'symbolic-ref --short refs/remotes/origin/HEAD': new Error('unset'),
          'rev-parse --verify refs/remotes/origin/main': new Error('missing'),
          'rev-parse --verify refs/remotes/origin/master': 'abc123\n',
        })
      )
    ).resolves.toBe('refs/remotes/origin/master')
  })

  it('throws no-origin-default-branch when no candidate resolves', async () => {
    const sm = await loadSessionManager()

    await expect(
      sm.resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': '',
          'ls-remote --symref origin HEAD': new Error('unset'),
          'symbolic-ref --short refs/remotes/origin/HEAD': new Error('unset'),
          'rev-parse --verify refs/remotes/origin/main': new Error('missing'),
          'rev-parse --verify refs/remotes/origin/master': new Error('missing'),
        })
      )
    ).rejects.toThrow(/^no-origin-default-branch$/)
  })

  it('falls through when origin/HEAD points at a stale ref', async () => {
    const sm = await loadSessionManager()

    await expect(
      sm.resolveOriginDefaultBase(
        fakeGitRunner({
          'remote get-url origin': 'git@example.com:org/repo.git\n',
          'fetch origin --quiet': '',
          'ls-remote --symref origin HEAD': new Error('unset'),
          'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n',
          'rev-parse --verify refs/remotes/origin/main': new Error('stale'),
          'rev-parse --verify refs/remotes/origin/master': 'abc123\n',
        })
      )
    ).resolves.toBe('refs/remotes/origin/master')
  })
})

describe('createSession origin-default base', () => {
  const gitIt = canRunGit ? it : it.skip

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' })
  }

  function createProjectWithUpdatedOrigin(root: string): string {
    const source = join(root, 'source')
    const remote = join(root, 'remote.git')
    const project = join(root, 'project')
    mkdirSync(source)

    git(source, ['init'])
    git(source, ['config', 'user.email', 'test@example.com'])
    git(source, ['config', 'user.name', 'Test User'])
    writeFileSync(join(source, 'file.txt'), 'one\n')
    git(source, ['add', 'file.txt'])
    git(source, ['commit', '-m', 'one'])
    git(source, ['branch', '-M', 'main'])
    execFileSync('git', ['clone', '--bare', source, remote], { stdio: 'ignore' })
    execFileSync('git', ['clone', remote, project], { stdio: 'ignore' })

    git(source, ['remote', 'add', 'origin', remote])
    writeFileSync(join(source, 'file.txt'), 'two\n')
    git(source, ['commit', '-am', 'two'])
    git(source, ['push', 'origin', 'main'])
    mkdirSync(join(project, '.claude', 'worktrees'), { recursive: true })

    return project
  }

  gitIt('branches the new worktree from the fetched origin default branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'origin-base-'))
    try {
      const project = createProjectWithUpdatedOrigin(root)
      const sm = await loadSessionManager()
      const session = await sm.createSession(project, 'from-origin', null, {
        baseRef: 'origin-default',
      })

      const originTip = git(project, ['rev-parse', 'origin/main']).trim()
      const worktreeTip = git(session.worktreePath, ['rev-parse', 'HEAD']).trim()
      expect(worktreeTip).toBe(originTip)

      // The new branch must NOT track origin/main — pushes from this worktree
      // would otherwise overwrite origin/main instead of creating origin/<branch>.
      // `git rev-parse @{u}` exits non-zero when no upstream is configured.
      let upstreamRef = ''
      try {
        upstreamRef = execFileSync(
          'git',
          ['-C', session.worktreePath, 'rev-parse', '--abbrev-ref', '@{u}'],
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim()
      } catch {
        upstreamRef = ''
      }
      expect(upstreamRef).toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  gitIt('reuses an existing branch when origin-default session name is recreated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'origin-base-existing-'))
    try {
      const project = createProjectWithUpdatedOrigin(root)
      const branchName = 'project/from-origin'
      git(project, ['branch', branchName, 'origin/main'])

      const sm = await loadSessionManager()
      const session = await sm.createSession(project, 'from-origin', null, {
        baseRef: 'origin-default',
      })

      const branch = git(session.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
      expect(branch).toBe(branchName)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('retries remote origin-default worktree creation when the branch already exists', async () => {
    state.remoteProjects = [{ hostId: 'h1', path: '/remote/proj', name: 'proj' }]
    const branchName = 'proj/feat'
    const worktreePath = '/remote/proj/.claude/worktrees/feat'
    state.execRemoteResults.set(
      [
        'git',
        '-C',
        '/remote/proj',
        'worktree',
        'add',
        worktreePath,
        '--no-track',
        '-b',
        branchName,
        'refs/remotes/origin/main',
      ].join(' '),
      { stdout: '', stderr: 'fatal: a branch named already exists', code: 128, timedOut: false }
    )
    state.execRemoteResults.set(
      ['git', '-C', '/remote/proj', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'].join(
        ' '
      ),
      { stdout: 'origin/main\n', stderr: '', code: 0, timedOut: false }
    )
    state.execRemoteResults.set(
      ['git', '-C', '/remote/proj', 'rev-parse', '--verify', 'refs/heads/proj/feat'].join(' '),
      { stdout: 'abc123\n', stderr: '', code: 0, timedOut: false }
    )
    state.execRemoteResults.set(
      ['git', '-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'].join(' '),
      { stdout: `${branchName}\n`, stderr: '', code: 0, timedOut: false }
    )
    const sm = await loadSessionManager()

    const session = await sm.createSession('/remote/proj', 'feat', 'h1', {
      baseRef: 'origin-default',
    })

    expect(session.branch).toBe(branchName)
    expect(state.execRemoteCalls.map((c) => c.argv)).toContainEqual([
      'git',
      '-C',
      '/remote/proj',
      'worktree',
      'add',
      worktreePath,
      branchName,
    ])
  })
})

describe('restoreSessions — remote lazy materialization', () => {
  it('materializes remote sessions in pending state and opens no SSH', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    const got = sm.getSessions()
    expect(got).toHaveLength(1)
    expect(got[0].connectionState).toBe('pending')
    expect(got[0].status).toBe('idle')
    expect(state.ensureHostConnectionCalls).toEqual([])
    expect(state.createRemotePtyCalls).toEqual([])
    expect(state.reattachRemotePtyCalls).toEqual([])
  })

  it('round-trips lastKnownState across restore', async () => {
    writeSessionsJson([
      baseRemoteSession({
        id: 'r1',
        lastKnownState: { text: 'cached preview', timestamp: 42 },
      }),
    ])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    const got = sm.getSessions()[0]
    expect(got.lastKnownState).toEqual({ text: 'cached preview', timestamp: 42 })
  })

  it('normalizes remote running → idle (mid-session crash normalization)', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'running' })])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    expect(sm.getSessions()[0].status).toBe('idle')
    expect(sm.getSessions()[0].connectionState).toBe('pending')
  })

  it('preserves dead status and skips connectionState for confirmed-dead remote', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'dead' })])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    expect(sm.getSessions()[0].status).toBe('dead')
    expect(sm.getSessions()[0].connectionState).toBeUndefined()
  })

  it('preserves needs_input status on restore', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'needs_input' })])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    expect(sm.getSessions()[0].status).toBe('needs_input')
    expect(sm.getSessions()[0].connectionState).toBe('pending')
  })

  it('tolerates missing lastKnownState (fresh post-deploy restart)', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1' })])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    expect(sm.getSessions()[0].lastKnownState).toBeUndefined()
  })
})

describe('reconnectRemoteSession', () => {
  it('tmux present → reattach and mark live', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.hasRemoteTmuxResult.set('r1', true)
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reconnectRemoteSession('r1')

    const got = sm.getSessions()[0]
    expect(got.connectionState).toBe('live')
    expect(got.status).toBe('idle')
    expect(state.reattachRemotePtyCalls).toEqual([{ sessionId: 'r1', hostId: 'h1' }])
    expect(state.createRemotePtyCalls).toEqual([])
  })

  it('tmux gone → mark session dead without creating new PTY', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.hasRemoteTmuxResult.set('r1', false)
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reconnectRemoteSession('r1')

    const got = sm.getSessions()[0]
    expect(got.status).toBe('dead')
    expect(got.connectionState).toBe('offline')
    expect(state.createRemotePtyCalls).toEqual([])
    expect(state.reattachRemotePtyCalls).toEqual([])
  })

  it('auth-failed classification via runtimeStateFor', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.ensureHostConnectionThrows = {
      message: 'Permission denied (publickey)',
      runtimeStateAfter: 'auth-failed',
    }
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await expect(sm.reconnectRemoteSession('r1')).rejects.toThrow(/Permission denied/)

    const got = sm.getSessions()[0]
    expect(got.connectionState).toBe('auth-failed')
    expect(got.status).toBe('idle')
    expect(state.reattachRemotePtyCalls).toEqual([])
  })

  it('network failure classified as unreachable', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.ensureHostConnectionThrows = {
      message: 'Connection refused',
      runtimeStateAfter: 'unreachable',
    }
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await expect(sm.reconnectRemoteSession('r1')).rejects.toThrow(/Connection refused/)

    expect(sm.getSessions()[0].connectionState).toBe('unreachable')
  })

  it('orphaned hostId → unreachable without SSH attempt', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', hostId: 'missing-host' })])
    state.hosts = [] // host registry empty
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await expect(sm.reconnectRemoteSession('r1')).rejects.toThrow(/was removed/)

    expect(sm.getSessions()[0].connectionState).toBe('unreachable')
    expect(state.ensureHostConnectionCalls).toEqual([])
  })

  it('idempotency: concurrent calls coalesce into a single SSH attempt', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.hasRemoteTmuxResult.set('r1', true)
    let gateResolve!: () => void
    state.ensureHostConnectionGate = new Promise<void>((res) => {
      gateResolve = res
    })
    const sm = await loadSessionManager()
    sm.restoreSessions()

    const a = sm.reconnectRemoteSession('r1')
    const b = sm.reconnectRemoteSession('r1')
    gateResolve()
    await Promise.all([a, b])

    expect(state.ensureHostConnectionCalls).toEqual(['h1'])
    expect(state.reattachRemotePtyCalls).toHaveLength(1)
  })

  it('auth-failed reconnect cascades to sibling pending sessions without new SSH', async () => {
    writeSessionsJson([
      baseRemoteSession({ id: 'clicked', hostId: 'h1', status: 'idle' }),
      baseRemoteSession({ id: 'sibling1', hostId: 'h1', status: 'idle' }),
      baseRemoteSession({ id: 'sibling2', hostId: 'h1', status: 'idle' }),
    ] as Session[])
    state.ensureHostConnectionThrows = {
      message: 'Permission denied',
      runtimeStateAfter: 'auth-failed',
    }
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await expect(sm.reconnectRemoteSession('clicked')).rejects.toThrow(/Permission denied/)
    // Let the fire-and-forget batch probe complete.
    await new Promise((resolve) => setTimeout(resolve, 20))

    const byId = Object.fromEntries(sm.getSessions().map((s) => [s.id, s]))
    expect(byId['clicked'].connectionState).toBe('auth-failed')
    expect(byId['sibling1'].connectionState).toBe('auth-failed')
    expect(byId['sibling2'].connectionState).toBe('auth-failed')
    // Only one SSH attempt (the clicked one). No probe calls for siblings.
    expect(state.ensureHostConnectionCalls).toEqual(['h1'])
    expect(state.execRemoteCalls).toEqual([])
  })

  it('SSH probe failure on reconnect → unreachable, NOT dead', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.probeRemoteTmuxResult.set('r1', 'unreachable')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reconnectRemoteSession('r1')

    const got = sm.getSessions()[0]
    expect(got.connectionState).toBe('unreachable')
    expect(got.status).toBe('idle')
    expect(state.reattachRemotePtyCalls).toEqual([])
  })

  it('keeps host runtime alive through sibling batch probe on absent outcome', async () => {
    // Regression guard for two issues in one: (a) sibling probe must still
    // run when the clicked session's outcome is `absent` (no PTY retain), and
    // (b) the ControlMaster must stay up through the batch so sibling probes
    // reuse the existing ControlPath instead of spawning fresh SSH per card.
    writeSessionsJson([
      baseRemoteSession({ id: 'first', hostId: 'h1', status: 'idle' }),
      baseRemoteSession({ id: 'sibling', hostId: 'h1', status: 'idle' }),
    ] as Session[])
    state.probeRemoteTmuxResult.set('first', 'absent')
    state.probeRemoteTmuxResult.set('sibling', 'present')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reconnectRemoteSession('first')
    await new Promise((resolve) => setTimeout(resolve, 20))

    const byId = Object.fromEntries(sm.getSessions().map((s) => [s.id, s]))
    expect(byId['first'].status).toBe('dead')
    expect(byId['sibling'].connectionState).toBe('live')
    // Only one ensureHostConnection call — siblings reused the ControlMaster
    // from the clicked session's reconnect (one SSH handshake, not N).
    expect(state.ensureHostConnectionCalls).toEqual(['h1'])
    // Sibling's reattach kept the runtime alive (refs=1 from sibling PTY).
    // The test would have failed if doReconnect released before the batch
    // probed siblings, because execRemote would then fall off the ControlPath
    // fast path and classifySshExit… actually, a more direct check: only one
    // SSH connection was opened total.
    expect(state.runtimeRefs.get('h1')).toBe(1)
  })

  it('releases retain when absent outcome has no sibling to retain the runtime', async () => {
    // Only one session on the host; clicked reconnect ends `absent`. After
    // the batch completes with no live siblings, the retain chain unwinds to
    // zero and the runtime is torn down.
    writeSessionsJson([
      baseRemoteSession({ id: 'lonely', hostId: 'h1', status: 'idle' }),
    ] as Session[])
    state.probeRemoteTmuxResult.set('lonely', 'absent')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reconnectRemoteSession('lonely')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(state.runtimeStates.has('h1')).toBe(false)
    expect(state.runtimeRefs.has('h1')).toBe(false)
  })

  it('triggers sibling batch probe even when first session ends dead (host is live)', async () => {
    writeSessionsJson([
      baseRemoteSession({ id: 'first', hostId: 'h1', status: 'idle' }),
      baseRemoteSession({ id: 'sibling', hostId: 'h1', status: 'idle' }),
    ] as Session[])
    // First session: tmux gone, but host is live → dead outcome
    state.probeRemoteTmuxResult.set('first', 'absent')
    // Sibling: tmux alive
    state.probeRemoteTmuxResult.set('sibling', 'present')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reconnectRemoteSession('first')
    // Allow the fire-and-forget batch probe to complete.
    await new Promise((resolve) => setTimeout(resolve, 20))

    const byId = Object.fromEntries(sm.getSessions().map((s) => [s.id, s]))
    expect(byId['first'].status).toBe('dead')
    expect(byId['first'].connectionState).toBe('offline')
    // Critical: sibling was probed via the now-live host connection
    expect(byId['sibling'].connectionState).toBe('live')
  })

  it('retry succeeds after an auth-failed attempt (no app restart needed)', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.ensureHostConnectionThrows = {
      message: 'Permission denied',
      runtimeStateAfter: 'auth-failed',
    }
    state.hasRemoteTmuxResult.set('r1', true)
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await expect(sm.reconnectRemoteSession('r1')).rejects.toThrow()
    expect(sm.getSessions()[0].connectionState).toBe('auth-failed')

    // User fixes SSH config → retry succeeds.
    state.ensureHostConnectionThrows = null
    await sm.reconnectRemoteSession('r1')

    expect(sm.getSessions()[0].connectionState).toBe('live')
    expect(state.ensureHostConnectionCalls).toEqual(['h1', 'h1'])
  })

  it('releases host retain when session is removed mid-reconnect', async () => {
    // doReconnectRemoteSession returns a prepared-host lease; the outer caller
    // owns releasing it after sibling reconciliation. If `sessions.get(id)` is
    // read after the await without a fallback, a concurrent removeSession()
    // would leave hostId undefined and the ControlMaster could leak for the
    // lifetime of the app.
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })] as Session[])
    state.probeRemoteTmuxResult.set('r1', 'absent')
    let gateResolve!: () => void
    state.ensureHostConnectionGate = new Promise<void>((res) => {
      gateResolve = res
    })
    const sm = await loadSessionManager()
    sm.restoreSessions()

    const reconnectPromise = sm.reconnectRemoteSession('r1')
    // Allow doReconnectRemoteSession's synchronous prelude to run and park at
    // the gated `await ensureHostConnection`.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await sm.removeSession('r1')
    gateResolve()
    await reconnectPromise
    // Allow the fire-and-forget batch + release to complete.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(state.runtimeRefs.has('h1')).toBe(false)
    expect(state.runtimeStates.has('h1')).toBe(false)
  })
})

describe('probePendingSessionsOnHost', () => {
  function threePendingOnH1(): Session[] {
    return [
      baseRemoteSession({ id: 'a', hostId: 'h1', status: 'idle' }),
      baseRemoteSession({ id: 'b', hostId: 'h1', status: 'idle' }),
      baseRemoteSession({ id: 'c', hostId: 'h1', status: 'idle' }),
    ] as Session[]
  }

  it('probes all pending siblings over the live control connection', async () => {
    writeSessionsJson(threePendingOnH1())
    state.hasRemoteTmuxResult.set('a', true)
    state.hasRemoteTmuxResult.set('b', true)
    state.hasRemoteTmuxResult.set('c', true)
    state.runtimeStates.set('h1', 'live')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.probePendingSessionsOnHost('h1')

    expect(sm.getSessions().every((s) => s.connectionState === 'live')).toBe(true)
    expect(state.ensureHostConnectionCalls).toEqual([])
    expect(state.reattachRemotePtyCalls.map((c) => c.sessionId).sort()).toEqual(['a', 'b', 'c'])
  })

  it('marks only the tmux-gone sibling dead', async () => {
    writeSessionsJson(threePendingOnH1())
    state.hasRemoteTmuxResult.set('a', true)
    state.hasRemoteTmuxResult.set('b', false)
    state.hasRemoteTmuxResult.set('c', true)
    state.runtimeStates.set('h1', 'live')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.probePendingSessionsOnHost('h1')

    const byId = Object.fromEntries(sm.getSessions().map((s) => [s.id, s]))
    expect(byId['a'].connectionState).toBe('live')
    expect(byId['b'].status).toBe('dead')
    expect(byId['b'].connectionState).toBe('offline')
    expect(byId['c'].connectionState).toBe('live')
  })

  it('short-circuits to auth-failed cascade with zero network', async () => {
    writeSessionsJson(threePendingOnH1())
    state.runtimeStates.set('h1', 'auth-failed')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.probePendingSessionsOnHost('h1')

    expect(sm.getSessions().every((s) => s.connectionState === 'auth-failed')).toBe(true)
    expect(state.execRemoteCalls).toEqual([])
    expect(state.reattachRemotePtyCalls).toEqual([])
  })

  it('SSH probe failure on a sibling → mark it unreachable and bail, do NOT downgrade rest to dead', async () => {
    writeSessionsJson(threePendingOnH1())
    state.probeRemoteTmuxResult.set('a', 'present')
    state.probeRemoteTmuxResult.set('b', 'unreachable')
    state.probeRemoteTmuxResult.set('c', 'present')
    state.runtimeStates.set('h1', 'live')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.probePendingSessionsOnHost('h1')

    const byId = Object.fromEntries(sm.getSessions().map((s) => [s.id, s]))
    expect(byId['a'].connectionState).toBe('live')
    expect(byId['b'].connectionState).toBe('unreachable')
    // c remains pending — we bail to avoid a flood of SSH calls on a bad host
    expect(byId['c'].connectionState).toBe('pending')
  })

  it('skips a sibling whose state advanced out of pending during the batch', async () => {
    // If a concurrent reconnect moves a sibling out of `pending` while the
    // batch is iterating, the batch must not re-probe/reattach it (doing so
    // would duplicate the remote attach and leak refs).
    writeSessionsJson(threePendingOnH1())
    state.probeRemoteTmuxResult.set('a', 'present')
    state.probeRemoteTmuxResult.set('b', 'present')
    state.probeRemoteTmuxResult.set('c', 'present')
    state.runtimeStates.set('h1', 'live')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    // When the batch probes 'a' (first sibling in the snapshot), flip 'b'
    // out of pending — simulating a concurrent reconnect on 'b' completing
    // mid-batch.
    state.probeSideEffect.set('a', () => {
      const bSession = sm.getSessions().find((s) => s.id === 'b')!
      bSession.connectionState = 'live'
      bSession.status = 'idle'
    })

    await sm.probePendingSessionsOnHost('h1')

    // 'b' must not have been reattached by the batch (state ≠ pending).
    const bReattaches = state.reattachRemotePtyCalls.filter((c) => c.sessionId === 'b').length
    expect(bReattaches).toBe(0)
    // 'a' and 'c' still got reattached.
    const aReattaches = state.reattachRemotePtyCalls.filter((c) => c.sessionId === 'a').length
    const cReattaches = state.reattachRemotePtyCalls.filter((c) => c.sessionId === 'c').length
    expect(aReattaches).toBe(1)
    expect(cReattaches).toBe(1)
  })

  it('idempotency: concurrent batch probes coalesce', async () => {
    writeSessionsJson(threePendingOnH1())
    state.hasRemoteTmuxResult.set('a', true)
    state.hasRemoteTmuxResult.set('b', true)
    state.hasRemoteTmuxResult.set('c', true)
    state.runtimeStates.set('h1', 'live')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await Promise.all([sm.probePendingSessionsOnHost('h1'), sm.probePendingSessionsOnHost('h1')])

    expect(state.reattachRemotePtyCalls).toHaveLength(3)
  })
})

describe('updateLastKnownStatesBatch', () => {
  it('persists once per batch regardless of session count', async () => {
    writeSessionsJson([
      baseRemoteSession({ id: 'a', hostId: 'h1' }),
      baseRemoteSession({ id: 'b', hostId: 'h1' }),
      baseRemoteSession({ id: 'c', hostId: 'h1' }),
    ] as Session[])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    const before = state.sessionsUpdatedBroadcasts

    sm.updateLastKnownStatesBatch([
      { id: 'a', text: 'aaa' },
      { id: 'b', text: 'bbb' },
      { id: 'c', text: 'ccc' },
    ])

    expect(state.sessionsUpdatedBroadcasts - before).toBe(1)
    const byId = Object.fromEntries(sm.getSessions().map((s) => [s.id, s]))
    expect(byId['a'].lastKnownState?.text).toBe('aaa')
    expect(byId['b'].lastKnownState?.text).toBe('bbb')
    expect(byId['c'].lastKnownState?.text).toBe('ccc')
  })

  it('does not persist when every update is rate-limited', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'a' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()

    sm.updateLastKnownStatesBatch([{ id: 'a', text: 'first' }])
    const afterFirst = state.sessionsUpdatedBroadcasts

    // Immediate second call: rate-limited, must not trigger another broadcast.
    sm.updateLastKnownStatesBatch([{ id: 'a', text: 'second' }])

    expect(state.sessionsUpdatedBroadcasts - afterFirst).toBe(0)
  })

  it('skips write when text is unchanged across rate-limit windows', async () => {
    // Idle sessions emit identical thumbnail text every 3s tick. Once the
    // 10s rate-limit elapses, the gate would otherwise fire a write +
    // broadcast every 10s indefinitely. The text-equality early-return
    // turns this into a no-op for stable sessions.
    writeSessionsJson([baseRemoteSession({ id: 'a' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()

    sm.updateLastKnownStatesBatch([{ id: 'a', text: 'idle prompt $' }])
    const afterFirst = state.sessionsUpdatedBroadcasts

    // Advance past the 10s rate-limit window.
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 11_000)
    try {
      sm.updateLastKnownStatesBatch([{ id: 'a', text: 'idle prompt $' }])
      expect(state.sessionsUpdatedBroadcasts - afterFirst).toBe(0)

      // A real text change still goes through.
      sm.updateLastKnownStatesBatch([{ id: 'a', text: 'idle prompt $ ls' }])
      expect(state.sessionsUpdatedBroadcasts - afterFirst).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('updateLastKnownState', () => {
  it('persists text + timestamp; caps at 3 KiB; rate-limits to 10s per session', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()

    // First write goes through.
    const big = 'x'.repeat(5 * 1024)
    sm.updateLastKnownState('r1', big)
    let got = sm.getSessions()[0]
    expect(got.lastKnownState?.text.length).toBe(3 * 1024)
    expect(got.lastKnownState?.timestamp).toBeGreaterThan(0)
    const firstTs = got.lastKnownState!.timestamp

    // Second write within the 10s window is dropped.
    sm.updateLastKnownState('r1', 'newer')
    got = sm.getSessions()[0]
    expect(got.lastKnownState?.timestamp).toBe(firstTs)
    expect(got.lastKnownState?.text).not.toBe('newer')
  })
})

describe('restoreSessions — local path unchanged (AC #10 regression)', () => {
  it('reattaches a local session with a live tmux', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'idle' })
    state.liveTmuxIds = ['l1']
    writeSessionsJson([local])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    const got = sm.getSessions()[0]
    expect(got.status).toBe('idle')
    expect(got.connectionState).toBeUndefined()
    expect(state.reattachPtyCalls).toEqual(['l1'])
    expect(state.ensureHostConnectionCalls).toEqual([])
  })
})

describe('restoreSessions — local lazy materialization', () => {
  // Spawning every persisted local session up-front cost ~1 GB per claude
  // process and OOM'd the box when many sessions existed. The fix mirrors
  // the remote path: mark pending and let attachLocalSession do the work
  // on first open.
  it('defers spawn when tmux is gone but worktree survives', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'idle' })
    mkdirSync(local.worktreePath, { recursive: true })
    state.liveTmuxIds = []
    writeSessionsJson([local])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    const got = sm.getSessions()[0]
    expect(got.status).toBe('idle')
    expect(got.connectionState).toBe('pending')
    expect(state.createPtyCalls).toEqual([])
    expect(state.reattachPtyCalls).toEqual([])
  })

  it('preserves needs_input on lazy-restored sessions', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'needs_input' })
    mkdirSync(local.worktreePath, { recursive: true })
    writeSessionsJson([local])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    const got = sm.getSessions()[0]
    expect(got.status).toBe('needs_input')
    expect(got.connectionState).toBe('pending')
    expect(state.createPtyCalls).toEqual([])
  })

  it('marks dead when worktree is missing', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'idle' })
    writeSessionsJson([local])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    const got = sm.getSessions()[0]
    expect(got.status).toBe('dead')
    expect(got.connectionState).toBeUndefined()
    expect(state.createPtyCalls).toEqual([])
  })

  // Regression: a prior run can persist connectionState='pending'. If the
  // next restore marks the session 'dead' (worktree gone, tmux unavailable,
  // or terminal-state without live tmux), the stale pending flag must not
  // survive — otherwise the renderer mount effects + attachLocalSession
  // would try to materialize a session that's supposed to stay dead.
  it('clears stale connectionState=pending when restoring to dead', async () => {
    const local = baseLocalSession({
      id: 'l1',
      status: 'idle',
      connectionState: 'pending',
    })
    writeSessionsJson([local])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    const got = sm.getSessions()[0]
    expect(got.status).toBe('dead')
    expect(got.connectionState).toBeUndefined()
  })

  it('clears stale connectionState=pending for terminal-state sessions with no live tmux', async () => {
    const local = baseLocalSession({
      id: 'l1',
      status: 'completed',
      connectionState: 'pending',
    })
    writeSessionsJson([local])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    const got = sm.getSessions()[0]
    expect(got.status).toBe('dead')
    expect(got.connectionState).toBeUndefined()
  })

  it('marks dead when tmux is unavailable', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'idle' })
    mkdirSync(local.worktreePath, { recursive: true })
    state.tmuxAvailable = false
    writeSessionsJson([local])
    const sm = await loadSessionManager()

    sm.restoreSessions()

    const got = sm.getSessions()[0]
    expect(got.status).toBe('dead')
    expect(got.connectionState).toBeUndefined()
    expect(state.createPtyCalls).toEqual([])
  })
})

describe('attachLocalSession', () => {
  it('spawns the pty when tmux is gone', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'idle' })
    mkdirSync(local.worktreePath, { recursive: true })
    writeSessionsJson([local])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    expect(sm.getSessions()[0].connectionState).toBe('pending')

    await sm.attachLocalSession('l1')

    const got = sm.getSessions()[0]
    expect(got.connectionState).toBeUndefined()
    expect(got.status).toBe('idle')
    expect(state.createPtyCalls.map((c) => c.sessionId)).toEqual(['l1'])
  })

  it('is a no-op when the session is not pending', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'idle' })
    state.liveTmuxIds = ['l1']
    writeSessionsJson([local])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    state.createPtyCalls = []
    state.reattachPtyCalls = []

    await sm.attachLocalSession('l1')

    expect(state.createPtyCalls).toEqual([])
    expect(state.reattachPtyCalls).toEqual([])
  })

  it('is a no-op on remote sessions even if pending', async () => {
    const remote = baseRemoteSession({ id: 'r1', status: 'idle' })
    writeSessionsJson([remote])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    expect(sm.getSessions()[0].connectionState).toBe('pending')

    await sm.attachLocalSession('r1')

    expect(state.createPtyCalls).toEqual([])
    expect(state.reattachPtyCalls).toEqual([])
    // connectionState must remain pending so reconnectRemoteSession can drive it.
    expect(sm.getSessions()[0].connectionState).toBe('pending')
  })

  it('marks dead and clears pending when worktree disappears', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'idle' })
    mkdirSync(local.worktreePath, { recursive: true })
    writeSessionsJson([local])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    rmSync(local.worktreePath, { recursive: true, force: true })

    await sm.attachLocalSession('l1')

    const got = sm.getSessions()[0]
    expect(got.status).toBe('dead')
    expect(got.connectionState).toBeUndefined()
    expect(state.createPtyCalls).toEqual([])
  })
})

describe('attachPendingLocalSessions', () => {
  it('materializes pending local sessions and leaves remote pending sessions alone', async () => {
    const l1 = baseLocalSession({
      id: 'l1',
      status: 'idle',
      worktreePath: join(state.configDir, 'local-wt-1'),
    })
    const l2 = baseLocalSession({
      id: 'l2',
      status: 'needs_input',
      worktreePath: join(state.configDir, 'local-wt-2'),
    })
    const remote = baseRemoteSession({ id: 'r1', status: 'idle' })
    mkdirSync(l1.worktreePath, { recursive: true })
    mkdirSync(l2.worktreePath, { recursive: true })
    writeSessionsJson([l1, remote, l2])
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.attachPendingLocalSessions(['l1', 'r1', 'l2'])

    expect(state.createPtyCalls.map((c) => c.sessionId)).toEqual(['l1', 'l2'])
    expect(sm.getSessions().find((s) => s.id === 'l1')?.connectionState).toBeUndefined()
    expect(sm.getSessions().find((s) => s.id === 'l2')?.connectionState).toBeUndefined()
    expect(sm.getSessions().find((s) => s.id === 'r1')?.connectionState).toBe('pending')
  })
})

describe('kill/revive clears stale connectionState=pending', () => {
  // Regression: a lazy-restored local session sits in connectionState='pending'.
  // If the user kills it (or kill→revive in one app run), the prior `pending`
  // flag must not leak — otherwise a subsequent card/detail mount-effect
  // attachSession would replace the live node-pty (reviveSession case) or
  // attempt to attach a dead entry (killSession case).
  it('killSession clears connectionState on a pending local session', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'idle' })
    mkdirSync(local.worktreePath, { recursive: true })
    writeSessionsJson([local])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    expect(sm.getSessions()[0].connectionState).toBe('pending')

    await sm.killSession('l1')

    const got = sm.getSessions()[0]
    expect(got.status).toBe('dead')
    expect(got.connectionState).toBeUndefined()
  })

  it('reviveSession clears connectionState before creating the pty', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'idle' })
    mkdirSync(local.worktreePath, { recursive: true })
    writeSessionsJson([local])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    await sm.killSession('l1')
    state.createPtyCalls = []

    await sm.reviveSession('l1')

    const got = sm.getSessions()[0]
    expect(got.status).toBe('idle')
    expect(got.connectionState).toBeUndefined()
    expect(state.createPtyCalls.map((c) => c.sessionId)).toEqual(['l1'])
  })
})

describe('unexpected pty exit listener', () => {
  it('flips a local session to dead when its pty dies on its own', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'idle' })
    state.liveTmuxIds = ['l1']
    writeSessionsJson([local])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.initSessionManager()
    expect(state.unexpectedExitListener).not.toBeNull()

    state.unexpectedExitListener?.('l1')

    expect(sm.getSessions()[0].status).toBe('dead')
  })

  it('does not touch remote sessions (their connection state machinery owns recovery)', async () => {
    const remote = baseRemoteSession({ id: 'r1', status: 'idle' })
    writeSessionsJson([remote])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.initSessionManager()

    state.unexpectedExitListener?.('r1')

    expect(sm.getSessions()[0].status).toBe('idle')
  })

  it('is a no-op for unknown ids and already-dead sessions', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'dead' })
    writeSessionsJson([local])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.initSessionManager()
    const broadcastsBefore = state.sessionsUpdatedBroadcasts

    state.unexpectedExitListener?.('l1')
    state.unexpectedExitListener?.('unknown-id')

    expect(state.sessionsUpdatedBroadcasts).toBe(broadcastsBefore)
  })
})

describe('removeSessionsForHost (issue #14)', () => {
  it('drops only the matching host, detaches PTY for each, and broadcasts once', async () => {
    state.hosts = [
      { hostId: 'A', alias: 'a', label: 'A' },
      { hostId: 'B', alias: 'b', label: 'B' },
    ]
    writeSessionsJson([
      baseRemoteSession({ id: 'rA1', hostId: 'A' }),
      baseRemoteSession({ id: 'rA2', hostId: 'A', worktreeName: 'feat-2' }),
      baseRemoteSession({ id: 'rB1', hostId: 'B' }),
    ])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    state.sessionsUpdatedBroadcasts = 0

    sm.removeSessionsForHost('A')

    const remaining = sm.getSessions()
    expect(remaining.map((s) => s.id)).toEqual(['rB1'])
    expect(state.detachPtyCalls.sort()).toEqual(['rA1', 'rA2'])
    expect(state.sessionsUpdatedBroadcasts).toBe(1)
  })

  it('skips persist + broadcast when no sessions match', async () => {
    state.hosts = [{ hostId: 'A', alias: 'a', label: 'A' }]
    writeSessionsJson([baseRemoteSession({ id: 'rA1', hostId: 'A' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    state.sessionsUpdatedBroadcasts = 0

    sm.removeSessionsForHost('does-not-exist')

    expect(sm.getSessions().map((s) => s.id)).toEqual(['rA1'])
    expect(state.detachPtyCalls).toEqual([])
    expect(state.sessionsUpdatedBroadcasts).toBe(0)
  })
})
describe('codex agent integration', () => {
  it('backfills tool="claude" on legacy sessions missing the field', async () => {
    // Persisted JSON omits `tool` to simulate a session created before the
    // multi-agent change; restoreSessions must default it without crashing.
    writeFileSync(
      join(state.configDir, 'sessions.json'),
      JSON.stringify([
        {
          id: 'legacy1',
          hostId: null,
          projectPath: '/p',
          projectName: 'p',
          worktreeName: 'w',
          worktreePath: '/p/w',
          branch: 'main',
          pid: 0,
          tmuxSession: 'pewpew-legacy1',
          status: 'idle',
          lastActivity: 0,
          hookEvents: [],
        },
      ])
    )
    const sm = await loadSessionManager()
    sm.restoreSessions()
    const restored = sm.getSessions().find((s) => s.id === 'legacy1')
    expect(restored?.tool).toBe('claude')
  })

  it('handleHookEvent session.start captures codex session_id as agentSessionId', async () => {
    writeSessionsJson([baseLocalSession({ id: 'cx1', tool: 'codex', worktreePath: '/cx/wt' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.handleHookEvent('session.start', { cwd: '/cx/wt', session_id: 'codex-uuid-9' }, null)
    const updated = sm.getSessions().find((s) => s.id === 'cx1')
    expect(updated?.agentSessionId).toBe('codex-uuid-9')
  })

  it('handleHookEvent session.stop sets needs_input for codex sessions (parity with claude)', async () => {
    writeSessionsJson([baseLocalSession({ id: 'cx2', tool: 'codex', worktreePath: '/cx/wt2' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.handleHookEvent('session.stop', { cwd: '/cx/wt2' }, null)
    const updated = sm.getSessions().find((s) => s.id === 'cx2')
    expect(updated?.status).toBe('needs_input')
  })

  it('does not overwrite agentSessionId once captured', async () => {
    writeSessionsJson([
      baseLocalSession({
        id: 'cx3',
        tool: 'codex',
        worktreePath: '/cx/wt3',
        agentSessionId: 'first',
      }),
    ])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.handleHookEvent('session.start', { cwd: '/cx/wt3', session_id: 'second' }, null)
    const updated = sm.getSessions().find((s) => s.id === 'cx3')
    expect(updated?.agentSessionId).toBe('first')
  })

  it('claude session.start does not set agentSessionId', async () => {
    writeSessionsJson([baseLocalSession({ id: 'cl1', tool: 'claude', worktreePath: '/cl/wt' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.handleHookEvent('session.start', { cwd: '/cl/wt', session_id: 'should-not-store' }, null)
    const updated = sm.getSessions().find((s) => s.id === 'cl1')
    expect(updated?.agentSessionId).toBeUndefined()
  })
})

describe('sanitizeBranchPrefix', () => {
  it('preserves valid ref-component characters', async () => {
    const sm = await loadSessionManager()
    expect(sm.sanitizeBranchPrefix('pewpew')).toBe('pewpew')
    expect(sm.sanitizeBranchPrefix('my_repo.v2')).toBe('my_repo.v2')
  })

  it('replaces git-illegal characters with `-`', async () => {
    const sm = await loadSessionManager()
    expect(sm.sanitizeBranchPrefix('My Repo')).toBe('My-Repo')
    expect(sm.sanitizeBranchPrefix('repo:with~bad^chars?*[\\]')).toBe('repo-with-bad-chars')
  })

  it('strips consecutive dots rejected by git ref names', async () => {
    const sm = await loadSessionManager()
    expect(sm.sanitizeBranchPrefix('my..repo')).toBe('my-repo')
    expect(sm.sanitizeBranchPrefix('repo...v2')).toBe('repo-v2')
  })

  it('strips leading and trailing punctuation', async () => {
    const sm = await loadSessionManager()
    expect(sm.sanitizeBranchPrefix('-leading')).toBe('leading')
    expect(sm.sanitizeBranchPrefix('.dot.')).toBe('dot')
  })

  it('strips trailing `.lock` suffixes (illegal as ref-component suffixes)', async () => {
    const sm = await loadSessionManager()
    expect(sm.sanitizeBranchPrefix('proj.lock')).toBe('proj')
    expect(sm.sanitizeBranchPrefix('proj.lock.lock')).toBe('proj')
    expect(sm.sanitizeBranchPrefix('proj-.lock')).toBe('proj')
  })

  it('falls back to `pewpew` when nothing valid remains', async () => {
    const sm = await loadSessionManager()
    expect(sm.sanitizeBranchPrefix('   ')).toBe('pewpew')
    expect(sm.sanitizeBranchPrefix(':::')).toBe('pewpew')
    expect(sm.sanitizeBranchPrefix('')).toBe('pewpew')
  })
})

describe('createIssueSession', () => {
  it('creates a worktree on branch issue-<n> from origin default and sets issueNumber', async () => {
    const sm = await loadSessionManager()
    const runGit = vi.fn(async (argv: string[]) => {
      const key = argv.join(' ')
      if (key === 'remote get-url origin') return { stdout: 'git@example.com:org/repo.git\n' }
      if (key === 'fetch origin --quiet') return { stdout: '' }
      if (key === 'ls-remote --symref origin HEAD') {
        return { stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n' }
      }
      if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') {
        return { stdout: 'origin/main\n' }
      }
      if (key === 'rev-parse --verify refs/remotes/origin/main') {
        return { stdout: 'abc123\n' }
      }
      if (
        key ===
        'worktree add /proj/.claude/worktrees/issue-42 --no-track -b issue-42 refs/remotes/origin/main'
      ) {
        return { stdout: '' }
      }
      throw new Error(`unexpected git ${key}`)
    })
    const createSessionForWorktree = vi.fn(async () =>
      baseLocalSession({
        id: 'issue-42',
        projectPath: '/proj',
        worktreeName: 'issue-42',
        worktreePath: '/proj/.claude/worktrees/issue-42',
        branch: 'issue-42',
      })
    )

    const result = await sm.createIssueSession(
      '/proj',
      42,
      null,
      {},
      { runGit, createSessionForWorktree }
    )

    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') throw new Error(result)
    expect(result.issueNumber).toBe(42)
    expect(result.worktreeName).toBe('issue-42')
    expect(createSessionForWorktree).toHaveBeenCalledWith(
      '/proj',
      '/proj/.claude/worktrees/issue-42',
      'issue-42',
      undefined
    )
    expect(runGit).toHaveBeenCalledWith([
      'worktree',
      'add',
      '/proj/.claude/worktrees/issue-42',
      '--no-track',
      '-b',
      'issue-42',
      'refs/remotes/origin/main',
    ])
  })

  it('returns a user-facing error string when origin default is missing', async () => {
    const sm = await loadSessionManager()
    const runGit = vi.fn(async (argv: string[]) => {
      const key = argv.join(' ')
      if (key === 'remote get-url origin') return { stdout: 'git@example.com:org/repo.git\n' }
      if (key === 'fetch origin --quiet') return { stdout: '' }
      throw new Error(`missing ${key}`)
    })

    const result = await sm.createIssueSession('/proj', 99, null, {}, { runGit })
    expect(result).toBe("Could not determine origin's default branch.")
  })
})

describe('selectNumbersToOpen', () => {
  it('partitions items into toCreate (new) and toSkip (already present)', async () => {
    const sm = await loadSessionManager()
    const items = [{ number: 1 }, { number: 2 }, { number: 3 }]
    const existing = new Set([2])
    const result = sm.selectNumbersToOpen(items, existing)
    expect(result.toCreate).toEqual([{ number: 1 }, { number: 3 }])
    expect(result.toSkip).toEqual([2])
  })

  it('dedupes repeated items in the same list', async () => {
    const sm = await loadSessionManager()
    const result = sm.selectNumbersToOpen([{ number: 7 }, { number: 7 }], new Set())
    expect(result.toCreate).toEqual([{ number: 7 }])
    expect(result.toSkip).toEqual([7])
  })

  it('returns empty toCreate when everything matches', async () => {
    const sm = await loadSessionManager()
    const result = sm.selectNumbersToOpen([{ number: 1 }, { number: 2 }], new Set([1, 2]))
    expect(result.toCreate).toEqual([])
    expect(result.toSkip).toEqual([1, 2])
  })
})

describe('ghApiOpenItemsArgs', () => {
  it('uses paginated REST calls for PR numbers', async () => {
    const sm = await loadSessionManager()
    expect(sm.ghApiOpenItemsArgs('pr', 'owner/repo')).toEqual([
      'api',
      '--paginate',
      'repos/owner/repo/pulls?state=open&per_page=100',
      '--jq',
      '.[].number',
    ])
  })

  it('uses paginated REST calls for issue numbers without including PRs', async () => {
    const sm = await loadSessionManager()
    expect(sm.ghApiOpenItemsArgs('issue', 'owner/repo')).toEqual([
      'api',
      '--paginate',
      'repos/owner/repo/issues?state=open&per_page=100',
      '--jq',
      '.[] | select(.pull_request | not) | .number',
    ])
  })
})

describe('openSessionsForOpenPrs', () => {
  it('lists open PRs, skips ones that already have a session, creates the rest', async () => {
    const sm = await loadSessionManager()
    writeSessionsJson([baseLocalSession({ id: 's-existing', prNumber: 7, projectPath: '/proj' })])
    sm.restoreSessions()

    const listPrs = vi.fn(async () => [
      { number: 7, title: 'old', headRefName: 'a' },
      { number: 8, title: 'new', headRefName: 'b' },
      { number: 9, title: 'newer', headRefName: 'c' },
    ])
    const createPrSession = vi.fn(
      async (_projectPath: string, prNumber: number, _hostId: string | null) =>
        baseLocalSession({ id: `s-${prNumber}`, prNumber }) as Session | string
    )

    const result = await sm.openSessionsForOpenPrs('/proj', null, { listPrs, createPrSession })
    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') throw new Error(result)

    expect(result.skipped).toEqual([7])
    expect(result.created.map((s) => s.prNumber).sort()).toEqual([8, 9])
    expect(result.failed).toEqual([])
    expect(listPrs).toHaveBeenCalledWith('/proj', null)
    expect(createPrSession).toHaveBeenCalledTimes(2)
    expect(createPrSession).toHaveBeenCalledWith('/proj', 8, null, {})
    expect(createPrSession).toHaveBeenCalledWith('/proj', 9, null, {})
  })

  it('surfaces gh list errors as a string', async () => {
    const sm = await loadSessionManager()
    const result = await sm.openSessionsForOpenPrs('/proj', null, {
      listPrs: async () => 'Failed to list open PRs: gh auth failed',
      createPrSession: vi.fn(),
    })

    expect(result).toBe('Failed to list open PRs: gh auth failed')
  })

  it('surfaces remote SSH auth failures separately from missing gh', async () => {
    const sm = await loadSessionManager()
    state.execRemoteResults.set('sh -c command -v gh >/dev/null 2>&1', {
      stdout: '',
      stderr: 'Permission denied (publickey).\n',
      code: 255,
      timedOut: false,
    })

    const result = await sm.openSessionsForOpenPrs('/remote/proj', 'h1')
    expect(result).toBe('SSH authentication failed on Dev: Permission denied (publickey).')
  })

  it('still reports missing gh when the remote probe runs and gh is absent', async () => {
    const sm = await loadSessionManager()
    state.execRemoteResults.set('sh -c command -v gh >/dev/null 2>&1', {
      stdout: '',
      stderr: '',
      code: 1,
      timedOut: false,
    })

    const result = await sm.openSessionsForOpenPrs('/remote/proj', 'h1')
    expect(result).toBe('gh CLI is not installed on host Dev.')
  })
})

describe('openSessionsForOpenIssues', () => {
  it('lists open issues, skips ones that already have a session, creates the rest', async () => {
    const sm = await loadSessionManager()
    writeSessionsJson([
      baseLocalSession({ id: 's-existing', issueNumber: 3, projectPath: '/proj' }),
    ])
    sm.restoreSessions()

    const listIssues = vi.fn(async () => [{ number: 3 }, { number: 4 }])
    const createIssueSession = vi.fn(
      async (_projectPath: string, issueNumber: number, _hostId: string | null) =>
        baseLocalSession({ id: `s-${issueNumber}`, issueNumber }) as Session | string
    )

    const result = await sm.openSessionsForOpenIssues('/proj', null, {
      listIssues,
      createIssueSession,
    })
    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') throw new Error(result)

    expect(result.skipped).toEqual([3])
    expect(result.created.map((s) => s.issueNumber)).toEqual([4])
    expect(result.failed).toEqual([])
    expect(listIssues).toHaveBeenCalledWith('/proj', null)
    expect(createIssueSession).toHaveBeenCalledTimes(1)
    expect(createIssueSession).toHaveBeenCalledWith('/proj', 4, null, {})
  })

  it('records per-issue create failures in the summary', async () => {
    const sm = await loadSessionManager()
    const result = await sm.openSessionsForOpenIssues('/proj', null, {
      listIssues: async () => [{ number: 5 }],
      createIssueSession: async () => 'boom',
    })
    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') throw new Error(result)
    expect(result.created).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.failed).toEqual([{ number: 5, error: 'boom' }])
  })
})

describe('createPrSession fork handling', () => {
  const forkPrView = async () => ({
    headRefName: 'codex/fix-x',
    state: 'OPEN',
    title: 'docs: fix x',
    isCrossRepository: true,
    headRepositoryOwner: { login: 'contributor' },
    headRepository: { name: 's11' },
  })

  it('fetches refs/pull/<n>/head for a fork PR and never touches origin/<branch>', async () => {
    const sm = await loadSessionManager()
    const runGit = vi.fn(async (argv: string[]) => {
      const key = argv.join(' ')
      // A fork PR head is fetched straight from the pull ref into a PR-scoped
      // local branch (pr-335) with a FORCED refspec — origin/<branch> is never
      // fetched, since the fork's head branch name could collide with a
      // base-repo branch.
      if (key === 'fetch origin +pull/335/head:pr-335') return { stdout: '' }
      // The PR-scoped branch is verified to exist before `worktree add`.
      if (key === 'rev-parse --verify --quiet refs/heads/pr-335') return { stdout: 'abc123\n' }
      if (key === 'worktree add /proj/.claude/worktrees/pr-335 pr-335') return { stdout: '' }
      throw new Error(`unexpected git ${key}`)
    })
    const createSessionForWorktree = vi.fn(async () =>
      baseLocalSession({
        id: 'pr-335',
        projectPath: '/proj',
        worktreeName: 'pr-335',
        worktreePath: '/proj/.claude/worktrees/pr-335',
        branch: 'pr-335',
      })
    )

    const result = await sm.createPrSession(
      '/proj',
      335,
      null,
      {},
      {
        runGit,
        prView: forkPrView,
        createSessionForWorktree,
      }
    )

    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') throw new Error(result)
    expect(result.prNumber).toBe(335)
    expect(result.prIsFork).toBe(true)
    expect(result.prHeadRepo).toBe('contributor/s11')
    // The pull ref was force-fetched into a PR-scoped local branch, and the
    // worktree was added from it.
    expect(runGit).toHaveBeenCalledWith(['fetch', 'origin', '+pull/335/head:pr-335'])
    expect(runGit).toHaveBeenCalledWith([
      'worktree',
      'add',
      '/proj/.claude/worktrees/pr-335',
      'pr-335',
    ])
    // origin/<branch> is never fetched or used for a fork PR — the fork's head
    // branch name could collide with a base-repo branch of the same name.
    expect(runGit).not.toHaveBeenCalledWith(['fetch', 'origin', 'codex/fix-x'])
    expect(runGit).not.toHaveBeenCalledWith([
      'worktree',
      'add',
      '/proj/.claude/worktrees/pr-335',
      '-b',
      'pr-335',
      'origin/codex/fix-x',
    ])
  })

  it('errors without running worktree add when the fork pull-ref fetch fails', async () => {
    const sm = await loadSessionManager()
    const runGit = vi.fn(async (argv: string[]) => {
      const key = argv.join(' ')
      // The pull ref can't be fetched (offline / transient), so the PR-scoped
      // branch is never created.
      if (key === 'fetch origin +pull/335/head:pr-335') throw new Error('network down')
      if (key === 'rev-parse --verify --quiet refs/heads/pr-335') throw new Error('no such ref')
      throw new Error(`unexpected git ${key}`)
    })
    const createSessionForWorktree = vi.fn()

    const result = await sm.createPrSession(
      '/proj',
      335,
      null,
      {},
      { runGit, prView: forkPrView, createSessionForWorktree }
    )

    // No local pr-335 exists, so we must fail explicitly rather than let
    // `git worktree add pr-335` DWIM to a remote-tracking origin/pr-335.
    expect(typeof result).toBe('string')
    expect(runGit).not.toHaveBeenCalledWith([
      'worktree',
      'add',
      '/proj/.claude/worktrees/pr-335',
      'pr-335',
    ])
    expect(createSessionForWorktree).not.toHaveBeenCalled()
  })

  it('does not fetch the pull ref for a same-repo PR', async () => {
    const sm = await loadSessionManager()
    const runGit = vi.fn(async (argv: string[]) => {
      const key = argv.join(' ')
      if (key === 'fetch origin feat-y') return { stdout: '' }
      if (key === 'worktree add /proj/.claude/worktrees/pr-7 feat-y') return { stdout: '' }
      throw new Error(`unexpected git ${key}`)
    })
    const createSessionForWorktree = vi.fn(async () =>
      baseLocalSession({
        id: 'pr-7',
        projectPath: '/proj',
        worktreeName: 'pr-7',
        worktreePath: '/proj/.claude/worktrees/pr-7',
        branch: 'feat-y',
      })
    )

    const result = await sm.createPrSession(
      '/proj',
      7,
      null,
      {},
      {
        runGit,
        prView: async () => ({ headRefName: 'feat-y', state: 'OPEN', title: 'feat' }),
        createSessionForWorktree,
      }
    )

    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') throw new Error(result)
    expect(result.prNumber).toBe(7)
    expect(result.prIsFork).toBeUndefined()
    expect(result.prHeadRepo).toBeUndefined()
    expect(runGit).not.toHaveBeenCalledWith(['fetch', 'origin', 'pull/7/head:feat-y'])
  })

  const gitIt = canRunGit ? it : it.skip

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' })
  }

  gitIt('checks out a fork PR head end-to-end via the pull ref (real git)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fork-pr-'))
    try {
      const source = join(root, 'source')
      const remote = join(root, 'remote.git')
      const project = join(root, 'project')
      mkdirSync(source)
      git(source, ['init'])
      git(source, ['config', 'user.email', 'test@example.com'])
      git(source, ['config', 'user.name', 'Test User'])
      writeFileSync(join(source, 'file.txt'), 'one\n')
      git(source, ['add', 'file.txt'])
      git(source, ['commit', '-m', 'one'])
      git(source, ['branch', '-M', 'main'])
      // The PR head lives on its own branch (stands in for the fork). Capture
      // its tip, then keep main where it is.
      git(source, ['checkout', '-b', 'pr-src'])
      writeFileSync(join(source, 'file.txt'), 'two\n')
      git(source, ['commit', '-am', 'pr head'])
      const prHead = git(source, ['rev-parse', 'HEAD']).trim()
      git(source, ['checkout', 'main'])

      execFileSync('git', ['clone', '--bare', source, remote], { stdio: 'ignore' })
      // Expose the head only through GitHub's refs/pull/<n>/head, then drop the
      // branch so origin has no refs/heads/<branch> — exactly a fork PR.
      execFileSync('git', ['-C', remote, 'update-ref', 'refs/pull/335/head', prHead], {
        stdio: 'ignore',
      })
      execFileSync('git', ['-C', remote, 'branch', '-D', 'pr-src'], { stdio: 'ignore' })
      execFileSync('git', ['clone', remote, project], { stdio: 'ignore' })
      mkdirSync(join(project, '.claude', 'worktrees'), { recursive: true })

      const sm = await loadSessionManager()
      const result = await sm.createPrSession(
        project,
        335,
        null,
        {},
        {
          prView: async () => ({
            headRefName: 'codex/fix-x',
            state: 'OPEN',
            title: 'docs: fix x',
            isCrossRepository: true,
            headRepositoryOwner: { login: 'contributor' },
            headRepository: { name: 's11' },
          }),
          createSessionForWorktree: async (p, worktreePath, label, tool) =>
            baseLocalSession({
              id: 'pr-335',
              projectPath: p,
              worktreeName: label ?? 'pr-335',
              worktreePath,
              branch: 'pr-335',
              tool: tool ?? 'claude',
            }),
        }
      )

      expect(typeof result).not.toBe('string')
      if (typeof result === 'string') throw new Error(result)
      expect(result.prIsFork).toBe(true)
      const worktreeTip = git(result.worktreePath, ['rev-parse', 'HEAD']).trim()
      expect(worktreeTip).toBe(prHead)
      // Fork PRs check out under a PR-scoped local branch, not the fork's head
      // branch name (which isn't unique across forks).
      const worktreeBranch = git(result.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
      expect(worktreeBranch).toBe('pr-335')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  gitIt('checks out the fork PR head, not the base branch, on a name collision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fork-pr-namecollide-'))
    try {
      const source = join(root, 'source')
      const remote = join(root, 'remote.git')
      const project = join(root, 'project')
      mkdirSync(source)
      git(source, ['init'])
      git(source, ['config', 'user.email', 'test@example.com'])
      git(source, ['config', 'user.name', 'Test User'])
      writeFileSync(join(source, 'file.txt'), 'one\n')
      git(source, ['add', 'file.txt'])
      git(source, ['commit', '-m', 'one'])
      git(source, ['branch', '-M', 'main'])

      // The base repo HAS a branch named "shared" (the fork PR's head branch
      // name collides with it) pointing at different commits than the PR head.
      git(source, ['checkout', '-b', 'shared'])
      writeFileSync(join(source, 'file.txt'), 'BASE shared branch\n')
      git(source, ['commit', '-am', 'base shared'])
      const baseSharedTip = git(source, ['rev-parse', 'HEAD']).trim()
      // The actual fork PR head, on its own branch, with different content.
      git(source, ['checkout', 'main'])
      git(source, ['checkout', '-b', 'fork-head'])
      writeFileSync(join(source, 'file.txt'), 'FORK pr head\n')
      git(source, ['commit', '-am', 'fork head'])
      const forkHead = git(source, ['rev-parse', 'HEAD']).trim()
      git(source, ['checkout', 'main'])

      execFileSync('git', ['clone', '--bare', source, remote], { stdio: 'ignore' })
      // Keep refs/heads/shared on origin (the collision); expose the fork PR head
      // only through refs/pull/501/head and drop its branch.
      execFileSync('git', ['-C', remote, 'update-ref', 'refs/pull/501/head', forkHead], {
        stdio: 'ignore',
      })
      execFileSync('git', ['-C', remote, 'branch', '-D', 'fork-head'], { stdio: 'ignore' })
      execFileSync('git', ['clone', remote, project], { stdio: 'ignore' })
      mkdirSync(join(project, '.claude', 'worktrees'), { recursive: true })

      const sm = await loadSessionManager()
      const result = await sm.createPrSession(
        project,
        501,
        null,
        {},
        {
          // The fork PR's head branch is named "shared" — the same name as the
          // base-repo branch that exists on origin.
          prView: async () => ({
            headRefName: 'shared',
            state: 'OPEN',
            title: 'fork pr',
            isCrossRepository: true,
            headRepositoryOwner: { login: 'contributor' },
            headRepository: { name: 'proj' },
          }),
          createSessionForWorktree: async (p, worktreePath, label, tool) =>
            baseLocalSession({
              id: 'pr-501',
              projectPath: p,
              worktreeName: label ?? 'pr-501',
              worktreePath,
              branch: 'pr-501',
              tool: tool ?? 'claude',
            }),
        }
      )

      expect(typeof result).not.toBe('string')
      if (typeof result === 'string') throw new Error(result)
      const worktreeTip = git(result.worktreePath, ['rev-parse', 'HEAD']).trim()
      // The worktree must hold the fork PR head, NOT origin/shared (the base
      // branch that shares the name).
      expect(worktreeTip).toBe(forkHead)
      expect(worktreeTip).not.toBe(baseSharedTip)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  gitIt('force-refreshes a stale pr-<n> branch after a PR force-push', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fork-pr-forcepush-'))
    try {
      const source = join(root, 'source')
      const remote = join(root, 'remote.git')
      const project = join(root, 'project')
      mkdirSync(source)
      git(source, ['init'])
      git(source, ['config', 'user.email', 'test@example.com'])
      git(source, ['config', 'user.name', 'Test User'])
      writeFileSync(join(source, 'file.txt'), 'one\n')
      git(source, ['add', 'file.txt'])
      git(source, ['commit', '-m', 'one'])
      git(source, ['branch', '-M', 'main'])

      // Two divergent fork-head commits (siblings off main): the old PR head and
      // the force-pushed new head. `newHead` is NOT a descendant of `oldHead`,
      // so a non-forced fetch into an existing pr-<n> at oldHead would reject.
      git(source, ['checkout', '-b', 'old'])
      writeFileSync(join(source, 'file.txt'), 'OLD head\n')
      git(source, ['commit', '-am', 'old head'])
      const oldHead = git(source, ['rev-parse', 'HEAD']).trim()
      git(source, ['checkout', 'main'])
      git(source, ['checkout', '-b', 'new'])
      writeFileSync(join(source, 'file.txt'), 'NEW head\n')
      git(source, ['commit', '-am', 'new head'])
      const newHead = git(source, ['rev-parse', 'HEAD']).trim()
      git(source, ['checkout', 'main'])

      execFileSync('git', ['clone', '--bare', source, remote], { stdio: 'ignore' })
      execFileSync('git', ['-C', remote, 'update-ref', 'refs/pull/601/head', oldHead], {
        stdio: 'ignore',
      })
      execFileSync('git', ['clone', remote, project], { stdio: 'ignore' })
      mkdirSync(join(project, '.claude', 'worktrees'), { recursive: true })

      // Simulate a previously-removed session: a leftover pr-601 branch at the
      // OLD head, with no worktree checked out.
      execFileSync('git', ['-C', project, 'fetch', 'origin', 'pull/601/head:pr-601'], {
        stdio: 'ignore',
      })
      expect(git(project, ['rev-parse', 'pr-601']).trim()).toBe(oldHead)

      // The contributor force-pushes: the PR head now points at the divergent
      // new commit.
      execFileSync('git', ['-C', remote, 'update-ref', 'refs/pull/601/head', newHead], {
        stdio: 'ignore',
      })

      const sm = await loadSessionManager()
      const result = await sm.createPrSession(
        project,
        601,
        null,
        {},
        {
          prView: async () => ({
            headRefName: 'feature',
            state: 'OPEN',
            title: 'fork pr',
            isCrossRepository: true,
            headRepositoryOwner: { login: 'contributor' },
            headRepository: { name: 'proj' },
          }),
          createSessionForWorktree: async (p, worktreePath, label, tool) =>
            baseLocalSession({
              id: 'pr-601',
              projectPath: p,
              worktreeName: label ?? 'pr-601',
              worktreePath,
              branch: 'pr-601',
              tool: tool ?? 'claude',
            }),
        }
      )

      expect(typeof result).not.toBe('string')
      if (typeof result === 'string') throw new Error(result)
      // The worktree must hold the force-pushed head, not the stale old commit.
      const worktreeTip = git(result.worktreePath, ['rev-parse', 'HEAD']).trim()
      expect(worktreeTip).toBe(newHead)
      expect(worktreeTip).not.toBe(oldHead)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  gitIt(
    'fails a fork PR rather than DWIM to origin/pr-<n> when the pull ref is missing',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'fork-pr-dwim-'))
      try {
        const source = join(root, 'source')
        const remote = join(root, 'remote.git')
        const project = join(root, 'project')
        mkdirSync(source)
        git(source, ['init'])
        git(source, ['config', 'user.email', 'test@example.com'])
        git(source, ['config', 'user.name', 'Test User'])
        writeFileSync(join(source, 'file.txt'), 'one\n')
        git(source, ['add', 'file.txt'])
        git(source, ['commit', '-m', 'one'])
        git(source, ['branch', '-M', 'main'])
        // The base repo has a branch literally named "pr-808" (unrelated commits).
        // There is NO refs/pull/808/head, so the fork pull-ref fetch will fail.
        git(source, ['checkout', '-b', 'pr-808'])
        writeFileSync(join(source, 'file.txt'), 'WRONG base pr-808 branch\n')
        git(source, ['commit', '-am', 'base pr-808'])
        const baseBranchTip = git(source, ['rev-parse', 'HEAD']).trim()
        git(source, ['checkout', 'main'])

        execFileSync('git', ['clone', '--bare', source, remote], { stdio: 'ignore' })
        execFileSync('git', ['clone', remote, project], { stdio: 'ignore' })
        mkdirSync(join(project, '.claude', 'worktrees'), { recursive: true })
        // origin/pr-808 now exists as a remote-tracking branch in the clone.
        expect(git(project, ['rev-parse', 'origin/pr-808']).trim()).toBe(baseBranchTip)

        const sm = await loadSessionManager()
        const result = await sm.createPrSession(
          project,
          808,
          null,
          {},
          {
            prView: async () => ({
              headRefName: 'feature',
              state: 'OPEN',
              title: 'fork pr',
              isCrossRepository: true,
              headRepositoryOwner: { login: 'contributor' },
              headRepository: { name: 'proj' },
            }),
            createSessionForWorktree: async (p, worktreePath) =>
              baseLocalSession({ id: 'pr-808', projectPath: p, worktreePath }),
          }
        )

        // The pull ref is missing, so creation must fail explicitly — not DWIM a
        // worktree onto origin/pr-808 (the unrelated base branch).
        expect(typeof result).toBe('string')
        expect(existsSync(join(project, '.claude', 'worktrees', 'pr-808'))).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  gitIt('does not let two fork PRs sharing a head branch name collide', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fork-pr-collide-'))
    try {
      const source = join(root, 'source')
      const remote = join(root, 'remote.git')
      const project = join(root, 'project')
      mkdirSync(source)
      git(source, ['init'])
      git(source, ['config', 'user.email', 'test@example.com'])
      git(source, ['config', 'user.name', 'Test User'])
      writeFileSync(join(source, 'file.txt'), 'one\n')
      git(source, ['add', 'file.txt'])
      git(source, ['commit', '-m', 'one'])
      git(source, ['branch', '-M', 'main'])

      // Two different fork heads that happen to share the branch name
      // "shared-fix": alice's PR #401 and bob's PR #402 point at different tips.
      git(source, ['checkout', '-b', 'alice'])
      writeFileSync(join(source, 'file.txt'), 'alice\n')
      git(source, ['commit', '-am', 'alice head'])
      const aliceHead = git(source, ['rev-parse', 'HEAD']).trim()
      git(source, ['checkout', 'main'])
      git(source, ['checkout', '-b', 'bob'])
      writeFileSync(join(source, 'file.txt'), 'bob\n')
      git(source, ['commit', '-am', 'bob head'])
      const bobHead = git(source, ['rev-parse', 'HEAD']).trim()
      git(source, ['checkout', 'main'])

      execFileSync('git', ['clone', '--bare', source, remote], { stdio: 'ignore' })
      execFileSync('git', ['-C', remote, 'update-ref', 'refs/pull/401/head', aliceHead], {
        stdio: 'ignore',
      })
      execFileSync('git', ['-C', remote, 'update-ref', 'refs/pull/402/head', bobHead], {
        stdio: 'ignore',
      })
      execFileSync('git', ['-C', remote, 'branch', '-D', 'alice'], { stdio: 'ignore' })
      execFileSync('git', ['-C', remote, 'branch', '-D', 'bob'], { stdio: 'ignore' })
      execFileSync('git', ['clone', remote, project], { stdio: 'ignore' })
      mkdirSync(join(project, '.claude', 'worktrees'), { recursive: true })

      const forkView = (owner: string) => async () => ({
        headRefName: 'shared-fix',
        state: 'OPEN',
        title: `fix from ${owner}`,
        isCrossRepository: true,
        headRepositoryOwner: { login: owner },
        headRepository: { name: 'proj' },
      })

      // Real adopt (no createSessionForWorktree stub) so sessions register in
      // the internal map and the reuse lookups can see the first session.
      const sm = await loadSessionManager()
      const a = await sm.createPrSession(project, 401, null, {}, { prView: forkView('alice') })
      const b = await sm.createPrSession(project, 402, null, {}, { prView: forkView('bob') })

      expect(typeof a).not.toBe('string')
      expect(typeof b).not.toBe('string')
      if (typeof a === 'string') throw new Error(a)
      if (typeof b === 'string') throw new Error(b)

      // Distinct sessions — the second PR must not hijack the first.
      expect(a.id).not.toBe(b.id)
      expect(a.prNumber).toBe(401)
      expect(b.prNumber).toBe(402)
      expect(a.prHeadRepo).toBe('alice/proj')
      expect(b.prHeadRepo).toBe('bob/proj')
      expect(a.worktreePath).not.toBe(b.worktreePath)
      // Each worktree points at its own PR head, not the other's.
      expect(git(a.worktreePath, ['rev-parse', 'HEAD']).trim()).toBe(aliceHead)
      expect(git(b.worktreePath, ['rev-parse', 'HEAD']).trim()).toBe(bobHead)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('createPrSessions', () => {
  it('skips numbers that already have a session and creates the rest', async () => {
    const sm = await loadSessionManager()
    writeSessionsJson([baseLocalSession({ id: 's-existing', prNumber: 7, projectPath: '/proj' })])
    sm.restoreSessions()

    const createPrSession = vi.fn(
      async (_projectPath: string, prNumber: number, _hostId: string | null) =>
        baseLocalSession({ id: `s-${prNumber}`, prNumber }) as Session | string
    )

    const result = await sm.createPrSessions('/proj', [7, 8, 9], null, {}, { createPrSession })
    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') throw new Error(result)

    expect(result.skipped).toEqual([7])
    expect(result.created.map((s) => s.prNumber).sort()).toEqual([8, 9])
    expect(result.failed).toEqual([])
    expect(createPrSession).toHaveBeenCalledTimes(2)
    expect(createPrSession).toHaveBeenCalledWith('/proj', 8, null, {})
    expect(createPrSession).toHaveBeenCalledWith('/proj', 9, null, {})
  })

  it('aggregates per-number failures into the summary', async () => {
    const sm = await loadSessionManager()
    const createPrSession = vi.fn(
      async (_projectPath: string, prNumber: number, _hostId: string | null) =>
        prNumber === 5
          ? `PR #${prNumber} not found.`
          : (baseLocalSession({ id: `s-${prNumber}`, prNumber }) as Session)
    )
    const result = await sm.createPrSessions('/proj', [4, 5, 6], null, {}, { createPrSession })
    if (typeof result === 'string') throw new Error(result)
    expect(result.created.map((s) => s.prNumber).sort()).toEqual([4, 6])
    expect(result.failed).toEqual([{ number: 5, error: 'PR #5 not found.' }])
    expect(result.skipped).toEqual([])
  })

  it('dedupes duplicate inputs before invoking createPrSession', async () => {
    const sm = await loadSessionManager()
    const createPrSession = vi.fn(
      async (_projectPath: string, prNumber: number, _hostId: string | null) =>
        baseLocalSession({ id: `s-${prNumber}`, prNumber }) as Session | string
    )
    const result = await sm.createPrSessions('/proj', [3, 3, 3], null, {}, { createPrSession })
    if (typeof result === 'string') throw new Error(result)
    expect(createPrSession).toHaveBeenCalledTimes(1)
    expect(createPrSession).toHaveBeenCalledWith('/proj', 3, null, {})
    expect(result.created.map((s) => s.prNumber)).toEqual([3])
  })

  it('does not skip numbers from sessions belonging to a different project', async () => {
    const sm = await loadSessionManager()
    writeSessionsJson([
      baseLocalSession({ id: 's-other', prNumber: 5, projectPath: '/other-proj' }),
    ])
    sm.restoreSessions()

    const createPrSession = vi.fn(
      async (_projectPath: string, prNumber: number, _hostId: string | null) =>
        baseLocalSession({ id: `s-${prNumber}`, prNumber }) as Session | string
    )
    const result = await sm.createPrSessions('/proj', [5], null, {}, { createPrSession })
    if (typeof result === 'string') throw new Error(result)
    expect(result.skipped).toEqual([])
    expect(result.created.map((s) => s.prNumber)).toEqual([5])
    expect(createPrSession).toHaveBeenCalledWith('/proj', 5, null, {})
  })

  it('returns an empty summary for an empty number list', async () => {
    const sm = await loadSessionManager()
    const createPrSession = vi.fn()
    const result = await sm.createPrSessions('/proj', [], null, {}, { createPrSession })
    if (typeof result === 'string') throw new Error(result)
    expect(result).toEqual({ created: [], reused: [], skipped: [], failed: [] })
    expect(createPrSession).not.toHaveBeenCalled()
  })

  it('classifies a returned pre-existing session as reused, not created', async () => {
    const sm = await loadSessionManager()
    const existing = baseLocalSession({
      id: 's-issue504',
      projectPath: '/proj',
      branch: 'vow/issue504',
      issueNumber: 504,
    })
    writeSessionsJson([existing])
    sm.restoreSessions()

    // Mirrors the real createPrSession reuse path: when the PR's head branch is
    // already checked out it returns the existing session tagged with the PR.
    const createPrSession = vi.fn(
      async (_projectPath: string, prNumber: number, _hostId: string | null) =>
        ({ ...existing, prNumber }) as Session | string
    )

    const result = await sm.createPrSessions('/proj', [545], null, {}, { createPrSession })
    if (typeof result === 'string') throw new Error(result)

    expect(result.created).toEqual([])
    expect(result.reused.map((s) => s.id)).toEqual(['s-issue504'])
    expect(result.reused[0].prNumber).toBe(545)
    expect(result.failed).toEqual([])
  })

  it('forwards the selected tool through options to createPrSession', async () => {
    const sm = await loadSessionManager()
    const createPrSession = vi.fn(
      async (_projectPath: string, prNumber: number, _hostId: string | null) =>
        baseLocalSession({ id: `s-${prNumber}`, prNumber }) as Session | string
    )
    await sm.createPrSessions('/proj', [11], null, { tool: 'codex' }, { createPrSession })
    expect(createPrSession).toHaveBeenCalledWith('/proj', 11, null, { tool: 'codex' })
  })

  it('serializes remote Codex session creation on the same host', async () => {
    const sm = await loadSessionManager()
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started: number[] = []
    const createPrSession = vi.fn(
      async (_projectPath: string, prNumber: number, _hostId: string | null) => {
        started.push(prNumber)
        if (prNumber === 8) await firstGate
        return baseLocalSession({ id: `s-${prNumber}`, prNumber }) as Session
      }
    )

    const resultPromise = sm.createPrSessions(
      '/proj',
      [8, 9],
      'h1',
      { tool: 'codex' },
      { createPrSession }
    )
    await Promise.resolve()
    expect(started).toEqual([8])

    releaseFirst()
    const result = await resultPromise
    if (typeof result === 'string') throw new Error(result)
    expect(started).toEqual([8, 9])
    expect(result.created.map((s) => s.prNumber)).toEqual([8, 9])
    expect(result.failed).toEqual([])
  })
})
