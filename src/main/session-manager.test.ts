import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool, Host, RemoteProject, Session, WorktreeBase } from '../shared/types'

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
  defaultTool: 'claude' as AgentTool,
  // Remote agent resolution returned by the mocked bootstrapHost. Unset means
  // "all three tools installed"; set it to a subset to exercise the
  // missing-agent path (e.g. { claude } while requesting codex).
  agentPaths: undefined as undefined | Partial<Record<AgentTool, string>>,
  runtimeStates: new Map<string, string>(),
  // Call logs for assertion.
  ensureHostConnectionCalls: [] as string[],
  createRemotePtyCalls: [] as {
    sessionId: string
    cwd: string
    hostId: string
    continueSession?: boolean
    tool?: AgentTool
    notifyHookPath?: string
    remoteSocketPath?: string
  }[],
  reattachRemotePtyCalls: [] as { sessionId: string; hostId: string }[],
  createPtyCalls: [] as { sessionId: string; cwd: string }[],
  reattachPtyCalls: [] as string[],
  detachPtyCalls: [] as string[],
  hasRemoteTmuxResult: new Map<string, boolean>(),
  probeRemoteTmuxResult: new Map<string, 'present' | 'absent' | 'unreachable'>(),
  // Captures the listener registered via setUnexpectedExitListener so tests
  // can invoke it synchronously without spinning up a real node-pty.
  unexpectedExitListener: null as null | ((sessionId: string) => void),
  // Fired inside createRemotePty before it resolves. Reproduces an agent/tmux
  // that exits quickly enough to beat session registration.
  createRemotePtySideEffect: null as null | ((sessionId: string) => void),
  // Per-session side effect fired before the probe resolves. Lets tests
  // simulate a concurrent reconnect advancing another session's state while
  // the batch is in flight.
  probeSideEffect: new Map<string, () => void>(),
  // Per-session side effect fired inside reattachRemotePty (i.e. during the
  // reattach await). Lets tests simulate a concurrent session.end → Keep
  // resolving a session to terminal while the reconnect is parked on reattach.
  reattachSideEffect: new Map<string, () => void>(),
  runtimeRefs: new Map<string, number>(),
  sessionsUpdatedBroadcasts: 0,
  execRemoteCalls: [] as { hostId: string; argv: string[] }[],
  execRemoteResults: new Map<
    string,
    { stdout: string; stderr: string; code: number; timedOut: boolean }
  >(),
  // Keyed by worktreePath: controls the remote `claude --continue` history probe
  // (hasRemoteClaudeConversationHistory). true → directory present (resume),
  // false → absent (spawn fresh). Unset falls through to the default code 0.
  claudeHistoryProbeResult: new Map<string, boolean>(),
  // Same shape as claudeHistoryProbeResult, for the remote omp equivalent
  // (hasRemoteOmpConversationHistory).
  ompHistoryProbeResult: new Map<string, boolean>(),
  // Toggle to simulate ensureHostConnection throwing.
  ensureHostConnectionThrows: null as null | { message: string; runtimeStateAfter: string },
  // When set, delays next ensureHostConnection resolution (used for idempotency
  // and cascade tests).
  ensureHostConnectionGate: null as null | Promise<void>,
  // Auto-reconnect config surfaced via getReconnectConfig; mutable per test.
  reconnectConfig: { enabled: true, initialDelayMs: 1000, maxDelayMs: 30000 },
  // Captured emitToast payloads for assertion.
  toasts: [] as { severity: string; title: string; detail?: string }[],
  hasPtyResult: new Set<string>(),
  // Session ids for which the mocked hasTmuxSession (local, synchronous)
  // reports a live tmux pane — i.e. reviveSession/attachLocalSession should
  // reattach instead of spawning fresh. Defaults to empty (always false),
  // matching every existing test's assumption.
  hasTmuxSessionIds: new Set<string>(),
  // Session ids for which the mocked destroyRemotePty rejects (simulates an
  // SSH teardown failure), for removeSession failure-path coverage.
  destroyRemotePtyThrows: new Set<string>(),
  // Response returned by the mocked cleanup dialog: 0 = Delete worktree,
  // 1 = Keep worktree, 2 = Keep and open in file manager.
  dialogResponse: 1,
  // When true, the mocked cleanup dialog rejects (simulates showMessageBox
  // failing — no window / IPC error) so the toast fallback can be exercised.
  dialogThrows: false,
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
    defaultTool: state.defaultTool,
    worktreeBase: state.worktreeBase,
  }),
  getReconnectConfig: () => state.reconnectConfig,
  getSandboxConfig: () => ({ enabled: true, extraWritablePaths: [] }),
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
  emitToast: (event: { severity: string; title: string; detail?: string }) => {
    state.toasts.push(event)
  },
}))

const showMessageBoxMock = vi.fn(async (..._args: unknown[]) => {
  if (state.dialogThrows) throw new Error('dialog failed')
  return { response: state.dialogResponse }
})

vi.mock('electron', () => ({
  dialog: {
    showMessageBox: showMessageBoxMock,
  },
  shell: {
    openPath: async () => '',
  },
}))

vi.mock('./project-scanner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./project-scanner')>()
  return {
    getRepoFingerprint: vi.fn(async () => state.repoFingerprint),
    gitWorktrees: vi.fn(async () => []),
    parseWorktreeList: actual.parseWorktreeList,
  }
})

vi.mock('./hook-installer', () => ({
  installHooks: vi.fn(async () => undefined),
  installRemoteHooks: vi.fn(async () => undefined),
  installCodexHooks: vi.fn(async () => ({})),
  installRemoteCodexHooks: vi.fn(async () => ({})),
  ensureCodexHooksFeatureFlag: vi.fn(),
  ensureRemoteCodexHooksFeatureFlag: vi.fn(async () => undefined),
  rollbackCodexHooks: vi.fn(),
  rollbackRemoteCodexHooks: vi.fn(async () => undefined),
  commitRemoteCodexHooks: vi.fn(async () => undefined),
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
    ompHookScriptPath: '/tmp/omp-notify-v1.ts',
    guardScriptPath: '/tmp/worktree-guard-v1.sh',
    sandboxAvailable: true,
    agentPaths: state.agentPaths ?? {
      claude: '/r/bin/claude',
      codex: '/r/bin/codex',
      omp: '/r/bin/omp',
    },
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
  destroyRemotePty: vi.fn(async (sessionId: string) => {
    if (state.destroyRemotePtyThrows.has(sessionId)) {
      throw new Error('ssh teardown failed')
    }
  }),
  hasPty: vi.fn((sessionId: string) => state.hasPtyResult.has(sessionId)),
  hasTmuxSession: vi.fn((sessionId: string) => state.hasTmuxSessionIds.has(sessionId)),
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
    const effect = state.reattachSideEffect.get(sessionId)
    if (effect) effect()
    // Match production: reattachRemotePty retains the host runtime for the
    // PTY's lifetime so the runtime survives the caller's release.
    state.runtimeRefs.set(host.hostId, (state.runtimeRefs.get(host.hostId) ?? 0) + 1)
  },
  createRemotePty: async (
    sessionId: string,
    cwd: string,
    host: Host,
    options?: {
      continueSession?: boolean
      tool?: AgentTool
      notifyHookPath?: string
      remoteSocketPath?: string
    }
  ) => {
    state.createRemotePtyCalls.push({
      sessionId,
      cwd,
      hostId: host.hostId,
      ...(options?.continueSession === undefined
        ? {}
        : { continueSession: options.continueSession }),
      tool: options?.tool,
      notifyHookPath: options?.notifyHookPath,
      remoteSocketPath: options?.remoteSocketPath,
    })
    state.runtimeRefs.set(host.hostId, (state.runtimeRefs.get(host.hostId) ?? 0) + 1)
    state.createRemotePtySideEffect?.(sessionId)
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
    // Conversation-history probe: matched by the recognizable `.claude/projects`
    // substring in its script so the test doesn't reproduce the exact (escaped,
    // multi-segment) probe command. The probed worktree path is the last arg.
    if (argv[0] === 'sh' && typeof argv[2] === 'string' && argv[2].includes('.claude/projects')) {
      const present = state.claudeHistoryProbeResult.get(argv[argv.length - 1])
      if (present !== undefined) {
        return { stdout: '', stderr: '', code: present ? 0 : 1, timedOut: false }
      }
    }
    // Same shape as the claude probe above, for hasRemoteOmpConversationHistory.
    if (
      argv[0] === 'sh' &&
      typeof argv[2] === 'string' &&
      argv[2].includes('.omp/agent/sessions')
    ) {
      const present = state.ompHistoryProbeResult.get(argv[argv.length - 1])
      if (present !== undefined) {
        return { stdout: '', stderr: '', code: present ? 0 : 1, timedOut: false }
      }
    }
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
  state.defaultTool = 'claude'
  state.agentPaths = undefined
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
  state.reattachSideEffect = new Map()
  state.execRemoteCalls = []
  state.execRemoteResults = new Map()
  state.claudeHistoryProbeResult = new Map()
  state.ompHistoryProbeResult = new Map()
  state.ensureHostConnectionThrows = null
  state.ensureHostConnectionGate = null
  state.unexpectedExitListener = null
  state.createRemotePtySideEffect = null
  state.reconnectConfig = { enabled: true, initialDelayMs: 1000, maxDelayMs: 30000 }
  state.toasts = []
  state.hasPtyResult = new Set()
  state.hasTmuxSessionIds = new Set()
  state.destroyRemotePtyThrows = new Set()
  state.dialogResponse = 1
  state.dialogThrows = false
  showMessageBoxMock.mockClear()
})

afterEach(() => {
  rmSync(state.configDir, { recursive: true, force: true })
})

describe('gitRemoteWorktrees', () => {
  it('lists remote worktrees and parses POSIX paths', async () => {
    const sm = await loadSessionManager()
    state.execRemoteResults.set('git -C /srv/proj worktree list --porcelain', {
      stdout: [
        'worktree /srv/proj',
        'HEAD abc',
        'branch refs/heads/main',
        '',
        'worktree /srv/proj/.claude/worktrees/feat-a',
        'HEAD def',
        'branch refs/heads/pewpew/feat-a',
        '',
      ].join('\n'),
      stderr: '',
      code: 0,
      timedOut: false,
    })

    const result = await sm.gitRemoteWorktrees(state.hosts[0], '/srv/proj')

    expect(result).toEqual([
      { name: 'proj', path: '/srv/proj', branch: 'main', isMain: true },
      {
        name: 'feat-a',
        path: '/srv/proj/.claude/worktrees/feat-a',
        branch: 'pewpew/feat-a',
        isMain: false,
      },
    ])
    expect(state.execRemoteCalls).toContainEqual({
      hostId: 'h1',
      argv: ['git', '-C', '/srv/proj', 'worktree', 'list', '--porcelain'],
    })
  })

  it('throws with stderr detail when the remote git command fails', async () => {
    const sm = await loadSessionManager()
    state.execRemoteResults.set('git -C /srv/proj worktree list --porcelain', {
      stdout: '',
      stderr: 'fatal: not a git repository',
      code: 128,
      timedOut: false,
    })

    await expect(sm.gitRemoteWorktrees(state.hosts[0], '/srv/proj')).rejects.toThrow(
      /not a git repository/
    )
  })
})

describe('createRemoteSessionForWorktree (adopt remote worktree)', () => {
  const projectPath = '/remote/proj'
  const worktreePath = '/remote/proj/.claude/worktrees/existing'

  function primeWorktree(branch = 'feature/existing'): void {
    state.remoteProjects = [{ hostId: 'h1', path: projectPath, name: 'proj' }]
    state.execRemoteResults.set(
      ['git', '-C', worktreePath, 'rev-parse', '--is-inside-work-tree'].join(' '),
      { stdout: 'true\n', stderr: '', code: 0, timedOut: false }
    )
    state.execRemoteResults.set(
      ['git', '-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'].join(' '),
      { stdout: `${branch}\n`, stderr: '', code: 0, timedOut: false }
    )
  }

  it('adopts an existing remote worktree without creating a new one', async () => {
    primeWorktree('feature/existing')
    const sm = await loadSessionManager()

    const session = await sm.createRemoteSessionForWorktree(
      'h1',
      projectPath,
      worktreePath,
      undefined,
      'claude'
    )

    expect(session.hostId).toBe('h1')
    expect(session.projectName).toBe('proj')
    expect(session.worktreeName).toBe('existing')
    expect(session.worktreePath).toBe(worktreePath)
    expect(session.branch).toBe('feature/existing')
    expect(session.connectionState).toBe('live')
    expect(session.tool).toBe('claude')
    expect(state.createRemotePtyCalls).toEqual([
      {
        sessionId: session.id,
        cwd: worktreePath,
        hostId: 'h1',
        tool: 'claude',
        notifyHookPath: '/tmp/omp-notify-v1.ts',
        remoteSocketPath: '/tmp/remote.sock',
      },
    ])
    const ranWorktreeAdd = state.execRemoteCalls.some(
      (c) => c.argv[0] === 'git' && c.argv.includes('worktree') && c.argv.includes('add')
    )
    expect(ranWorktreeAdd).toBe(false)
  })

  it('returns the existing session when the same worktree is adopted twice', async () => {
    primeWorktree()
    const sm = await loadSessionManager()

    const first = await sm.createRemoteSessionForWorktree(
      'h1',
      projectPath,
      worktreePath,
      undefined,
      'claude'
    )
    const second = await sm.createRemoteSessionForWorktree(
      'h1',
      projectPath,
      worktreePath,
      undefined,
      'claude'
    )

    expect(second.id).toBe(first.id)
    expect(sm.getSessions()).toHaveLength(1)
    expect(state.createRemotePtyCalls).toHaveLength(1)
  })

  it('replays a remote pty exit that lands before the session is registered', async () => {
    primeWorktree()
    state.reconnectConfig = { enabled: false, initialDelayMs: 1000, maxDelayMs: 30000 }
    const sm = await loadSessionManager()
    sm.initSessionManager()
    state.createRemotePtySideEffect = (sessionId) => state.unexpectedExitListener?.(sessionId)

    const session = await sm.createRemoteSessionForWorktree(
      'h1',
      projectPath,
      worktreePath,
      undefined,
      'claude'
    )

    expect(session.connectionState).toBe('offline')
  })

  it('rejects a mixed-tool adoption of the same worktree', async () => {
    primeWorktree()
    const sm = await loadSessionManager()

    await sm.createRemoteSessionForWorktree('h1', projectPath, worktreePath, undefined, 'claude')

    await expect(
      sm.createRemoteSessionForWorktree('h1', projectPath, worktreePath, undefined, 'codex')
    ).rejects.toThrow(/mixed tools/)
  })

  it('rejects when the path is not a git worktree', async () => {
    state.remoteProjects = [{ hostId: 'h1', path: projectPath, name: 'proj' }]
    state.execRemoteResults.set(
      ['git', '-C', worktreePath, 'rev-parse', '--is-inside-work-tree'].join(' '),
      { stdout: '', stderr: 'fatal: not a work tree', code: 128, timedOut: false }
    )
    const sm = await loadSessionManager()

    await expect(
      sm.createRemoteSessionForWorktree('h1', projectPath, worktreePath, undefined, 'claude')
    ).rejects.toThrow()
    expect(state.createRemotePtyCalls).toEqual([])
  })
})

describe('spawnRemoteSession — unified remote spawn seam', () => {
  const projectPath = '/remote/proj'

  function ranWorktreeAdd(): boolean {
    return state.execRemoteCalls.some((c) => c.argv.includes('worktree') && c.argv.includes('add'))
  }

  it('adopt: throws one unified (trailing-period) message and creates nothing when the agent is missing', async () => {
    state.remoteProjects = [{ hostId: 'h1', path: projectPath, name: 'proj' }]
    state.agentPaths = { claude: '/r/bin/claude' } // codex not installed
    const worktreePath = '/remote/proj/.claude/worktrees/existing'
    const sm = await loadSessionManager()

    await expect(
      sm.createRemoteSessionForWorktree('h1', projectPath, worktreePath, undefined, 'codex')
    ).rejects.toThrow('codex is not installed on host Dev.')
    expect(state.createRemotePtyCalls).toEqual([])
    expect(ranWorktreeAdd()).toBe(false)
  })

  it('create: fails fast on a missing agent — same unified message, before any worktree add', async () => {
    state.remoteProjects = [{ hostId: 'h1', path: projectPath, name: 'proj' }]
    state.agentPaths = { claude: '/r/bin/claude' } // codex not installed
    const sm = await loadSessionManager()

    await expect(sm.createSession(projectPath, 'feat', 'h1', { tool: 'codex' })).rejects.toThrow(
      'codex is not installed on host Dev.'
    )
    expect(state.createRemotePtyCalls).toEqual([])
    expect(ranWorktreeAdd()).toBe(false)
  })

  it('PR: the missing-agent check precedes the gh probe (returns the agent message, not a gh error)', async () => {
    state.remoteProjects = [{ hostId: 'h1', path: projectPath, name: 'proj' }]
    state.agentPaths = { claude: '/r/bin/claude' } // codex not installed
    // gh probe would fail too — the agent message must win.
    state.execRemoteResults.set('sh -c command -v gh >/dev/null 2>&1', {
      stdout: '',
      stderr: '',
      code: 1,
      timedOut: false,
    })
    const sm = await loadSessionManager()

    const result = await sm.createPrSession(projectPath, 42, 'h1', { tool: 'codex' })
    expect(result).toBe('codex is not installed on host Dev.')
    expect(ranWorktreeAdd()).toBe(false)
  })
})

describe('mirrorAllWorktrees — remote', () => {
  const projectPath = '/remote/proj'
  const wtA = '/remote/proj/.claude/worktrees/feat-a'
  const wtB = '/remote/proj/.claude/worktrees/feat-b'

  function primeList(): void {
    state.remoteProjects = [{ hostId: 'h1', path: projectPath, name: 'proj' }]
    state.execRemoteResults.set('git -C /remote/proj worktree list --porcelain', {
      stdout: [
        'worktree /remote/proj',
        'HEAD a',
        'branch refs/heads/main',
        '',
        `worktree ${wtA}`,
        'HEAD b',
        'branch refs/heads/pewpew/feat-a',
        '',
        `worktree ${wtB}`,
        'HEAD c',
        'branch refs/heads/pewpew/feat-b',
        '',
      ].join('\n'),
      stderr: '',
      code: 0,
      timedOut: false,
    })
    for (const wt of [wtA, wtB]) {
      state.execRemoteResults.set(
        ['git', '-C', wt, 'rev-parse', '--is-inside-work-tree'].join(' '),
        { stdout: 'true\n', stderr: '', code: 0, timedOut: false }
      )
      state.execRemoteResults.set(
        ['git', '-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'].join(' '),
        {
          stdout: 'branch\n',
          stderr: '',
          code: 0,
          timedOut: false,
        }
      )
    }
  }

  it('adopts every non-main remote worktree', async () => {
    primeList()
    const sm = await loadSessionManager()

    const result = await sm.mirrorAllWorktrees(projectPath, 'h1')

    expect(result.failed).toEqual([])
    expect(new Set(result.mirrored.map((s) => s.worktreePath))).toEqual(new Set([wtA, wtB]))
    expect(state.createRemotePtyCalls).toHaveLength(2)
  })

  it('skips the main worktree and already-adopted worktrees', async () => {
    primeList()
    const sm = await loadSessionManager()
    await sm.createRemoteSessionForWorktree('h1', projectPath, wtA, undefined, 'claude')
    state.createRemotePtyCalls = []

    const result = await sm.mirrorAllWorktrees(projectPath, 'h1')

    expect(result.mirrored.map((s) => s.worktreePath)).toEqual([wtB])
    expect(state.createRemotePtyCalls).toHaveLength(1)
  })
})

describe('mirrorAllWorktrees — remote Codex serialization', () => {
  const projectPath = '/remote/proj'
  const wtA = '/remote/proj/.claude/worktrees/feat-a'
  const wtB = '/remote/proj/.claude/worktrees/feat-b'

  function primeList(): void {
    state.remoteProjects = [{ hostId: 'h1', path: projectPath, name: 'proj' }]
    state.execRemoteResults.set('git -C /remote/proj worktree list --porcelain', {
      stdout: [
        'worktree /remote/proj',
        'HEAD a',
        'branch refs/heads/main',
        '',
        `worktree ${wtA}`,
        'HEAD b',
        'branch refs/heads/pewpew/feat-a',
        '',
        `worktree ${wtB}`,
        'HEAD c',
        'branch refs/heads/pewpew/feat-b',
        '',
      ].join('\n'),
      stderr: '',
      code: 0,
      timedOut: false,
    })
  }

  function gatedAdopt(started: string[], gateFor: string, gate: Promise<void>) {
    return async (wt: { path: string }): Promise<Session> => {
      started.push(wt.path)
      if (wt.path === gateFor) await gate
      return baseRemoteSession({ id: `s-${started.length}`, hostId: 'h1', worktreePath: wt.path })
    }
  }

  it('serializes adoptions when the default tool is Codex', async () => {
    state.defaultTool = 'codex'
    primeList()
    const sm = await loadSessionManager()
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started: string[] = []

    const resultPromise = sm.mirrorAllWorktrees(projectPath, 'h1', {
      adopt: gatedAdopt(started, wtA, firstGate),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Second adoption must not start until the first resolves.
    expect(started).toEqual([wtA])

    releaseFirst()
    const result = await resultPromise
    expect(started).toEqual([wtA, wtB])
    expect(result.mirrored).toHaveLength(2)
    expect(result.failed).toEqual([])
  })

  it('adopts in parallel for the default (non-Codex) tool', async () => {
    state.defaultTool = 'claude'
    primeList()
    const sm = await loadSessionManager()
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started: string[] = []

    const resultPromise = sm.mirrorAllWorktrees(projectPath, 'h1', {
      adopt: gatedAdopt(started, wtA, firstGate),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Both adoptions start before the first resolves.
    expect(started).toEqual([wtA, wtB])

    releaseFirst()
    const result = await resultPromise
    expect(result.mirrored).toHaveLength(2)
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
  it('is a no-op for a terminal (completed/error) session', async () => {
    // A kept remote session persists as 'completed'; deriveRestoredState brings it
    // back with connectionState 'pending', which re-exposes the Reconnect affordance.
    // Triggering reconnect must not probe-and-flip a terminal session to 'dead'.
    for (const status of ['completed', 'error'] as const) {
      writeSessionsJson([baseRemoteSession({ id: 'r1', status })])
      state.hasRemoteTmuxResult.set('r1', false) // would flip to dead if it probed
      const sm = await loadSessionManager()
      sm.restoreSessions()
      expect(sm.getSessions()[0].status).toBe(status)

      await sm.reconnectRemoteSession('r1')

      expect(sm.getSessions()[0].status).toBe(status)
      expect(state.ensureHostConnectionCalls).toEqual([])
      expect(state.reattachRemotePtyCalls).toEqual([])
    }
  })

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

  it('present + session goes terminal during reattach await → terminal status preserved', async () => {
    // Regression: the probe transition is computed from the pre-reattach status,
    // but reattachRemotePty awaits (SSH + scrollback). If a concurrent
    // session.end → promptCleanup → Keep resolves the session to 'completed'
    // (connectionState 'live') during that await, applying a cached
    // 'running → idle' delta would revert the user's Keep. The reconnect must
    // re-derive the transition against the post-await status and leave a
    // now-terminal session untouched.
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'running' })])
    state.hasRemoteTmuxResult.set('r1', true) // probe → present
    const sm = await loadSessionManager()
    sm.restoreSessions()
    // restore maps remote `running` → `idle`; drive it back to `running` (a live
    // session that resumed activity before the connection dropped) so the probe
    // transition is computed with `status: 'idle'` baked in — the delta the race
    // would otherwise clobber the Keep with.
    sm.getSessions().find((s) => s.id === 'r1')!.status = 'running'
    // Mimic the concurrent Keep landing while parked on the reattach await.
    state.reattachSideEffect.set('r1', () => {
      const live = sm.getSessions().find((s) => s.id === 'r1')!
      live.status = 'completed'
      live.connectionState = 'live'
    })

    await sm.reconnectRemoteSession('r1')

    const got = sm.getSessions()[0]
    expect(got.status).toBe('completed') // not clobbered back to 'idle'
    expect(got.connectionState).toBe('live')
    expect(state.reattachRemotePtyCalls).toEqual([{ sessionId: 'r1', hostId: 'h1' }])
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

describe('removeSession', () => {
  // Regression: destroyPty/destroyRemotePty deliver a real kill signal to the
  // agent process (unlike killSession's detach-only local path), and some
  // tools' SessionEnd-equivalent hook completes fast enough over that signal
  // to land while removeWorktree's git subprocess is still running below —
  // before the session is even out of the `sessions` map. Without
  // removeSession adding to cleanupInProgress up front, that races the
  // explicit, dialog-free delete here against a "clean up worktree?" prompt
  // for a worktree already being (or already) force-removed.
  it('suppresses a racing session.end dialog while tearing down the worktree', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'idle' })
    mkdirSync(local.worktreePath, { recursive: true })
    writeSessionsJson([local])
    const sm = await loadSessionManager()
    sm.restoreSessions()

    const removePromise = sm.removeSession('l1')
    // removeSession's synchronous prefix (cleanupInProgress.add) has already
    // run by this point — JS doesn't yield until removeSession's first await
    // — so promptCleanup's own guard is guaranteed to see it below.
    sm.handleHookEvent('session.end', { cwd: local.worktreePath }, null)

    await removePromise

    expect(showMessageBoxMock).not.toHaveBeenCalled()
    expect(sm.getSessions()).toEqual([])
  })

  // Regression: cleanupInProgress.add(id) ran unconditionally with nothing to
  // release it if a fallible step below threw — getRequiredHost throws
  // synchronously for a removed host, destroyRemotePty throws on SSH
  // failures, and removeSession is called directly from the
  // sessions:remove(-batch) IPC handlers (not just via promptCleanup), which
  // swallow the error. That left the session alive but permanently stuck in
  // cleanupInProgress, silently no-oping every future session.end for it.
  it('releases cleanupInProgress and keeps the session alive when teardown fails', async () => {
    const remote = baseRemoteSession({ id: 'r1', status: 'idle' })
    writeSessionsJson([remote])
    state.destroyRemotePtyThrows.add('r1')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await expect(sm.removeSession('r1')).rejects.toThrow('ssh teardown failed')

    // The session must survive a failed removal.
    expect(sm.getSessions().map((s) => s.id)).toEqual(['r1'])

    // cleanupInProgress must have been released: a later session.end for this
    // session should open the cleanup dialog normally, not silently no-op.
    sm.handleHookEvent('session.end', { cwd: remote.worktreePath }, 'h1')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(showMessageBoxMock).toHaveBeenCalledTimes(1)
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

  it('skips a kept terminal (completed) session left pending by restore', async () => {
    // deriveRestoredState lazily marks a kept remote session 'completed' + 'pending'.
    // A sibling-triggered batch probe must not sweep it up and flip it to 'dead',
    // which would silently undo the user's Keep after an app restart.
    writeSessionsJson([
      baseRemoteSession({ id: 'a', hostId: 'h1', status: 'idle' }),
      baseRemoteSession({ id: 'kept', hostId: 'h1', status: 'completed' }),
    ] as Session[])
    state.hasRemoteTmuxResult.set('a', true)
    state.hasRemoteTmuxResult.set('kept', false) // tmux gone — would flip to dead if probed
    state.runtimeStates.set('h1', 'live')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.probePendingSessionsOnHost('h1')

    const byId = Object.fromEntries(sm.getSessions().map((s) => [s.id, s]))
    expect(byId['a'].connectionState).toBe('live') // live sibling still probed
    expect(byId['kept'].status).toBe('completed') // terminal session untouched
    expect(state.reattachRemotePtyCalls.map((c) => c.sessionId)).toEqual(['a'])
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

  it('a Keep landing during a batch probe is not clobbered back to dead', async () => {
    // Batch-path analogue of the in-flight-probe race: while 'kept' is inside its
    // probe, a concurrent session.end → promptCleanup → Keep marks it completed.
    // The probe's later 'absent' result must not overwrite that back to 'dead'.
    writeSessionsJson([
      baseRemoteSession({ id: 'a', hostId: 'h1', status: 'idle' }),
      baseRemoteSession({ id: 'kept', hostId: 'h1', status: 'idle' }),
    ] as Session[])
    state.hasRemoteTmuxResult.set('a', true)
    state.hasRemoteTmuxResult.set('kept', false) // probe → absent
    state.runtimeStates.set('h1', 'live')
    const sm = await loadSessionManager()
    sm.restoreSessions()

    // Simulate the Keep landing (status → completed) while 'kept' is being probed.
    state.probeSideEffect.set('kept', () => {
      const kept = sm.getSessions().find((s) => s.id === 'kept')!
      kept.status = 'completed'
      kept.connectionState = 'live'
    })

    await sm.probePendingSessionsOnHost('h1')

    const byId = Object.fromEntries(sm.getSessions().map((s) => [s.id, s]))
    expect(byId['kept'].status).toBe('completed') // Keep preserved, not clobbered
    expect(byId['a'].connectionState).toBe('live') // live sibling still reconnected
  })

  it('a Keep landing during a batch reattach is not clobbered back to idle', async () => {
    // Batch-path analogue of the reattach-await race (regression-tested for the
    // single-session path in reconnectRemoteSession). Unlike the probe-await guard
    // above, this exercises the window *after* the terminal check, while a pending
    // 'present' sibling is parked inside reattachRemotePty: a concurrent
    // session.end → Keep marks it completed. Re-deriving the transition after the
    // await must drop the stale running → idle delta so the Keep survives.
    writeSessionsJson([
      baseRemoteSession({ id: 'a', hostId: 'h1', status: 'idle' }),
      baseRemoteSession({ id: 'kept', hostId: 'h1', status: 'idle' }),
    ] as Session[])
    state.hasRemoteTmuxResult.set('a', true)
    state.hasRemoteTmuxResult.set('kept', true) // probe → present → reattach
    state.runtimeStates.set('h1', 'live')
    const sm = await loadSessionManager()
    sm.restoreSessions()
    // restore maps remote running → idle; drive 'kept' back to running so its
    // present transition bakes status: 'idle' — the delta the race would clobber with.
    sm.getSessions().find((s) => s.id === 'kept')!.status = 'running'
    // Keep lands (status → completed) while 'kept' is parked on its reattach await.
    state.reattachSideEffect.set('kept', () => {
      const kept = sm.getSessions().find((s) => s.id === 'kept')!
      kept.status = 'completed'
      kept.connectionState = 'live'
    })

    await sm.probePendingSessionsOnHost('h1')

    const byId = Object.fromEntries(sm.getSessions().map((s) => [s.id, s]))
    expect(byId['kept'].status).toBe('completed') // not clobbered back to 'idle'
    expect(byId['kept'].connectionState).toBe('live')
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

  it('reinstalls hooks before spawning a fresh pty', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'idle' })
    mkdirSync(local.worktreePath, { recursive: true })
    writeSessionsJson([local])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    const { installHooks } = await import('./hook-installer')
    vi.mocked(installHooks).mockClear()

    await sm.attachLocalSession('l1')

    expect(installHooks).toHaveBeenCalledWith(local.worktreePath, { skipGitignore: true })
    expect(state.createPtyCalls.map((c) => c.sessionId)).toEqual(['l1'])
  })

  // Regression: before this PR, attach never touched hooks, so a pending
  // session always spawned successfully regardless of hook file state. A
  // failed reinstall (permissions, full disk, ...) must not turn that
  // previously-infallible path into one that marks the session dead.
  it('still spawns when hook reinstall fails', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'idle' })
    mkdirSync(local.worktreePath, { recursive: true })
    writeSessionsJson([local])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    const { installHooks } = await import('./hook-installer')
    vi.mocked(installHooks).mockRejectedValueOnce(new Error('EACCES'))

    await sm.attachLocalSession('l1')

    const got = sm.getSessions()[0]
    expect(got.status).toBe('idle')
    expect(got.connectionState).toBeUndefined()
    expect(state.createPtyCalls.map((c) => c.sessionId)).toEqual(['l1'])
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

describe('reviveSession — remote resume fallback', () => {
  // Regression: the remote branch hardcoded `--continue`, so reviving a remote
  // session with no prior conversation (e.g. a freshly mirrored worktree)
  // spawned `claude --continue`, which prints "No conversation found to
  // continue" and collapses the pane. It must spawn fresh instead.
  it('spawns fresh when the remote has no claude conversation history', async () => {
    const remote = baseRemoteSession({ id: 'r1', status: 'dead' })
    writeSessionsJson([remote])
    state.claudeHistoryProbeResult.set(remote.worktreePath, false)
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reviveSession('r1')

    expect(state.createRemotePtyCalls).toEqual([
      {
        sessionId: 'r1',
        cwd: remote.worktreePath,
        hostId: 'h1',
        continueSession: false,
        tool: 'claude',
        notifyHookPath: '/tmp/omp-notify-v1.ts',
        remoteSocketPath: '/tmp/remote.sock',
      },
    ])
    expect(sm.getSessions()[0].status).toBe('idle')
  })

  it('resumes when the remote has claude conversation history', async () => {
    const remote = baseRemoteSession({ id: 'r1', status: 'dead' })
    writeSessionsJson([remote])
    state.claudeHistoryProbeResult.set(remote.worktreePath, true)
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reviveSession('r1')

    expect(state.createRemotePtyCalls).toEqual([
      {
        sessionId: 'r1',
        cwd: remote.worktreePath,
        hostId: 'h1',
        continueSession: true,
        tool: 'claude',
        notifyHookPath: '/tmp/omp-notify-v1.ts',
        remoteSocketPath: '/tmp/remote.sock',
      },
    ])
  })

  // Byte-pin the composed remote history-probe script. The suite mocks
  // execRemote by argv *substring*, so a dropped `; ` or altered quote in the
  // shared CLAUDE_ENCODE_SHELL_SCRIPT fragment would otherwise ship green.
  // Expected value is the exact literal that sat inline before extraction
  // (independent source of truth), so this guards that the refactor is
  // byte-for-byte behaviour-preserving at the seam between the fragment and
  // the `ls -A` tail.
  it('sends the exact remote claude history-probe script', async () => {
    const remote = baseRemoteSession({ id: 'r1', status: 'dead' })
    writeSessionsJson([remote])
    state.claudeHistoryProbeResult.set(remote.worktreePath, true)
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reviveSession('r1')

    const probe = state.execRemoteCalls.find(
      (c) =>
        c.argv[0] === 'sh' &&
        typeof c.argv[2] === 'string' &&
        c.argv[2].includes('.claude/projects')
    )
    expect(probe).toBeDefined()
    expect(probe?.argv).toEqual([
      'sh',
      '-c',
      `p=$(CDPATH= cd -P -- "$1" 2>/dev/null && pwd -P); [ -n "$p" ] || p="$1"; enc=$(printf '%s' "$p" | sed 's/[^a-zA-Z0-9-]/-/g'); [ -n "$(ls -A "$HOME/.claude/projects/$enc" 2>/dev/null)" ]`,
      '_',
      remote.worktreePath,
    ])
  })

  it('spawns fresh when the remote has no omp conversation history', async () => {
    const remote = baseRemoteSession({ id: 'r1', status: 'dead', tool: 'omp' })
    writeSessionsJson([remote])
    state.ompHistoryProbeResult.set(remote.worktreePath, false)
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reviveSession('r1')

    expect(state.createRemotePtyCalls).toEqual([
      {
        sessionId: 'r1',
        cwd: remote.worktreePath,
        hostId: 'h1',
        continueSession: false,
        tool: 'omp',
        notifyHookPath: '/tmp/omp-notify-v1.ts',
        remoteSocketPath: '/tmp/remote.sock',
      },
    ])
    expect(sm.getSessions()[0].status).toBe('idle')
  })

  it('resumes when the remote has omp conversation history', async () => {
    const remote = baseRemoteSession({ id: 'r1', status: 'dead', tool: 'omp' })
    writeSessionsJson([remote])
    state.ompHistoryProbeResult.set(remote.worktreePath, true)
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reviveSession('r1')

    expect(state.createRemotePtyCalls).toEqual([
      {
        sessionId: 'r1',
        cwd: remote.worktreePath,
        hostId: 'h1',
        continueSession: true,
        tool: 'omp',
        notifyHookPath: '/tmp/omp-notify-v1.ts',
        remoteSocketPath: '/tmp/remote.sock',
      },
    ])
  })

  it('spawns fresh for codex without a captured agentSessionId', async () => {
    const remote = baseRemoteSession({ id: 'r1', status: 'dead', tool: 'codex' })
    writeSessionsJson([remote])
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.reviveSession('r1')

    expect(state.createRemotePtyCalls).toEqual([
      {
        sessionId: 'r1',
        cwd: remote.worktreePath,
        hostId: 'h1',
        continueSession: false,
        tool: 'codex',
        notifyHookPath: '/tmp/omp-notify-v1.ts',
        remoteSocketPath: '/tmp/remote.sock',
      },
    ])
  })
})

describe('reviveSession — reinstalls hooks on fresh spawn', () => {
  // Regression: hooks (notify.sh, worktree-guard.sh) are only installed into
  // a worktree's settings.local.json at session creation time. A session
  // revived long after creation — possibly before a hook fix even existed —
  // would otherwise run forever against whatever was installed back then.
  // Reinstalling right before a fresh process spawn (never on reattach,
  // since a live agent process already read its hook config at its own
  // start) keeps every revived session current.
  it('local: reinstalls hooks before spawning a fresh pty', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'idle' })
    mkdirSync(local.worktreePath, { recursive: true })
    writeSessionsJson([local])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    await sm.killSession('l1')
    const { installHooks } = await import('./hook-installer')
    vi.mocked(installHooks).mockClear()
    state.createPtyCalls = []

    await sm.reviveSession('l1')

    expect(installHooks).toHaveBeenCalledWith(local.worktreePath, { skipGitignore: true })
    expect(state.createPtyCalls.map((c) => c.sessionId)).toEqual(['l1'])
  })

  it('local: does not reinstall hooks when reattaching to a live tmux session', async () => {
    const local = baseLocalSession({ id: 'l1', status: 'idle' })
    mkdirSync(local.worktreePath, { recursive: true })
    writeSessionsJson([local])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    await sm.killSession('l1')
    state.hasTmuxSessionIds.add('l1')
    const { installHooks } = await import('./hook-installer')
    vi.mocked(installHooks).mockClear()

    await sm.reviveSession('l1')

    expect(installHooks).not.toHaveBeenCalled()
    expect(state.reattachPtyCalls).toEqual(['l1'])
  })

  it('remote: reinstalls hooks before spawning a fresh pty', async () => {
    const remote = baseRemoteSession({ id: 'r1', status: 'dead' })
    writeSessionsJson([remote])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    const { installRemoteHooks } = await import('./hook-installer')
    vi.mocked(installRemoteHooks).mockClear()

    await sm.reviveSession('r1')

    expect(installRemoteHooks).toHaveBeenCalledTimes(1)
    const [, worktreePath, notifyScriptPath, guardScriptPath] =
      vi.mocked(installRemoteHooks).mock.calls[0]
    expect(worktreePath).toBe(remote.worktreePath)
    expect(notifyScriptPath).toBe('/tmp/notify-v1.sh')
    expect(guardScriptPath).toBe('/tmp/worktree-guard-v1.sh')
    expect(state.createRemotePtyCalls.map((c) => c.sessionId)).toEqual(['r1'])
  })

  it('remote: does not reinstall hooks when reattaching to a live tmux session', async () => {
    const remote = baseRemoteSession({ id: 'r1', status: 'dead' })
    writeSessionsJson([remote])
    state.hasRemoteTmuxResult.set('r1', true)
    const sm = await loadSessionManager()
    sm.restoreSessions()
    const { installRemoteHooks } = await import('./hook-installer')
    vi.mocked(installRemoteHooks).mockClear()

    await sm.reviveSession('r1')

    expect(installRemoteHooks).not.toHaveBeenCalled()
    expect(state.reattachRemotePtyCalls.map((c) => c.sessionId)).toEqual(['r1'])
  })

  // Regression: installRemoteAgentHooks' mkdir -p would otherwise silently
  // resurrect a deleted remote worktree as an empty, non-git directory —
  // mirroring the local branch's existsSync guard so a missing worktree still
  // reaches (and fails loudly in) the tmux spawn instead.
  it('remote: does not reinstall hooks, but still attempts spawn, when the worktree no longer exists', async () => {
    const remote = baseRemoteSession({ id: 'r1', status: 'dead' })
    writeSessionsJson([remote])
    state.execRemoteResults.set(`test -d ${remote.worktreePath}`, {
      stdout: '',
      stderr: '',
      code: 1,
      timedOut: false,
    })
    const sm = await loadSessionManager()
    sm.restoreSessions()
    const { installRemoteHooks } = await import('./hook-installer')
    vi.mocked(installRemoteHooks).mockClear()

    await sm.reviveSession('r1')

    expect(installRemoteHooks).not.toHaveBeenCalled()
    expect(state.createRemotePtyCalls.map((c) => c.sessionId)).toEqual(['r1'])
  })

  // Regression: hasRemoteWorktree must not treat a transport/exec failure the
  // same as a genuinely missing worktree (code 1) — execRemote never rejects,
  // so a probe timeout has to throw explicitly, or a transient SSH hiccup
  // would silently skip the hook reinstall while still letting the spawn
  // below proceed once the connection recovers, defeating this PR's point.
  it('remote: aborts the revive when the worktree probe times out', async () => {
    const remote = baseRemoteSession({ id: 'r1', status: 'dead' })
    writeSessionsJson([remote])
    state.execRemoteResults.set(`test -d ${remote.worktreePath}`, {
      stdout: '',
      stderr: '',
      code: 1,
      timedOut: true,
    })
    const sm = await loadSessionManager()
    sm.restoreSessions()
    const { installRemoteHooks } = await import('./hook-installer')
    vi.mocked(installRemoteHooks).mockClear()

    await expect(sm.reviveSession('r1')).rejects.toThrow(/Timed out/)

    expect(installRemoteHooks).not.toHaveBeenCalled()
    expect(state.createRemotePtyCalls).toEqual([])
    expect(sm.getSessions()[0].connectionState).toBe('offline')
  })

  // Same reasoning, for an SSH-level failure (e.g. exit 255 on a dropped
  // connection) rather than a timeout — any code other than the clean 0/1
  // pair from a successfully-run `test -d` must abort, not skip-and-continue.
  it('remote: aborts the revive when the worktree probe fails at the SSH level', async () => {
    const remote = baseRemoteSession({ id: 'r1', status: 'dead' })
    writeSessionsJson([remote])
    state.execRemoteResults.set(`test -d ${remote.worktreePath}`, {
      stdout: '',
      stderr: 'ssh: connect to host example.com port 22: Connection refused',
      code: 255,
      timedOut: false,
    })
    const sm = await loadSessionManager()
    sm.restoreSessions()
    const { installRemoteHooks } = await import('./hook-installer')
    vi.mocked(installRemoteHooks).mockClear()

    await expect(sm.reviveSession('r1')).rejects.toThrow(/Connection refused/)

    expect(installRemoteHooks).not.toHaveBeenCalled()
    expect(state.createRemotePtyCalls).toEqual([])
    expect(sm.getSessions()[0].connectionState).toBe('offline')
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

  it('remote drop with reconnect enabled → connecting + drop toast', async () => {
    const remote = baseRemoteSession({ id: 'r1', status: 'running' })
    writeSessionsJson([remote])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.initSessionManager()

    state.unexpectedExitListener?.('r1')

    expect(sm.getSessions()[0].connectionState).toBe('connecting')
    expect(state.toasts).toEqual([
      { severity: 'warning', title: 'Connection to Dev lost — reconnecting…' },
    ])
    sm.stopSessionManager() // cancel the armed backoff timer
  })

  it('remote drop with reconnect disabled → offline overlay, no toast', async () => {
    state.reconnectConfig = { enabled: false, initialDelayMs: 1000, maxDelayMs: 30000 }
    const remote = baseRemoteSession({ id: 'r1', status: 'running' })
    writeSessionsJson([remote])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.initSessionManager()

    state.unexpectedExitListener?.('r1')

    expect(sm.getSessions()[0].connectionState).toBe('offline')
    expect(state.toasts).toEqual([])
  })

  it('does not auto-reconnect an already-dead remote session', async () => {
    const remote = baseRemoteSession({ id: 'r1', status: 'dead' })
    writeSessionsJson([remote])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.initSessionManager()

    state.unexpectedExitListener?.('r1')

    expect(state.toasts).toEqual([])
    expect(sm.getSessions()[0].connectionState).not.toBe('connecting')
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

describe('relocateProject', () => {
  it('reinstalls the guard hook with the new worktreePath for remapped Claude sessions', async () => {
    const oldProjectPath = mkdtempSync(join(tmpdir(), 'reloc-old-'))
    const newProjectPath = mkdtempSync(join(tmpdir(), 'reloc-new-'))
    writeFileSync(join(newProjectPath, '.git'), '')

    const oldWorktreePath = join(oldProjectPath, '.claude', 'worktrees', 'feat-x')
    mkdirSync(oldWorktreePath, { recursive: true })
    const newWorktreePath = join(newProjectPath, '.claude', 'worktrees', 'feat-x')
    mkdirSync(newWorktreePath, { recursive: true })

    writeSessionsJson([
      baseLocalSession({
        id: 'l1',
        projectPath: oldProjectPath,
        worktreePath: oldWorktreePath,
        tool: 'claude',
      }),
    ])

    const sm = await loadSessionManager()
    sm.restoreSessions()
    const { installHooks } = await import('./hook-installer')
    vi.mocked(installHooks).mockClear()

    try {
      await sm.relocateProject(oldProjectPath, newProjectPath)

      expect(installHooks).toHaveBeenCalledWith(newWorktreePath, { skipGitignore: true })
      expect(sm.getSessions()[0].worktreePath).toBe(newWorktreePath)
    } finally {
      rmSync(oldProjectPath, { recursive: true, force: true })
      rmSync(newProjectPath, { recursive: true, force: true })
    }
  })

  it('reinstalls the guard hook before recreating the PTY, so a relocated session never launches against the stale root', async () => {
    const oldProjectPath = mkdtempSync(join(tmpdir(), 'reloc-old-'))
    const newProjectPath = mkdtempSync(join(tmpdir(), 'reloc-new-'))
    writeFileSync(join(newProjectPath, '.git'), '')

    const oldWorktreePath = join(oldProjectPath, '.claude', 'worktrees', 'feat-x')
    mkdirSync(oldWorktreePath, { recursive: true })
    const newWorktreePath = join(newProjectPath, '.claude', 'worktrees', 'feat-x')
    mkdirSync(newWorktreePath, { recursive: true })

    writeSessionsJson([
      baseLocalSession({
        id: 'l1',
        projectPath: oldProjectPath,
        worktreePath: oldWorktreePath,
        tool: 'claude',
      }),
    ])

    const sm = await loadSessionManager()
    sm.restoreSessions()
    state.hasPtyResult.add('l1')
    const { installHooks } = await import('./hook-installer')
    vi.mocked(installHooks).mockClear()
    let createPtyCallCountWhenInstallHooksRan: number | undefined
    vi.mocked(installHooks).mockImplementationOnce(async () => {
      createPtyCallCountWhenInstallHooksRan = state.createPtyCalls.length
    })

    try {
      await sm.relocateProject(oldProjectPath, newProjectPath)

      // If the PTY were recreated first, Claude would already be running
      // (and would have read the stale hook config) by the time the guard
      // is reinstalled with the new root.
      expect(createPtyCallCountWhenInstallHooksRan).toBe(0)
      expect(state.createPtyCalls.map((c) => c.sessionId)).toEqual(['l1'])
    } finally {
      rmSync(oldProjectPath, { recursive: true, force: true })
      rmSync(newProjectPath, { recursive: true, force: true })
    }
  })

  it('does not reinstall hooks for a remapped worktree that no longer exists on disk', async () => {
    const oldProjectPath = mkdtempSync(join(tmpdir(), 'reloc-old-'))
    const newProjectPath = mkdtempSync(join(tmpdir(), 'reloc-new-'))
    writeFileSync(join(newProjectPath, '.git'), '')

    const oldWorktreePath = join(oldProjectPath, '.claude', 'worktrees', 'feat-y')
    mkdirSync(oldWorktreePath, { recursive: true })
    // Deliberately do not create the new worktree directory.

    writeSessionsJson([
      baseLocalSession({
        id: 'l1',
        projectPath: oldProjectPath,
        worktreePath: oldWorktreePath,
        tool: 'claude',
      }),
    ])

    const sm = await loadSessionManager()
    sm.restoreSessions()
    const { installHooks } = await import('./hook-installer')
    vi.mocked(installHooks).mockClear()

    try {
      await sm.relocateProject(oldProjectPath, newProjectPath)

      expect(installHooks).not.toHaveBeenCalledWith(
        join(newProjectPath, '.claude', 'worktrees', 'feat-y'),
        { skipGitignore: true }
      )
    } finally {
      rmSync(oldProjectPath, { recursive: true, force: true })
      rmSync(newProjectPath, { recursive: true, force: true })
    }
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

    const result = await sm.openSessionsForOpenPrs(
      '/proj',
      null,
      {},
      {
        listPrs,
        createPrSession,
      }
    )
    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') throw new Error(result)

    expect(result.skipped).toEqual([7])
    expect(result.created.map((s) => s.prNumber).sort()).toEqual([8, 9])
    expect(result.failed).toEqual([])
    expect(listPrs).toHaveBeenCalledWith('/proj', null, null)
    expect(createPrSession).toHaveBeenCalledTimes(2)
    expect(createPrSession).toHaveBeenCalledWith('/proj', 8, null, {})
    expect(createPrSession).toHaveBeenCalledWith('/proj', 9, null, {})
  })

  it('surfaces gh list errors as a string', async () => {
    const sm = await loadSessionManager()
    const result = await sm.openSessionsForOpenPrs(
      '/proj',
      null,
      {},
      {
        listPrs: async () => 'Failed to list open PRs: gh auth failed',
        createPrSession: vi.fn(),
      }
    )

    expect(result).toBe('Failed to list open PRs: gh auth failed')
  })

  it('threads an explicit repo into listing and per-PR creation', async () => {
    const sm = await loadSessionManager()
    const listPrs = vi.fn(async () => [{ number: 8, title: 'x', headRefName: 'b' }])
    const createPrSession = vi.fn(
      async (_projectPath: string, prNumber: number) =>
        baseLocalSession({ id: `s-${prNumber}`, prNumber }) as Session | string
    )
    const result = await sm.openSessionsForOpenPrs(
      '/proj',
      null,
      { repo: 'up/stream' },
      {
        listPrs,
        createPrSession,
      }
    )
    expect(typeof result).not.toBe('string')
    expect(listPrs).toHaveBeenCalledWith('/proj', null, 'up/stream')
    expect(createPrSession).toHaveBeenCalledWith('/proj', 8, null, { repo: 'up/stream' })
  })

  it('uses the selected tool for every newly created PR session', async () => {
    const sm = await loadSessionManager()
    const createPrSession = vi.fn(
      async (_projectPath: string, prNumber: number) =>
        baseLocalSession({ id: `s-${prNumber}`, prNumber }) as Session | string
    )

    await sm.openSessionsForOpenPrs(
      '/proj',
      null,
      { tool: 'codex' },
      {
        listPrs: async () => [
          { number: 8, title: 'x', headRefName: 'b' },
          { number: 9, title: 'y', headRefName: 'c' },
        ],
        createPrSession,
      }
    )

    expect(createPrSession.mock.calls).toEqual([
      ['/proj', 8, null, { tool: 'codex' }],
      ['/proj', 9, null, { tool: 'codex' }],
    ])
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

    const result = await sm.openSessionsForOpenIssues('/proj', null, undefined, null, {
      listIssues,
      createIssueSession,
    })
    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') throw new Error(result)

    expect(result.skipped).toEqual([3])
    expect(result.created.map((s) => s.issueNumber)).toEqual([4])
    expect(result.failed).toEqual([])
    expect(listIssues).toHaveBeenCalledWith('/proj', null, null)
    expect(createIssueSession).toHaveBeenCalledTimes(1)
    expect(createIssueSession).toHaveBeenCalledWith('/proj', 4, null, {})
  })

  it('records per-issue create failures in the summary', async () => {
    const sm = await loadSessionManager()
    const result = await sm.openSessionsForOpenIssues('/proj', null, undefined, null, {
      listIssues: async () => [{ number: 5 }],
      createIssueSession: async () => 'boom',
    })
    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') throw new Error(result)
    expect(result.created).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.failed).toEqual([{ number: 5, error: 'boom' }])
  })

  it('accepts a label and still produces a summary via injected deps', async () => {
    const sm = await loadSessionManager()
    const listIssues = vi.fn(async () => [{ number: 7 }])
    const createIssueSession = vi.fn(
      async (_projectPath: string, issueNumber: number, _hostId: string | null) =>
        baseLocalSession({ id: `s-${issueNumber}`, issueNumber }) as Session | string
    )

    const result = await sm.openSessionsForOpenIssues('/proj', null, 'bug', null, {
      listIssues,
      createIssueSession,
    })
    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') throw new Error(result)
    expect(result.created.map((s) => s.issueNumber)).toEqual([7])
  })

  it('threads an explicit repo into issue listing and creation', async () => {
    const sm = await loadSessionManager()
    const listIssues = vi.fn(async () => [{ number: 4 }])
    const createIssueSession = vi.fn(
      async (_projectPath: string, issueNumber: number) =>
        baseLocalSession({ id: `s-${issueNumber}`, issueNumber }) as Session | string
    )
    const result = await sm.openSessionsForOpenIssues('/proj', null, 'bug', 'up/stream', {
      listIssues,
      createIssueSession,
    })
    expect(typeof result).not.toBe('string')
    expect(listIssues).toHaveBeenCalledWith('/proj', null, 'up/stream')
    expect(createIssueSession).toHaveBeenCalledWith('/proj', 4, null, { repo: 'up/stream' })
  })
})

describe('createPrSession lookup failures', () => {
  it('surfaces the real gh error (e.g. rate limit) instead of reporting "not found"', async () => {
    const sm = await loadSessionManager()
    const prView = async () => {
      const err = new Error('Command failed') as Error & { stderr: string }
      err.stderr = 'GraphQL: API rate limit already exceeded for user ID 7911.'
      throw err
    }
    const result = await sm.createPrSession('/proj', 175, null, {}, { prView })
    expect(result).toBe(
      'Failed to look up PR #175: GraphQL: API rate limit already exceeded for user ID 7911.'
    )
  })

  it('still reports "not found" when gh says the PR cannot be resolved', async () => {
    const sm = await loadSessionManager()
    const prView = async () => {
      const err = new Error('Command failed') as Error & { stderr: string }
      err.stderr = 'GraphQL: Could not resolve to a PullRequest with the number of 175.'
      throw err
    }
    const result = await sm.createPrSession('/proj', 175, null, {}, { prView })
    expect(result).toBe('PR #175 not found in this repository.')
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
      // local branch namespaced under pewpew/ with a FORCED refspec —
      // origin/<branch> is never fetched, and the pewpew/ namespace keeps the
      // forced fetch from clobbering an unrelated user branch named pr-335.
      if (key === 'fetch origin +pull/335/head:pewpew/pr-335') return { stdout: '' }
      // The PR-scoped branch is verified to exist before `worktree add`.
      if (key === 'rev-parse --verify --quiet refs/heads/pewpew/pr-335') return { stdout: 'abc\n' }
      if (key === 'worktree add /proj/.claude/worktrees/pr-335 pewpew/pr-335') return { stdout: '' }
      throw new Error(`unexpected git ${key}`)
    })
    const createSessionForWorktree = vi.fn(async () =>
      baseLocalSession({
        id: 'pr-335',
        projectPath: '/proj',
        worktreeName: 'pr-335',
        worktreePath: '/proj/.claude/worktrees/pr-335',
        branch: 'pewpew/pr-335',
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
    // The pull ref was force-fetched into a pewpew-namespaced PR-scoped local
    // branch, and the worktree was added from it.
    expect(runGit).toHaveBeenCalledWith(['fetch', 'origin', '+pull/335/head:pewpew/pr-335'])
    expect(runGit).toHaveBeenCalledWith([
      'worktree',
      'add',
      '/proj/.claude/worktrees/pr-335',
      'pewpew/pr-335',
    ])
    // origin/<branch> is never fetched or used for a fork PR — the fork's head
    // branch name could collide with a base-repo branch of the same name.
    expect(runGit).not.toHaveBeenCalledWith(['fetch', 'origin', 'codex/fix-x'])
    expect(runGit).not.toHaveBeenCalledWith([
      'worktree',
      'add',
      '/proj/.claude/worktrees/pr-335',
      '-b',
      'pewpew/pr-335',
      'origin/codex/fix-x',
    ])
  })

  it('errors without running worktree add when the fork pull-ref fetch fails', async () => {
    const sm = await loadSessionManager()
    const runGit = vi.fn(async (argv: string[]) => {
      const key = argv.join(' ')
      // The pull ref can't be fetched (offline / transient), so the PR-scoped
      // branch is never created.
      if (key === 'fetch origin +pull/335/head:pewpew/pr-335') throw new Error('network down')
      if (key === 'rev-parse --verify --quiet refs/heads/pewpew/pr-335')
        throw new Error('no such ref')
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

    // No local pewpew/pr-335 exists, so we must fail explicitly rather than let
    // `git worktree add` DWIM to a remote-tracking origin/pewpew/pr-335.
    expect(typeof result).toBe('string')
    expect(runGit).not.toHaveBeenCalledWith([
      'worktree',
      'add',
      '/proj/.claude/worktrees/pr-335',
      'pewpew/pr-335',
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
              branch: 'pewpew/pr-335',
              tool: tool ?? 'claude',
            }),
        }
      )

      expect(typeof result).not.toBe('string')
      if (typeof result === 'string') throw new Error(result)
      expect(result.prIsFork).toBe(true)
      const worktreeTip = git(result.worktreePath, ['rev-parse', 'HEAD']).trim()
      expect(worktreeTip).toBe(prHead)
      // Fork PRs check out under a pewpew-namespaced PR-scoped local branch, not
      // the fork's head branch name (which isn't unique across forks) and not a
      // bare pr-<n> (which could clobber a user branch).
      const worktreeBranch = git(result.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
      expect(worktreeBranch).toBe('pewpew/pr-335')
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
              branch: 'pewpew/pr-501',
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
      // so a non-forced fetch into an existing pewpew/pr-<n> at oldHead rejects.
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

      // Simulate a previously-removed session: a leftover pewpew/pr-601 branch
      // at the OLD head, with no worktree checked out.
      execFileSync('git', ['-C', project, 'fetch', 'origin', 'pull/601/head:pewpew/pr-601'], {
        stdio: 'ignore',
      })
      expect(git(project, ['rev-parse', 'pewpew/pr-601']).trim()).toBe(oldHead)

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
              branch: 'pewpew/pr-601',
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
    'fails a fork PR rather than DWIM to origin/pewpew/pr-<n> when the pull ref is missing',
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
        // The base repo has a branch matching pewpew's namespaced fork branch
        // name (unrelated commits). There is NO refs/pull/808/head, so the fork
        // pull-ref fetch will fail and `git worktree add <path> pewpew/pr-808`
        // would otherwise DWIM onto origin/pewpew/pr-808.
        git(source, ['checkout', '-b', 'pewpew/pr-808'])
        writeFileSync(join(source, 'file.txt'), 'WRONG base branch\n')
        git(source, ['commit', '-am', 'base pewpew/pr-808'])
        const baseBranchTip = git(source, ['rev-parse', 'HEAD']).trim()
        git(source, ['checkout', 'main'])

        execFileSync('git', ['clone', '--bare', source, remote], { stdio: 'ignore' })
        execFileSync('git', ['clone', remote, project], { stdio: 'ignore' })
        mkdirSync(join(project, '.claude', 'worktrees'), { recursive: true })
        // origin/pewpew/pr-808 now exists as a remote-tracking branch.
        expect(git(project, ['rev-parse', 'origin/pewpew/pr-808']).trim()).toBe(baseBranchTip)

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
        // worktree onto origin/pewpew/pr-808 (the unrelated base branch).
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

describe('ghPrViewArgs', () => {
  it('omits --repo when no repo override is given', async () => {
    const sm = await loadSessionManager()
    const args = sm.ghPrViewArgs(7)
    expect(args.slice(0, 4)).toEqual(['pr', 'view', '7', '--json'])
    expect(args).not.toContain('--repo')
  })

  it('appends --repo <owner/name> for an explicit repo', async () => {
    const sm = await loadSessionManager()
    expect(sm.ghPrViewArgs(7, 'up/stream').slice(-2)).toEqual(['--repo', 'up/stream'])
  })
})

describe('createPrSession repo override (upstream)', () => {
  it('fetches the PR head from the chosen upstream repo, never from origin', async () => {
    const sm = await loadSessionManager()
    const runGit = vi.fn(async (argv: string[]) => {
      const key = argv.join(' ')
      // The upstream PR head is fetched from the parent repo's URL into a
      // pewpew-namespaced PR branch — origin (our fork) is never touched.
      if (key === 'fetch https://github.com/up/stream.git +pull/42/head:pewpew/pr-42')
        return { stdout: '' }
      if (key === 'rev-parse --verify --quiet refs/heads/pewpew/pr-42') return { stdout: 'abc\n' }
      if (key === 'worktree add /proj/.claude/worktrees/pr-42 pewpew/pr-42') return { stdout: '' }
      throw new Error(`unexpected git ${key}`)
    })
    // A plain internal upstream PR (not cross-repo) — the head still lives in a
    // repo that isn't our origin, so it must be treated as head-elsewhere.
    const prView = vi.fn(async () => ({
      headRefName: 'feature-x',
      state: 'OPEN',
      title: 'feat: x',
      isCrossRepository: false,
    }))
    const createSessionForWorktree = vi.fn(async () =>
      baseLocalSession({
        id: 'pr-42',
        projectPath: '/proj',
        worktreeName: 'pr-42',
        worktreePath: '/proj/.claude/worktrees/pr-42',
        branch: 'pewpew/pr-42',
      })
    )

    const result = await sm.createPrSession(
      '/proj',
      42,
      null,
      { repo: 'up/stream' },
      { runGit, prView, createSessionForWorktree }
    )

    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') throw new Error(result)
    expect(result.prNumber).toBe(42)
    // The head lives outside origin, so the session is flagged and points at the
    // source repo (pushes from the worktree won't update the PR).
    expect(result.prIsFork).toBe(true)
    expect(result.prHeadRepo).toBe('up/stream')
    expect(prView).toHaveBeenCalledWith('/proj', 42, 'up/stream')
    expect(runGit).toHaveBeenCalledWith([
      'fetch',
      'https://github.com/up/stream.git',
      '+pull/42/head:pewpew/pr-42',
    ])
    expect(runGit).not.toHaveBeenCalledWith(['fetch', 'origin', 'feature-x'])
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

  it('forwards a repo override to each created PR session', async () => {
    const sm = await loadSessionManager()
    const createPrSession = vi.fn(
      async (_projectPath: string, prNumber: number) =>
        baseLocalSession({ id: `s-${prNumber}`, prNumber }) as Session | string
    )
    await sm.createPrSessions('/proj', [8, 9], null, { repo: 'up/stream' }, { createPrSession })
    expect(createPrSession).toHaveBeenCalledWith('/proj', 8, null, { repo: 'up/stream' })
    expect(createPrSession).toHaveBeenCalledWith('/proj', 9, null, { repo: 'up/stream' })
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

describe('attemptAutoReconnect', () => {
  it('present → recovered, reattaches, marks live, toasts recovery', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.hasRemoteTmuxResult.set('r1', true)
    const sm = await loadSessionManager()
    sm.restoreSessions()

    const outcome = await sm.attemptAutoReconnect('r1')

    expect(outcome).toBe('recovered')
    expect(sm.getSessions()[0].connectionState).toBe('live')
    expect(state.reattachRemotePtyCalls).toEqual([{ sessionId: 'r1', hostId: 'h1' }])
    expect(state.toasts).toEqual([{ severity: 'info', title: 'Reconnected to Dev' }])
  })

  it('tmux gone → gave-up, prompts cleanup; "Keep" leaves it completed with no silent removal', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.hasRemoteTmuxResult.set('r1', false)
    state.dialogResponse = 1 // Keep worktree
    const sm = await loadSessionManager()
    sm.restoreSessions()

    const outcome = await sm.attemptAutoReconnect('r1')
    expect(outcome).toBe('gave-up')

    // A confirmed-gone remote session ended: it must get the same cleanup dialog
    // a local session gets on exit (promptCleanup runs fire-and-forget, so the
    // mocked dialog resolves on a later tick). Choosing "Keep" marks it completed
    // and must not touch the worktree.
    await vi.waitFor(() => expect(sm.getSessions()[0].status).toBe('completed'))
    // Normalize connectionState to 'live' so a kept remote session is uniformly
    // terminal — SessionCard/DetailPane must not offer a Reconnect that reverts it.
    expect(sm.getSessions()[0].connectionState).toBe('live')
    expect(
      state.execRemoteCalls.some((c) => c.argv.includes('worktree') && c.argv.includes('remove'))
    ).toBe(false)
    // Parity with local: the dialog is the notification — no "session ended" toast.
    expect(state.toasts).toEqual([])
  })

  it('tmux gone → cleanup dialog "Delete" removes the session and its remote worktree', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.hasRemoteTmuxResult.set('r1', false)
    state.dialogResponse = 0 // Delete worktree
    const sm = await loadSessionManager()
    sm.restoreSessions()

    const outcome = await sm.attemptAutoReconnect('r1')
    expect(outcome).toBe('gave-up')

    await vi.waitFor(() => expect(sm.getSessions()).toHaveLength(0))
    expect(state.execRemoteCalls).toContainEqual({
      hostId: 'h1',
      argv: [
        'git',
        '-C',
        '/remote/proj',
        'worktree',
        'remove',
        '/remote/proj/.claude/worktrees/feat',
        '--force',
      ],
    })
  })

  it('a late session.end after "Keep" does not re-prompt or delete the kept worktree', async () => {
    // Regression for the double-prompt race: the probe-driven cleanup prompt
    // clears cleanupInProgress as soon as the user answers, so a delayed remote
    // session.end must not re-open the dialog and let a Delete remove the
    // worktree the user just chose to keep.
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.hasRemoteTmuxResult.set('r1', false)
    state.dialogResponse = 1 // Keep worktree
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.attemptAutoReconnect('r1')
    await vi.waitFor(() => expect(sm.getSessions()[0].status).toBe('completed'))

    // The delayed hook arrives; even if the user would now click Delete, the
    // already-completed session must be ignored (no second dialog, no removal).
    state.dialogResponse = 0 // Delete — would remove the worktree if unguarded
    sm.handleHookEvent('session.end', { cwd: '/remote/proj/.claude/worktrees/feat' }, 'h1')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(sm.getSessions()).toHaveLength(1)
    expect(sm.getSessions()[0].status).toBe('completed')
    expect(
      state.execRemoteCalls.some((c) => c.argv.includes('worktree') && c.argv.includes('remove'))
    ).toBe(false)
  })

  it('falls back to a toast when the cleanup dialog fails', async () => {
    // If showMessageBox rejects (no window / IPC error), promptCleanup rejects and
    // the user would otherwise get neither a dialog nor a notification. The dead
    // branch's .catch must still surface the "session ended" toast.
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.hasRemoteTmuxResult.set('r1', false)
    state.dialogThrows = true
    const sm = await loadSessionManager()
    sm.restoreSessions()

    await sm.attemptAutoReconnect('r1')

    await vi.waitFor(() =>
      expect(state.toasts).toContainEqual({ severity: 'error', title: 'Dev: remote session ended' })
    )
  })

  it('does not clobber a Keep made during an in-flight probe', async () => {
    // Race: the auto-reconnect probe is in flight when a delayed session.end hook
    // drives promptCleanup and the user chooses Keep. The probe then returns
    // 'absent' — it must not overwrite the just-completed session back to 'dead'
    // (which would re-prompt cleanup and let a Delete remove the kept worktree).
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.hasRemoteTmuxResult.set('r1', false) // probe would report 'absent'
    state.dialogResponse = 1 // Keep
    let gateResolve!: () => void
    state.ensureHostConnectionGate = new Promise<void>((res) => {
      gateResolve = res
    })
    const sm = await loadSessionManager()
    sm.restoreSessions()

    // Auto-reconnect parks at the gated ensureHostConnection, before the probe.
    const attemptPromise = sm.attemptAutoReconnect('r1')
    await new Promise((resolve) => setTimeout(resolve, 0))

    // A delayed session.end arrives → promptCleanup → Keep → completed + live.
    sm.handleHookEvent('session.end', { cwd: '/remote/proj/.claude/worktrees/feat' }, 'h1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sm.getSessions()[0].status).toBe('completed')

    // Release the probe. If it clobbered the Keep back to 'dead', the follow-up
    // re-prompt would Delete now (response 0). It must not.
    state.dialogResponse = 0
    gateResolve()
    await attemptPromise
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(sm.getSessions()).toHaveLength(1)
    expect(sm.getSessions()[0].status).toBe('completed')
    // And no spurious "Reconnected" toast for a session that actually ended.
    expect(state.toasts).not.toContainEqual({ severity: 'info', title: 'Reconnected to Dev' })
  })

  it('auth-failed → gave-up (no retry)', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.ensureHostConnectionThrows = {
      message: 'Permission denied (publickey)',
      runtimeStateAfter: 'auth-failed',
    }
    const sm = await loadSessionManager()
    sm.restoreSessions()

    const outcome = await sm.attemptAutoReconnect('r1')

    expect(outcome).toBe('gave-up')
    expect(sm.getSessions()[0].connectionState).toBe('auth-failed')
    expect(state.toasts.map((t) => t.severity)).toEqual(['error'])
  })

  it('network unreachable → retry', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.ensureHostConnectionThrows = {
      message: 'Connection refused',
      runtimeStateAfter: 'unreachable',
    }
    const sm = await loadSessionManager()
    sm.restoreSessions()

    const outcome = await sm.attemptAutoReconnect('r1')

    expect(outcome).toBe('retry')
    expect(sm.getSessions()[0].connectionState).toBe('unreachable')
  })

  it('skips the attempt (silent recovered) when a manual reconnect already reattached', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'idle' })])
    state.hasRemoteTmuxResult.set('r1', true)
    const sm = await loadSessionManager()
    sm.restoreSessions()
    await sm.reconnectRemoteSession('r1') // manual reconnect → live
    state.reattachRemotePtyCalls = []
    state.hasPtyResult.add('r1')
    state.toasts = []

    const outcome = await sm.attemptAutoReconnect('r1')

    expect(outcome).toBe('recovered')
    expect(state.reattachRemotePtyCalls).toEqual([])
    expect(state.toasts).toEqual([])
  })

  it('gave-up when the session no longer exists', async () => {
    const sm = await loadSessionManager()
    expect(await sm.attemptAutoReconnect('nope')).toBe('gave-up')
  })
})

describe('auto-reconnect cancellation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('killSession cancels a scheduled auto-reconnect (no resurrection)', async () => {
    state.hasRemoteTmuxResult.set('r1', true)
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'running' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.initSessionManager()

    state.unexpectedExitListener?.('r1') // drop → schedules a reconnect
    await sm.killSession('r1')
    state.reattachRemotePtyCalls = []

    await vi.advanceTimersByTimeAsync(60000)

    // The pending backoff timer must have been canceled — no reattach fired.
    expect(state.reattachRemotePtyCalls).toEqual([])
    expect(sm.getSessions()[0].status).toBe('dead')
  })
})

describe('auto-reconnect skips normally-ended remote sessions', () => {
  it('listener does not schedule/toast for a completed remote session', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'completed' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.initSessionManager()

    state.unexpectedExitListener?.('r1')

    expect(state.toasts).toEqual([])
    expect(sm.getSessions()[0].connectionState).not.toBe('connecting')
    expect(sm.getSessions()[0].status).toBe('completed')
  })

  it('listener does not schedule/toast for an errored remote session', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'error' })])
    const sm = await loadSessionManager()
    sm.restoreSessions()
    sm.initSessionManager()

    state.unexpectedExitListener?.('r1')

    expect(state.toasts).toEqual([])
    expect(sm.getSessions()[0].connectionState).not.toBe('connecting')
  })

  it('attemptAutoReconnect gives up on a completed session without probing', async () => {
    writeSessionsJson([baseRemoteSession({ id: 'r1', status: 'completed' })])
    state.hasRemoteTmuxResult.set('r1', true) // even if tmux is "present", must not reattach
    const sm = await loadSessionManager()
    sm.restoreSessions()

    const outcome = await sm.attemptAutoReconnect('r1')

    expect(outcome).toBe('gave-up')
    expect(state.reattachRemotePtyCalls).toEqual([])
    expect(state.ensureHostConnectionCalls).toEqual([])
    expect(state.toasts).toEqual([])
  })

  it('a normal session-end cancels a scheduled auto-reconnect (stays completed, no dead-flip)', async () => {
    vi.useFakeTimers()
    try {
      const remote = baseRemoteSession({ id: 'r1', status: 'running' })
      writeSessionsJson([remote])
      const sm = await loadSessionManager()
      sm.restoreSessions()
      sm.initSessionManager()

      // PTY drop schedules a reconnect (status is active at this point)...
      state.unexpectedExitListener?.('r1')
      // ...then the agent's session.end hook arrives over the live tunnel →
      // promptCleanup → cancel + (dialog "Keep") completed.
      sm.handleHookEvent('session.end', { cwd: remote.worktreePath }, 'h1')
      await vi.advanceTimersByTimeAsync(0) // flush the promptCleanup dialog
      state.reattachRemotePtyCalls = []
      state.toasts = []

      await vi.advanceTimersByTimeAsync(60000)

      expect(state.reattachRemotePtyCalls).toEqual([])
      expect(sm.getSessions()[0].status).toBe('completed')
    } finally {
      vi.useRealTimers()
    }
  })
})
