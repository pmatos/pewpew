import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host } from '../shared/types'

type ExecResult = { stdout: string; stderr: string; code: number; timedOut: boolean }

// Hoisted, mutable per-test control surface reachable from vi.mock factories.
const state = vi.hoisted(() => ({
  hosts: [] as Host[],
  // Handler for remote `exec` (host-connection). argv is the raw command vector.
  execRemote: null as null | ((host: Host, argv: string[]) => ExecResult),
  // Captures every remote exec so tests can assert what was sent over SSH.
  execRemoteCalls: [] as string[][],
  // Handler for local `gh` invocations (child_process.execFile). Returns { stdout }
  // or throws to simulate a non-zero gh exit.
  execLocal: null as null | ((file: string, args: string[]) => { stdout: string }),
}))

vi.mock('./host-registry', () => ({
  getHost: (hostId: string) => state.hosts.find((h) => h.hostId === hostId),
}))

vi.mock('./host-connection', () => ({
  exec: async (host: Host, argv: string[]): Promise<ExecResult> => {
    state.execRemoteCalls.push(argv)
    return state.execRemote
      ? state.execRemote(host, argv)
      : { stdout: '', stderr: '', code: 0, timedOut: false }
  },
}))

vi.mock('child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, result?: { stdout: string }) => void
  ): void => {
    Promise.resolve().then(() => {
      try {
        cb(null, state.execLocal ? state.execLocal(file, args) : { stdout: '' })
      } catch (err) {
        cb(err)
      }
    })
  },
}))

const host: Host = {
  hostId: 'h1',
  alias: 'dev-alias',
  label: 'Dev',
} as Host

async function load(): Promise<typeof import('./github-items')> {
  return import('./github-items')
}

beforeEach(() => {
  state.hosts = [host]
  state.execRemote = null
  state.execRemoteCalls = []
  state.execLocal = null
})

afterEach(() => {
  vi.resetModules()
})

describe('ghApiOpenItemsArgs', () => {
  it('uses paginated REST calls for PR numbers', async () => {
    const { ghApiOpenItemsArgs } = await load()
    expect(ghApiOpenItemsArgs('pr', 'owner/repo')).toEqual([
      'api',
      '--paginate',
      'repos/owner/repo/pulls?state=open&per_page=100',
      '--jq',
      '.[].number',
    ])
  })

  it('uses paginated REST calls for issue numbers without including PRs', async () => {
    const { ghApiOpenItemsArgs } = await load()
    expect(ghApiOpenItemsArgs('issue', 'owner/repo')).toEqual([
      'api',
      '--paginate',
      'repos/owner/repo/issues?state=open&per_page=100',
      '--jq',
      '.[] | select(.pull_request | not) | .number',
    ])
  })

  it('appends an encoded labels filter for issues when a label is given', async () => {
    const { ghApiOpenItemsArgs } = await load()
    expect(ghApiOpenItemsArgs('issue', 'owner/repo', 'bug')[2]).toBe(
      'repos/owner/repo/issues?state=open&per_page=100&labels=bug'
    )
  })

  it('url-encodes labels containing spaces', async () => {
    const { ghApiOpenItemsArgs } = await load()
    expect(ghApiOpenItemsArgs('issue', 'owner/repo', 'good first issue')[2]).toBe(
      'repos/owner/repo/issues?state=open&per_page=100&labels=good%20first%20issue'
    )
  })

  it('ignores the label for PRs', async () => {
    const { ghApiOpenItemsArgs } = await load()
    expect(ghApiOpenItemsArgs('pr', 'owner/repo', 'bug')[2]).toBe(
      'repos/owner/repo/pulls?state=open&per_page=100'
    )
  })
})

describe('parseLabelLines', () => {
  it('splits, trims, and drops blank lines', async () => {
    const { parseLabelLines } = await load()
    expect(parseLabelLines('bug\nenhancement\n\n  good first issue ')).toEqual([
      'bug',
      'enhancement',
      'good first issue',
    ])
  })
})

describe('describeGhError', () => {
  it('prefers a trimmed stderr field when present', async () => {
    const { describeGhError } = await load()
    expect(describeGhError({ stderr: '  gh: rate limit exceeded\n' })).toBe(
      'gh: rate limit exceeded'
    )
  })

  it('strips a leading "Error:" from an Error message when no stderr', async () => {
    const { describeGhError } = await load()
    expect(describeGhError(new Error('Error: boom'))).toBe('boom')
  })

  it('stringifies anything else', async () => {
    const { describeGhError } = await load()
    expect(describeGhError('plain failure')).toBe('plain failure')
  })
})

describe('probeRemoteGh', () => {
  it('reports gh present when the probe exits zero', async () => {
    const { probeRemoteGh } = await load()
    state.execRemote = () => ({ stdout: '', stderr: '', code: 0, timedOut: false })
    expect(await probeRemoteGh(host)).toEqual({ ok: true })
  })

  it('classifies an SSH auth failure distinctly from a missing gh', async () => {
    const { probeRemoteGh } = await load()
    state.execRemote = () => ({
      stdout: '',
      stderr: 'Permission denied (publickey).\n',
      code: 255,
      timedOut: false,
    })
    const result = await probeRemoteGh(host)
    expect(result).toEqual({
      ok: false,
      error: 'SSH authentication failed on Dev: Permission denied (publickey).',
    })
  })

  it('reports a missing gh when the probe exits non-zero without an SSH error', async () => {
    const { probeRemoteGh } = await load()
    state.execRemote = () => ({ stdout: '', stderr: '', code: 1, timedOut: false })
    expect(await probeRemoteGh(host)).toEqual({
      ok: false,
      error: 'gh CLI is not installed on host Dev.',
    })
  })
})

describe('listOpenPrs / listOpenIssues (remote)', () => {
  it('returns the parsed open PR numbers listed over SSH', async () => {
    const { listOpenPrs } = await load()
    state.execRemote = (_h, argv) => {
      if (argv.join(' ').includes('command -v gh')) {
        return { stdout: '', stderr: '', code: 0, timedOut: false }
      }
      return { stdout: '8\n9\n', stderr: '', code: 0, timedOut: false }
    }
    expect(await listOpenPrs('/remote/proj', 'h1')).toEqual([{ number: 8 }, { number: 9 }])
  })

  it('forwards an encoded label filter to the remote gh call for issues', async () => {
    const { listOpenIssues } = await load()
    state.execRemote = (_h, argv) => {
      if (argv.join(' ').includes('command -v gh')) {
        return { stdout: '', stderr: '', code: 0, timedOut: false }
      }
      return { stdout: '3\n', stderr: '', code: 0, timedOut: false }
    }
    const result = await listOpenIssues('/remote/proj', 'h1', 'good first issue')
    expect(result).toEqual([{ number: 3 }])
    const listCall = state.execRemoteCalls.find((argv) => !argv.join(' ').includes('command -v gh'))
    expect(listCall?.some((arg) => arg.includes('labels=good%20first%20issue'))).toBe(true)
  })

  it('surfaces an SSH auth failure instead of listing', async () => {
    const { listOpenPrs } = await load()
    state.execRemote = () => ({
      stdout: '',
      stderr: 'Permission denied (publickey).\n',
      code: 255,
      timedOut: false,
    })
    expect(await listOpenPrs('/remote/proj', 'h1')).toBe(
      'SSH authentication failed on Dev: Permission denied (publickey).'
    )
  })

  it('rejects non-numeric gh output with a descriptive error', async () => {
    const { listOpenPrs } = await load()
    state.execRemote = (_h, argv) => {
      if (argv.join(' ').includes('command -v gh')) {
        return { stdout: '', stderr: '', code: 0, timedOut: false }
      }
      return { stdout: 'not-a-number\n', stderr: '', code: 0, timedOut: false }
    }
    const result = await listOpenPrs('/remote/proj', 'h1')
    expect(result).toBe('Failed to list open PRs: Expected PR number, got "not-a-number".')
  })
})

describe('listOpenPrs / listOpenIssues (local)', () => {
  it('resolves the repo then lists open PR numbers via gh', async () => {
    const { listOpenPrs } = await load()
    state.execLocal = (_file, args) => {
      if (args[0] === 'repo') return { stdout: 'owner/repo\n' }
      return { stdout: '1\n2\n3\n' }
    }
    expect(await listOpenPrs('/proj', null)).toEqual([{ number: 1 }, { number: 2 }, { number: 3 }])
  })

  it('surfaces a local gh failure as a string', async () => {
    const { listOpenIssues } = await load()
    state.execLocal = () => {
      throw Object.assign(new Error('Command failed'), { stderr: 'gh: not authenticated' })
    }
    expect(await listOpenIssues('/proj', null)).toBe(
      'Failed to list open issues: gh: not authenticated'
    )
  })
})

describe('countOpenIssues', () => {
  it('returns the number of matched open issues', async () => {
    const { countOpenIssues } = await load()
    const result = await countOpenIssues('/proj', null, 'bug', {
      listIssues: async () => [{ number: 1 }, { number: 2 }, { number: 3 }],
    })
    expect(result).toBe(3)
  })

  it('passes through a gh list error as a string', async () => {
    const { countOpenIssues } = await load()
    const result = await countOpenIssues('/proj', null, undefined, {
      listIssues: async () => 'Failed to list open issues: gh auth failed',
    })
    expect(result).toBe('Failed to list open issues: gh auth failed')
  })
})

describe('listRepoLabels', () => {
  it('lists repo labels locally', async () => {
    const { listRepoLabels } = await load()
    state.execLocal = (_file, args) => {
      if (args[0] === 'repo') return { stdout: 'owner/repo\n' }
      return { stdout: 'bug\nenhancement\n' }
    }
    expect(await listRepoLabels('/proj', null)).toEqual(['bug', 'enhancement'])
  })

  it('surfaces a remote gh probe failure instead of listing', async () => {
    const { listRepoLabels } = await load()
    state.execRemote = () => ({
      stdout: '',
      stderr: 'Permission denied (publickey).\n',
      code: 255,
      timedOut: false,
    })
    expect(await listRepoLabels('/remote/proj', 'h1')).toBe(
      'SSH authentication failed on Dev: Permission denied (publickey).'
    )
  })
})
