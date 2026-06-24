import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { Host, SshLogEntry, ToastEvent } from '../shared/types'

interface FakeResult {
  stdout: string
  stderr: string
  error: (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null
  exitCode: number | null
}

interface FakeChild extends EventEmitter {
  stderr: EventEmitter
  exitCode: number | null
  kill: () => boolean
}

let nextResult: FakeResult = { stdout: '', stderr: '', error: null, exitCode: 0 }
let resultResolver: ((args: string[]) => FakeResult) | null = null
const execFileCalls: { file: string; args: string[] }[] = []
const recordedEntries: SshLogEntry[] = []
const emittedToasts: Omit<ToastEvent, 'id'>[] = []
let pendingSpawn: { child: FakeChild; args: string[] } | null = null

vi.mock('child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (
      error: (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null,
      stdout: string,
      stderr: string
    ) => void
  ) => {
    execFileCalls.push({ file, args })
    const result = resultResolver ? resultResolver(args) : nextResult
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null }
    child.exitCode = result.exitCode
    setImmediate(() => cb(result.error, result.stdout, result.stderr))
    return child
  },
  spawn: (_file: string, args: string[]) => {
    const child = new EventEmitter() as FakeChild
    child.stderr = new EventEmitter()
    child.exitCode = null
    child.kill = () => true
    pendingSpawn = { child, args }
    return child
  },
}))

vi.mock('./config', async () => {
  const [{ tmpdir: getTmpDir }, { join: pathJoin }] = await Promise.all([
    import('os'),
    import('path'),
  ])
  return {
    CONFIG_DIR: pathJoin(getTmpDir(), `pewpew-host-connection-test-${process.pid}`),
  }
})

vi.mock('./ssh-log-buffer', () => ({
  recordSshInvocation: (entry: SshLogEntry) => {
    recordedEntries.push(entry)
  },
  getSshLog: () => [],
  clearSshLog: () => {},
}))

vi.mock('./notifications', () => ({
  emitToast: (event: Omit<ToastEvent, 'id'>) => {
    emittedToasts.push(event)
  },
}))

vi.mock('./host-registry', () => ({
  getHost: (hostId: string) =>
    hostId === 'h1' ? { hostId: 'h1', alias: 'dev', label: 'Devbox' } : undefined,
}))

import {
  exec,
  validateRemoteRepo,
  ensureHostConnection,
  stopHostConnection,
  runtimeStateFor,
  testConnection,
} from './host-connection'

const HOST: Host = { hostId: 'h1', alias: 'dev', label: 'Devbox' }

beforeEach(() => {
  nextResult = { stdout: '', stderr: '', error: null, exitCode: 0 }
  resultResolver = null
  execFileCalls.length = 0
  recordedEntries.length = 0
  emittedToasts.length = 0
  pendingSpawn = null
})

describe('validateRemoteRepo', () => {
  it('returns ok with fingerprint on code=0 stdout', async () => {
    nextResult = { stdout: 'abc123\n', stderr: '', error: null, exitCode: 0 }
    const result = await validateRemoteRepo('dev', '/srv/repo')
    expect(result).toEqual({ ok: true, fingerprint: 'abc123' })
  })

  it('returns ok without fingerprint for an empty repo (no commits yet)', async () => {
    nextResult = { stdout: '', stderr: '', error: null, exitCode: 0 }
    const result = await validateRemoteRepo('dev', '/srv/empty-repo')
    expect(result).toEqual({ ok: true, fingerprint: undefined })
  })

  it('returns not-a-git-repo when remote exits non-zero with no ssh markers', async () => {
    nextResult = {
      stdout: '',
      stderr: '',
      error: { name: 'Error', message: 'x', code: 1 } as unknown as NodeJS.ErrnoException,
      exitCode: 1,
    }
    const result = await validateRemoteRepo('dev', '/not/a/repo')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not-a-git-repo')
    expect(result.message).toMatch(/git repository/)
  })

  it('rejects subdirectories with the probe stderr message', async () => {
    nextResult = {
      stdout: '',
      stderr: 'Remote path must be the repository root (got subdirectory: sub/)',
      error: { name: 'Error', message: 'x', code: 2 } as unknown as NodeJS.ErrnoException,
      exitCode: 2,
    }
    const result = await validateRemoteRepo('dev', '/srv/repo/sub')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not-a-git-repo')
    expect(result.message).toMatch(/repository root/)
    expect(result.message).toMatch(/sub\//)
  })

  it('returns auth-failed on Permission denied stderr', async () => {
    nextResult = {
      stdout: '',
      stderr: 'Permission denied (publickey).',
      error: { name: 'Error', message: 'x', code: 255 } as unknown as NodeJS.ErrnoException,
      exitCode: 255,
    }
    const result = await validateRemoteRepo('dev', '/srv/repo')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('auth-failed')
  })

  it('returns network on Connection refused stderr', async () => {
    nextResult = {
      stdout: '',
      stderr: 'ssh: connect to host dev port 22: Connection refused',
      error: { name: 'Error', message: 'x', code: 255 } as unknown as NodeJS.ErrnoException,
      exitCode: 255,
    }
    const result = await validateRemoteRepo('dev', '/srv/repo')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('network')
  })

  it('returns dep-missing when ssh binary is absent', async () => {
    nextResult = {
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('ENOENT'), {
        code: 'ENOENT',
      }) as NodeJS.ErrnoException,
      exitCode: null,
    }
    const result = await validateRemoteRepo('dev', '/srv/repo')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('dep-missing')
  })

  it('returns dep-missing when remote git is absent (shell emits 127)', async () => {
    nextResult = {
      stdout: '',
      stderr: 'sh: 1: git: not found',
      error: { name: 'Error', message: 'x', code: 127 } as unknown as NodeJS.ErrnoException,
      exitCode: 127,
    }
    const result = await validateRemoteRepo('dev', '/srv/repo')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('dep-missing')
  })

  it('returns network when ssh is killed by the timeout', async () => {
    nextResult = {
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('timeout'), {
        killed: true,
      }) as NodeJS.ErrnoException & { killed?: boolean },
      exitCode: null,
    }
    const result = await validateRemoteRepo('dev', '/srv/repo')
    expect(result).toEqual({ ok: false, reason: 'network', message: 'ssh timed out' })
  })

  it('passes the remote path as a positional argv element (not interpolated)', async () => {
    nextResult = { stdout: 'abc\n', stderr: '', error: null, exitCode: 0 }
    await validateRemoteRepo('dev', "/pa'th")
    const call = execFileCalls[0]
    expect(call.file).toBe('ssh')
    // Last argv entry passed to ssh is the shell-quoted remote path; previous
    // entries cover "sh", "-c", SCRIPT, "_" — each shell-quoted independently.
    expect(call.args[call.args.length - 1]).toBe("'/pa'\"'\"'th'")
    expect(call.args).toContain('--')
    expect(call.args).toContain('dev')
  })
})

describe('exec ring-buffer + toast wiring', () => {
  it('records every ssh exec keyed by hostId and kind=exec', async () => {
    nextResult = { stdout: 'ok', stderr: '', error: null, exitCode: 0 }
    await exec(HOST, ['true'])
    expect(recordedEntries).toHaveLength(1)
    expect(recordedEntries[0].hostId).toBe('h1')
    expect(recordedEntries[0].kind).toBe('exec')
    expect(recordedEntries[0].exitCode).toBe(0)
  })

  it('does NOT record when called with a bare alias (no hostId)', async () => {
    nextResult = { stdout: 'ok', stderr: '', error: null, exitCode: 0 }
    await exec('dev', ['true'])
    expect(recordedEntries).toHaveLength(0)
  })

  it('does NOT emit a toast on a successful exec (exit 0)', async () => {
    nextResult = { stdout: 'ok', stderr: '', error: null, exitCode: 0 }
    await exec(HOST, ['true'])
    expect(emittedToasts).toHaveLength(0)
  })

  it('emits an auth-failed toast carrying the host label on Permission denied', async () => {
    nextResult = {
      stdout: '',
      stderr: 'Permission denied (publickey).',
      error: { name: 'Error', message: 'x', code: 255 } as unknown as NodeJS.ErrnoException,
      exitCode: 255,
    }
    await exec(HOST, ['true'])
    expect(emittedToasts).toHaveLength(1)
    expect(emittedToasts[0].severity).toBe('error')
    expect(emittedToasts[0].title).toContain('Devbox')
    expect(emittedToasts[0].title).toMatch(/authentication failed/i)
    expect(emittedToasts[0].hostLabel).toBe('Devbox')
  })

  it('emits a bind-unlink toast naming the StreamLocalBindUnlink fix', async () => {
    nextResult = {
      stdout: '',
      stderr: 'StreamLocalBindUnlink requires StreamLocalBindUnlink yes on the server',
      error: { name: 'Error', message: 'x', code: 255 } as unknown as NodeJS.ErrnoException,
      exitCode: 255,
    }
    await exec(HOST, ['true'])
    expect(emittedToasts).toHaveLength(1)
    expect(emittedToasts[0].title).toMatch(/StreamLocalBindUnlink/)
  })

  it('does NOT emit a toast for an unrecognized exec failure (likely an app-level non-zero like tmux has-session "absent")', async () => {
    nextResult = {
      stdout: '',
      stderr: '',
      error: { name: 'Error', message: 'x', code: 1 } as unknown as NodeJS.ErrnoException,
      exitCode: 1,
    }
    await exec(HOST, ['tmux', 'has-session', '-t', 'pewpew-x'])
    expect(emittedToasts).toHaveLength(0)
    // The ring buffer still records the exec, so diagnostics retain it.
    expect(recordedEntries).toHaveLength(1)
    expect(recordedEntries[0].kind).toBe('exec')
    expect(recordedEntries[0].exitCode).toBe(1)
  })
})

describe('ensureHostConnection / startRuntime', () => {
  // ControlPersist=10m forks the foreground ssh into the background once the
  // master is up; the parent then exits with code 0. The master daemon owns
  // the control socket and serves subsequent ssh invocations. These tests pin
  // that the runtime treats code-0 parent exit as success rather than a
  // misleading "ssh control connection exited: 0" failure.

  beforeEach(async () => {
    await stopHostConnection(HOST.hostId).catch(() => undefined)
  })

  it('reaches live state when the parent ssh exits 0 after daemonization', async () => {
    // controlCheck always succeeds — the daemon is serving the socket.
    nextResult = { stdout: '', stderr: '', error: null, exitCode: 0 }
    const promise = ensureHostConnection(HOST, '/tmp/pewpew-test-local.sock')
    expect(pendingSpawn).not.toBeNull()
    // Simulate the foreground parent forking to the background and exiting 0.
    pendingSpawn!.child.exitCode = 0
    pendingSpawn!.child.emit('exit', 0)
    const result = await promise
    expect(result.controlPath).toContain(HOST.hostId)
    expect(runtimeStateFor(HOST.hostId)).toBe('live')
    await stopHostConnection(HOST.hostId)
  })

  it('still reaches live state when parent exits 0 between poll attempts', async () => {
    // Race scenario: controlCheck fails the first time (socket not yet
    // ready), parent ssh then daemonizes (exit 0) before the next poll, and
    // controlCheck succeeds afterwards. The runtime must NOT bail out just
    // because the foreground child has exited — the daemon owns the socket.
    let checkCalls = 0
    resultResolver = (args) => {
      const isControlCheck = args.includes('-O') && args.includes('check')
      if (isControlCheck) {
        checkCalls += 1
        if (checkCalls === 1) {
          return {
            stdout: '',
            stderr: 'Control socket connect: No such file or directory',
            error: { name: 'Error', message: 'x', code: 1 } as unknown as NodeJS.ErrnoException,
            exitCode: 1,
          }
        }
        return { stdout: '', stderr: '', error: null, exitCode: 0 }
      }
      return { stdout: '', stderr: '', error: null, exitCode: 0 }
    }

    const promise = ensureHostConnection(HOST, '/tmp/pewpew-test-local.sock')
    expect(pendingSpawn).not.toBeNull()
    // Wait for the first failed controlCheck to resolve, then simulate the
    // parent ssh forking to background and exiting cleanly. The next poll
    // attempt must still proceed and succeed.
    await new Promise((r) => setImmediate(r))
    pendingSpawn!.child.exitCode = 0
    pendingSpawn!.child.emit('exit', 0)
    const result = await promise
    expect(result.controlPath).toContain(HOST.hostId)
    expect(runtimeStateFor(HOST.hostId)).toBe('live')
    expect(checkCalls).toBeGreaterThanOrEqual(2)
    await stopHostConnection(HOST.hostId)
  })

  it('returns immediately on subsequent calls once the runtime is live', async () => {
    nextResult = { stdout: '', stderr: '', error: null, exitCode: 0 }
    const first = ensureHostConnection(HOST, '/tmp/pewpew-test-local.sock')
    pendingSpawn!.child.exitCode = 0
    pendingSpawn!.child.emit('exit', 0)
    await first
    expect(runtimeStateFor(HOST.hostId)).toBe('live')
    // Second call must not spawn another ssh master — it should reuse the
    // daemonized control socket. After daemonization the parent process
    // handle has already exited, so the live fast-path cannot rely on a
    // running parent process to detect liveness.
    pendingSpawn = null
    const second = await ensureHostConnection(HOST, '/tmp/pewpew-test-local.sock')
    expect(pendingSpawn).toBeNull()
    expect(second.controlPath).toContain(HOST.hostId)
    await stopHostConnection(HOST.hostId)
  })

  it('rejects with a real failure when the parent ssh exits non-zero', async () => {
    // controlCheck would succeed — but the parent exits with auth failure
    // before the live socket gets used. exitPromise must win the race.
    nextResult = { stdout: '', stderr: '', error: null, exitCode: 0 }
    const promise = ensureHostConnection(HOST, '/tmp/pewpew-test-local.sock')
    expect(pendingSpawn).not.toBeNull()
    pendingSpawn!.child.stderr.emit('data', Buffer.from('Permission denied (publickey).\n'))
    pendingSpawn!.child.exitCode = 255
    pendingSpawn!.child.emit('exit', 255)
    await expect(promise).rejects.toThrow(/Permission denied/)
    expect(runtimeStateFor(HOST.hostId)).toBe('auth-failed')
    await stopHostConnection(HOST.hostId)
  })
})

describe('testConnection', () => {
  const okResult = (stdout = ''): FakeResult => ({ stdout, stderr: '', error: null, exitCode: 0 })
  const failResult = (stderr: string, code: number): FakeResult => ({
    stdout: '',
    stderr,
    error: { name: 'Error', message: 'x', code } as unknown as NodeJS.ErrnoException,
    exitCode: code,
  })

  it('returns network when the connectivity probe times out', async () => {
    nextResult = {
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('timeout'), { killed: true }) as NodeJS.ErrnoException & {
        killed?: boolean
      },
      exitCode: null,
    }
    const result = await testConnection('dev')
    expect(result).toEqual({ ok: false, reason: 'network', message: 'ssh timed out' })
  })

  it('returns auth-failed without probing deps when auth is rejected', async () => {
    nextResult = failResult('Permission denied (publickey).', 255)
    const result = await testConnection('dev')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('auth-failed')
    // Only the connectivity probe ran — no dep/agent probes follow a failure.
    expect(execFileCalls).toHaveLength(1)
  })

  it('reports all required tools present and agents resolved on a healthy host', async () => {
    resultResolver = (args) => {
      const joined = args.join(' ')
      if (joined.includes('resolve_one claude'))
        return okResult('/usr/bin/claude\n/usr/bin/codex\n')
      if (joined.includes('command -v') && joined.includes('missing=')) return okResult('\n')
      return okResult() // connectivity `true`
    }
    const result = await testConnection('dev')
    expect(result.ok).toBe(true)
    expect(result.requiredDeps).toEqual([
      { name: 'tmux', installed: true },
      { name: 'git', installed: true },
      { name: 'jq', installed: true },
      { name: 'socat', installed: true },
    ])
    expect(result.agentTools).toEqual([
      { name: 'claude', installed: true },
      { name: 'codex', installed: true },
    ])
  })

  it('flags a missing required tool (socat) while staying connected', async () => {
    resultResolver = (args) => {
      const joined = args.join(' ')
      if (joined.includes('resolve_one claude')) return okResult('/usr/bin/claude\n\n')
      if (joined.includes('command -v') && joined.includes('missing=')) return okResult(' socat\n')
      return okResult()
    }
    const result = await testConnection('dev')
    expect(result.ok).toBe(true)
    expect(result.requiredDeps?.filter((d) => !d.installed).map((d) => d.name)).toEqual(['socat'])
    expect(result.agentTools).toEqual([
      { name: 'claude', installed: true },
      { name: 'codex', installed: false },
    ])
  })

  it('leaves dep fields undefined when probes error but the host is reachable', async () => {
    resultResolver = (args) => {
      const joined = args.join(' ')
      if (joined.includes('resolve_one claude')) return failResult('boom', 1)
      if (joined.includes('command -v') && joined.includes('missing=')) return failResult('boom', 1)
      return okResult()
    }
    const result = await testConnection('dev')
    expect(result).toEqual({ ok: true, requiredDeps: undefined, agentTools: undefined })
  })
})
