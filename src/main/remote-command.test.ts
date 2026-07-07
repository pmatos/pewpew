import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host } from '../shared/types'

type ExecResult = { stdout: string; stderr: string; code: number; timedOut: boolean }

const state = vi.hoisted(() => ({
  hosts: [] as Host[],
  execResult: { stdout: '', stderr: '', code: 0, timedOut: false } as ExecResult,
  lastArgv: null as string[] | null,
}))

vi.mock('./host-registry', () => ({
  getHost: (hostId: string) => state.hosts.find((h) => h.hostId === hostId),
}))

vi.mock('./host-connection', () => ({
  exec: async (_host: Host, argv: string[]): Promise<ExecResult> => {
    state.lastArgv = argv
    return state.execResult
  },
}))

const host: Host = { hostId: 'h1', alias: 'dev', label: 'Dev' } as Host

beforeEach(() => {
  state.hosts = [host]
  state.execResult = { stdout: '', stderr: '', code: 0, timedOut: false }
  state.lastArgv = null
})

describe('getRequiredHost', () => {
  it('returns the registered host', async () => {
    const { getRequiredHost } = await import('./remote-command')
    expect(getRequiredHost('h1')).toBe(host)
  })

  it('throws on an unknown host', async () => {
    const { getRequiredHost } = await import('./remote-command')
    expect(() => getRequiredHost('nope')).toThrow('Unknown host')
  })
})

describe('expectRemoteOk', () => {
  it('returns stdout on a zero exit', async () => {
    const { expectRemoteOk } = await import('./remote-command')
    state.execResult = { stdout: 'ok-output', stderr: '', code: 0, timedOut: false }
    expect(await expectRemoteOk(host, ['echo', 'hi'], 'nope')).toBe('ok-output')
    expect(state.lastArgv).toEqual(['echo', 'hi'])
  })

  it('throws with stderr detail on a non-zero exit', async () => {
    const { expectRemoteOk } = await import('./remote-command')
    state.execResult = { stdout: '', stderr: 'fatal: bad ref\n', code: 128, timedOut: false }
    await expect(expectRemoteOk(host, ['git', 'x'], 'git failed')).rejects.toThrow(
      'git failed: fatal: bad ref'
    )
  })

  it('falls back to an exit-code detail when there is no output', async () => {
    const { expectRemoteOk } = await import('./remote-command')
    state.execResult = { stdout: '', stderr: '', code: 3, timedOut: false }
    await expect(expectRemoteOk(host, ['git', 'x'], 'git failed')).rejects.toThrow(
      'git failed: exit 3'
    )
  })

  it('throws on a timeout even with a zero code', async () => {
    const { expectRemoteOk } = await import('./remote-command')
    state.execResult = { stdout: '', stderr: '', code: 0, timedOut: true }
    await expect(expectRemoteOk(host, ['git', 'x'], 'git failed')).rejects.toThrow('git failed')
  })
})
