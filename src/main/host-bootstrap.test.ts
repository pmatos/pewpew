import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  bootstrapHost,
  HostBootstrapError,
  NOTIFY_SCRIPT_VERSION,
  probeMissingDeps,
  resolveRemoteAgents,
  STRICT_DEPS,
  worktreeGuardScript,
  WORKTREE_GUARD_SCRIPT_VERSION,
  type AgentResolution,
  type HostBootstrapConnection,
} from './host-bootstrap'
import type { ExecResult } from './host-connection'

function ok(stdout = ''): ExecResult {
  return { stdout, stderr: '', code: 0, timedOut: false }
}

interface FakeOpts {
  // Per-agent path the resolve script "discovers". '' means not found.
  resolved?: { claude?: string; codex?: string }
  // Override what the resolve script sees as cached input on each call.
  onResolve?: (cachedClaude: string, cachedCodex: string) => { claude: string; codex: string }
}

function fakeConnection(calls: string[][], opts: FakeOpts = {}): HostBootstrapConnection {
  const resolved = opts.resolved ?? { claude: '/usr/bin/claude', codex: '/usr/bin/codex' }
  return {
    exec: async (argv) => {
      calls.push(argv)
      const script = argv[2]
      // Strict-deps probe: nothing missing.
      if (script.includes('command -v') && script.includes('missing="$missing $dep"')) {
        return ok('\n')
      }
      // Agent path resolution script.
      if (script.includes('resolve_one claude')) {
        const cachedClaude = argv[4] ?? ''
        const cachedCodex = argv[5] ?? ''
        const out = opts.onResolve
          ? opts.onResolve(cachedClaude, cachedCodex)
          : { claude: resolved.claude ?? '', codex: resolved.codex ?? '' }
        return ok(`${out.claude}\n${out.codex}\n`)
      }
      if (script === 'test -S "$1"') return ok()
      if (script.includes('XDG_CONFIG_HOME')) return ok('/home/dev/.config')
      if (script.includes('notify-v')) return ok()
      return ok()
    },
  }
}

describe('bootstrapHost', () => {
  it('probes deps, resolves agent paths, checks the socket, and installs notify-v1.sh', async () => {
    const calls: string[][] = []
    const result = await bootstrapHost(
      'host-bootstrap-all-present',
      fakeConnection(calls),
      '/tmp/ipc'
    )

    expect(result).toEqual({
      notifyScriptPath: '/home/dev/.config/pewpew/hooks/notify-v1.sh',
      guardScriptPath: '/home/dev/.config/pewpew/hooks/worktree-guard-v1.sh',
      remoteSocketPath: '/tmp/ipc',
      agentPaths: { claude: '/usr/bin/claude', codex: '/usr/bin/codex' },
    })
    expect(calls.some((argv) => argv.some((a) => a.includes('resolve_one claude')))).toBe(true)
    expect(calls.some((argv) => argv.includes('/tmp/ipc'))).toBe(true)
    expect(calls.some((argv) => argv.includes('/home/dev/.config/pewpew/hooks/notify-v1.sh'))).toBe(
      true
    )
  })

  it('hard-fails on missing strict deps but tolerates missing agent CLIs', async () => {
    const calls: string[][] = []
    const conn: HostBootstrapConnection = {
      exec: async (argv) => {
        calls.push(argv)
        const script = argv[2]
        if (script.includes('command -v') && script.includes('missing="$missing $dep"')) {
          return ok(' jq\n')
        }
        return ok()
      },
    }
    await expect(bootstrapHost('host-bootstrap-missing', conn, '/tmp/ipc')).rejects.toMatchObject({
      kind: 'missing-deps',
      missingDeps: ['jq'],
    } satisfies Partial<HostBootstrapError>)
  })

  it('omits codex from agentPaths when only codex is missing', async () => {
    const calls: string[][] = []
    const result = await bootstrapHost(
      'host-bootstrap-no-codex',
      fakeConnection(calls, { resolved: { claude: '/usr/bin/claude', codex: '' } }),
      '/tmp/ipc'
    )
    expect(result.agentPaths).toEqual({ claude: '/usr/bin/claude' })
  })

  it('omits claude from agentPaths when only claude is missing', async () => {
    const calls: string[][] = []
    const result = await bootstrapHost(
      'host-bootstrap-no-claude',
      fakeConnection(calls, { resolved: { claude: '', codex: '/usr/bin/codex' } }),
      '/tmp/ipc'
    )
    expect(result.agentPaths).toEqual({ codex: '/usr/bin/codex' })
  })

  it('installs through a version guard so already-installed notify scripts are kept', async () => {
    const calls: string[][] = []
    await bootstrapHost('host-bootstrap-version-guard', fakeConnection(calls), '/tmp/ipc')

    const installCall = calls.find((argv) =>
      argv.some((part) => part.includes(`notify-v${NOTIFY_SCRIPT_VERSION}.sh`))
    )
    expect(installCall).toBeDefined()
    expect(installCall?.[2]).toContain('grep -q "PEWPEW_NOTIFY_VERSION=$5"')
    expect(installCall).toContain(String(NOTIFY_SCRIPT_VERSION))
  })

  it('installs through a version guard so already-installed worktree guard scripts are kept', async () => {
    const calls: string[][] = []
    await bootstrapHost('host-bootstrap-guard-version-guard', fakeConnection(calls), '/tmp/ipc')

    const installCall = calls.find((argv) =>
      argv.some((part) => part.includes(`worktree-guard-v${WORKTREE_GUARD_SCRIPT_VERSION}.sh`))
    )
    expect(installCall).toBeDefined()
    expect(installCall?.[2]).toContain('grep -q "PEWPEW_WORKTREE_GUARD_VERSION=$9"')
    expect(installCall).toContain(String(WORKTREE_GUARD_SCRIPT_VERSION))
    expect(installCall).toContain(worktreeGuardScript)
  })

  it('passes cached agent paths into the resolve script on subsequent bootstraps', async () => {
    const calls: string[][] = []
    const conn = fakeConnection(calls, {
      resolved: { claude: '/u/.local/bin/claude', codex: '/u/.local/bin/codex' },
    })
    // First bootstrap: caller passes no cache; both paths resolved.
    const first = await bootstrapHost('host-cache-pass', conn, '/tmp/ipc')
    expect(first.agentPaths).toEqual({
      claude: '/u/.local/bin/claude',
      codex: '/u/.local/bin/codex',
    })

    // Second bootstrap: caller threads first.agentPaths back in. The resolve
    // script must receive them as positional args $1/$2.
    calls.length = 0
    await bootstrapHost('host-cache-pass', conn, '/tmp/ipc', first.agentPaths)
    const resolveCall = calls.find((argv) => argv.some((a) => a.includes('resolve_one claude')))
    expect(resolveCall?.[4]).toBe('/u/.local/bin/claude')
    expect(resolveCall?.[5]).toBe('/u/.local/bin/codex')
  })

  it('reflects out-of-band installs (codex appears after first bootstrap)', async () => {
    const calls: string[][] = []
    let codexPath = ''
    const conn: HostBootstrapConnection = {
      exec: async (argv) => {
        calls.push(argv)
        const script = argv[2]
        if (script.includes('command -v') && script.includes('missing="$missing $dep"')) {
          return ok('\n')
        }
        if (script.includes('resolve_one claude')) {
          return ok(`/u/.local/bin/claude\n${codexPath}\n`)
        }
        if (script === 'test -S "$1"') return ok()
        if (script.includes('XDG_CONFIG_HOME')) return ok('/home/dev/.config')
        return ok()
      },
    }

    const first = await bootstrapHost('host-reprobe', conn, '/tmp/ipc')
    expect(first.agentPaths).toEqual({ claude: '/u/.local/bin/claude' })

    codexPath = '/u/.npm/codex'
    const second = await bootstrapHost('host-reprobe', conn, '/tmp/ipc', first.agentPaths)
    expect(second.agentPaths).toEqual({
      claude: '/u/.local/bin/claude',
      codex: '/u/.npm/codex',
    })

    // Heavy install path should have run only once.
    const installCalls = calls.filter((argv) =>
      argv.some((part) => part.includes(`notify-v${NOTIFY_SCRIPT_VERSION}.sh`))
    )
    expect(installCalls).toHaveLength(1)
  })

  it('throws install-failed when the agent resolution times out on a cache hit', async () => {
    const calls: string[][] = []
    await bootstrapHost('host-probe-fail', fakeConnection(calls), '/tmp/ipc')

    const failingConn: HostBootstrapConnection = {
      exec: async (argv) => {
        const script = argv[2]
        if (script.includes('resolve_one claude')) {
          return { stdout: '', stderr: '', code: 0, timedOut: true }
        }
        return ok()
      },
    }
    await expect(bootstrapHost('host-probe-fail', failingConn, '/tmp/ipc')).rejects.toMatchObject({
      kind: 'install-failed',
    })
  })

  it('throws install-failed when the agent resolution exits non-zero on a cache hit', async () => {
    const calls: string[][] = []
    await bootstrapHost('host-probe-nonzero', fakeConnection(calls), '/tmp/ipc')

    const failingConn: HostBootstrapConnection = {
      exec: async (argv) => {
        const script = argv[2]
        if (script.includes('resolve_one claude')) {
          return { stdout: '', stderr: 'permission denied', code: 1, timedOut: false }
        }
        return ok()
      },
    }
    await expect(
      bootstrapHost('host-probe-nonzero', failingConn, '/tmp/ipc')
    ).rejects.toMatchObject({ kind: 'install-failed' })
  })
})

describe('worktreeGuardScript', () => {
  it('stays byte-identical to hooks/worktree-guard.sh from its root="$1" line onward', () => {
    const localScript = readFileSync(join(__dirname, '../../hooks/worktree-guard.sh'), 'utf-8')
    const marker = 'root="$1"'
    const localBody = localScript.slice(localScript.indexOf(marker))
    const remoteBody = worktreeGuardScript.slice(worktreeGuardScript.indexOf(marker))
    expect(remoteBody).toBe(localBody)
  })
})

describe('probeMissingDeps', () => {
  it('returns an empty array when every dep is present', async () => {
    const conn: HostBootstrapConnection = { exec: async () => ok('\n') }
    expect(await probeMissingDeps(conn)).toEqual([])
  })

  it('returns only the deps the probe reports missing, filtered to the requested set', async () => {
    const conn: HostBootstrapConnection = { exec: async () => ok(' socat jq\n') }
    expect(await probeMissingDeps(conn)).toEqual(['jq', 'socat'])
  })

  it('passes the requested deps to the probe as positional args', async () => {
    const calls: string[][] = []
    const conn: HostBootstrapConnection = {
      exec: async (argv) => {
        calls.push(argv)
        return ok('\n')
      },
    }
    await probeMissingDeps(conn)
    expect(calls[0].slice(-STRICT_DEPS.length)).toEqual([...STRICT_DEPS])
  })

  it('throws missing-deps when the probe itself fails to run', async () => {
    const conn: HostBootstrapConnection = {
      exec: async () => ({ stdout: '', stderr: 'boom', code: 1, timedOut: false }),
    }
    await expect(probeMissingDeps(conn)).rejects.toMatchObject({ kind: 'missing-deps' })
  })
})

describe('resolveRemoteAgents', () => {
  it('returns absolute paths for each tool the script resolves', async () => {
    const calls: string[][] = []
    const conn: HostBootstrapConnection = {
      exec: async (argv) => {
        calls.push(argv)
        return ok('/u/bin/claude\n/u/bin/codex\n')
      },
    }
    const result = await resolveRemoteAgents(conn)
    expect(result).toEqual({ claude: '/u/bin/claude', codex: '/u/bin/codex' })
    // Cached args default to empty.
    expect(calls[0][4]).toBe('')
    expect(calls[0][5]).toBe('')
  })

  it('omits agents the script returned empty for', async () => {
    const conn: HostBootstrapConnection = {
      exec: async () => ok('\n/u/bin/codex\n'),
    }
    const result = await resolveRemoteAgents(conn)
    expect(result).toEqual({ codex: '/u/bin/codex' })
  })

  it('threads cached paths through to the script as positional args', async () => {
    const calls: string[][] = []
    const conn: HostBootstrapConnection = {
      exec: async (argv) => {
        calls.push(argv)
        return ok('/cached/claude\n/cached/codex\n')
      },
    }
    const cached: AgentResolution = { claude: '/cached/claude', codex: '/cached/codex' }
    const result = await resolveRemoteAgents(conn, cached)
    expect(calls[0][4]).toBe('/cached/claude')
    expect(calls[0][5]).toBe('/cached/codex')
    expect(result).toEqual(cached)
  })

  it('throws install-failed on timeout', async () => {
    const conn: HostBootstrapConnection = {
      exec: async () => ({ stdout: '', stderr: '', code: 0, timedOut: true }),
    }
    await expect(resolveRemoteAgents(conn)).rejects.toMatchObject({ kind: 'install-failed' })
  })
})
