import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  bootstrapHost,
  HostBootstrapError,
  NOTIFY_SCRIPT_VERSION,
  OMP_HOOK_SCRIPT_VERSION,
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
  // Per-agent path the resolve script "discovers". '' or absent means not found.
  resolved?: { claude?: string; codex?: string; omp?: string }
  // Override what the resolve script sees as cached input on each call.
  onResolve?: (
    cachedClaude: string,
    cachedCodex: string,
    cachedOmp: string
  ) => { claude: string; codex: string; omp: string }
}

function fakeConnection(calls: string[][], opts: FakeOpts = {}): HostBootstrapConnection {
  const resolved = {
    claude: opts.resolved?.claude ?? '/usr/bin/claude',
    codex: opts.resolved?.codex ?? '/usr/bin/codex',
    omp: opts.resolved?.omp ?? '',
  }
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
        const cachedOmp = argv[6] ?? ''
        const out = opts.onResolve ? opts.onResolve(cachedClaude, cachedCodex, cachedOmp) : resolved
        return ok(`${out.claude}\n${out.codex}\n${out.omp}\n`)
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
      ompHookScriptPath: '/home/dev/.config/pewpew/hooks/omp-notify-v1.ts',
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

  it('installs the omp hook bridge as a separate file with the notify script path baked in', async () => {
    const calls: string[][] = []
    const result = await bootstrapHost('host-bootstrap-omp-hook', fakeConnection(calls), '/tmp/ipc')

    expect(result.ompHookScriptPath).toBe('/home/dev/.config/pewpew/hooks/omp-notify-v1.ts')
    const ompInstallCall = calls.find((argv) => argv[2]?.includes('PEWPEW_OMP_HOOK_VERSION'))
    expect(ompInstallCall).toBeDefined()
    expect(ompInstallCall?.[4]).toBe('/home/dev/.config/pewpew/hooks')
    expect(ompInstallCall?.[5]).toBe(result.ompHookScriptPath)
    // The bridge source has the resolved notify.sh path baked in as a literal.
    expect(ompInstallCall?.[6]).toContain(JSON.stringify(result.notifyScriptPath))
    expect(ompInstallCall?.[7]).toBe(String(OMP_HOOK_SCRIPT_VERSION))
    // Regression: the import line is built via string concatenation (not a
    // literal `import ... from ...` substring in host-bootstrap.ts) so
    // electron-vite's ESM __dirname/__filename/require shim injector can't
    // mistake it for a real import and inject its CommonJS-shim boilerplate
    // inside this template literal instead of at the file's actual top —
    // which previously broke every real __dirname use in the built app
    // (`ReferenceError: __dirname is not defined`, caught by the CI smoke
    // test, not by tsc/eslint/vitest). Assert the generated text is still
    // byte-for-byte correct despite the indirection.
    expect(ompInstallCall?.[6]).toContain("import { execFileSync } from 'node:child_process'")

    // Reinstall guard also keys on the current notifyScriptPath (arg $5), not
    // just the bridge's own version marker — so bumping NOTIFY_SCRIPT_VERSION
    // alone still forces a reinstall of an already-installed bridge that would
    // otherwise keep pointing at a notify.sh path that no longer exists.
    expect(ompInstallCall?.[8]).toBe(result.notifyScriptPath)
    // Both grep checks on the version-guard line use fixed-string matching
    // (-qF), not basic-regex (-q) — the version marker is always a plain
    // integer today so this is defensive consistency, not a behavior change.
    expect(ompInstallCall?.[2]).toContain('grep -qF "PEWPEW_OMP_HOOK_VERSION=$4"')
    expect(ompInstallCall?.[2]).toContain('grep -qF "$5"')
  })

  // Regression: buildOmpHookScript hand-duplicates hooks/omp-notify.ts's
  // event-mapping logic (necessarily — the remote install has to inline the
  // script text into a single ssh round trip rather than read the local file
  // at runtime), and nothing previously asserted the two stay equivalent.
  // Extract the event names each one registers via pi.on(...) and compare:
  // the generated remote copy from the actual install-call argv, the local
  // copy by invoking hooks/omp-notify.ts's real default export against a fake
  // `pi` that just records what it's asked to subscribe to. Also compares the
  // NOTIFY_TIMEOUT_MS literal both sources hardcode — the event-name check
  // alone wouldn't catch that value drifting between the two copies. This
  // still doesn't cover full handler-body behavioral equivalence (e.g. the
  // `willContinue` skip on agent_end); see the cross-referencing comments at
  // both call sites for the rest of the manual-sync checklist.
  it('registers the same pi.on(...) events and NOTIFY_TIMEOUT_MS as the local bridge (hooks/omp-notify.ts)', async () => {
    const calls: string[][] = []
    await bootstrapHost('host-bootstrap-omp-event-parity', fakeConnection(calls), '/tmp/ipc')
    const ompInstallCall = calls.find((argv) => argv[2]?.includes('PEWPEW_OMP_HOOK_VERSION'))
    const generatedSource = ompInstallCall?.[6] ?? ''
    const generatedEvents = [...generatedSource.matchAll(/pi\.on\('([a-zA-Z_.]+)'/g)]
      .map((m) => m[1])
      .sort()
    const generatedTimeout = generatedSource.match(/NOTIFY_TIMEOUT_MS = (\d+)/)?.[1]

    const { default: localHook } = await import('../../hooks/omp-notify')
    const localEvents: string[] = []
    localHook({
      on: (event: string) => {
        localEvents.push(event)
      },
    })
    localEvents.sort()
    const localSource = readFileSync(join(__dirname, '../../hooks/omp-notify.ts'), 'utf-8')
    const localTimeout = localSource.match(/NOTIFY_TIMEOUT_MS = (\d+)/)?.[1]

    expect(generatedEvents.length).toBeGreaterThan(0)
    expect(generatedEvents).toEqual(localEvents)
    expect(generatedTimeout).toBeDefined()
    expect(generatedTimeout).toBe(localTimeout)
  })

  it('resolves omp in addition to claude and codex, at the correct ordinal position', async () => {
    const calls: string[][] = []
    const result = await bootstrapHost(
      'host-bootstrap-with-omp',
      fakeConnection(calls, {
        resolved: { claude: '/usr/bin/claude', codex: '/usr/bin/codex', omp: '/usr/bin/omp' },
      }),
      '/tmp/ipc'
    )

    expect(result.agentPaths).toEqual({
      claude: '/usr/bin/claude',
      codex: '/usr/bin/codex',
      omp: '/usr/bin/omp',
    })
    const resolveCall = calls.find((argv) => argv.some((a) => a.includes('resolve_one omp')))
    expect(resolveCall?.[2]).toContain('resolve_one omp "$3"')
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

    // Heavy install path should have run only once. Matched on the notify.sh
    // installer's own version-guard marker in its script body (argv[2]) rather
    // than a `notify-v1.sh` substring anywhere in argv — the omp hook install
    // call also carries that path (embedded inside its bridge source as the
    // NOTIFY_SCRIPT constant), which a substring match would double-count.
    const installCalls = calls.filter((argv) => argv[2]?.includes('PEWPEW_NOTIFY_VERSION'))
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
        return ok('/u/bin/claude\n/u/bin/codex\n/u/bin/omp\n')
      },
    }
    const result = await resolveRemoteAgents(conn)
    expect(result).toEqual({ claude: '/u/bin/claude', codex: '/u/bin/codex', omp: '/u/bin/omp' })
    // Cached args default to empty.
    expect(calls[0][4]).toBe('')
    expect(calls[0][5]).toBe('')
    expect(calls[0][6]).toBe('')
  })

  it('omits agents the script returned empty for', async () => {
    const conn: HostBootstrapConnection = {
      exec: async () => ok('\n/u/bin/codex\n\n'),
    }
    const result = await resolveRemoteAgents(conn)
    expect(result).toEqual({ codex: '/u/bin/codex' })
  })

  it('threads cached paths through to the script as positional args, in AGENT_TOOLS order', async () => {
    const calls: string[][] = []
    const conn: HostBootstrapConnection = {
      exec: async (argv) => {
        calls.push(argv)
        return ok('/cached/claude\n/cached/codex\n/cached/omp\n')
      },
    }
    const cached: AgentResolution = {
      claude: '/cached/claude',
      codex: '/cached/codex',
      omp: '/cached/omp',
    }
    const result = await resolveRemoteAgents(conn, cached)
    expect(calls[0][4]).toBe('/cached/claude')
    expect(calls[0][5]).toBe('/cached/codex')
    expect(calls[0][6]).toBe('/cached/omp')
    expect(result).toEqual(cached)
  })

  it('throws install-failed on timeout', async () => {
    const conn: HostBootstrapConnection = {
      exec: async () => ({ stdout: '', stderr: '', code: 0, timedOut: true }),
    }
    await expect(resolveRemoteAgents(conn)).rejects.toMatchObject({ kind: 'install-failed' })
  })
})
