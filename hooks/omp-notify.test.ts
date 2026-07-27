import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileSyncMock = vi.fn()

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}))

import ompNotifyHook from './omp-notify'

type Handler = (event: Record<string, unknown>, ctx: { cwd: string }) => void

function install(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {}
  ompNotifyHook({
    on: (event: string, handler: Handler) => {
      handlers[event] = handler
    },
  })
  return handlers
}

function lastPayload(): unknown {
  const call = execFileSyncMock.mock.calls[0]
  const opts = call[2] as { input: string }
  return JSON.parse(opts.input)
}

beforeEach(() => {
  execFileSyncMock.mockReset()
})

describe('omp hook bridge', () => {
  it('registers handlers for the four lifecycle events pewpew tracks', () => {
    const handlers = install()
    expect(Object.keys(handlers).sort()).toEqual([
      'agent_end',
      'session_shutdown',
      'session_start',
      'tool_result',
    ])
  })

  it('session_start notifies SessionStart with cwd', () => {
    const handlers = install()
    handlers.session_start({}, { cwd: '/wt' })
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    expect(lastPayload()).toEqual({ hook_event_name: 'SessionStart', cwd: '/wt' })
  })

  it('agent_end notifies Stop when the turn actually settled', () => {
    const handlers = install()
    handlers.agent_end({ willContinue: false }, { cwd: '/wt' })
    expect(lastPayload()).toEqual({ hook_event_name: 'Stop', cwd: '/wt' })
  })

  it('agent_end skips notification when a continuation is already scheduled', () => {
    const handlers = install()
    handlers.agent_end({ willContinue: true }, { cwd: '/wt' })
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('tool_result notifies PostToolUse', () => {
    const handlers = install()
    handlers.tool_result({}, { cwd: '/wt' })
    expect(lastPayload()).toEqual({ hook_event_name: 'PostToolUse', cwd: '/wt' })
  })

  it('session_shutdown unconditionally notifies SessionEnd with reason "other"', () => {
    const handlers = install()
    handlers.session_shutdown({}, { cwd: '/wt' })
    expect(lastPayload()).toEqual({ hook_event_name: 'SessionEnd', cwd: '/wt', reason: 'other' })
  })

  it('swallows notify failures (pewpew not running / socket gone)', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    const handlers = install()
    expect(() => handlers.session_start({}, { cwd: '/wt' })).not.toThrow()
  })
})
