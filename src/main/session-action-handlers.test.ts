import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerSessionActionHandlers } from './session-action-handlers'

function setup() {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const ipc = {
    handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]) => {
      handlers.set(channel, handler)
    },
  }
  const actions = {
    kill: vi.fn(async (_id: string) => {}),
    revive: vi.fn(async (_id: string) => {}),
    reconnect: vi.fn(async (_id: string) => {}),
    attach: vi.fn(async (_id: string) => {}),
    remove: vi.fn(async (_id: string) => {}),
  }
  registerSessionActionHandlers(ipc, actions)
  const invoke = (channel: string, id: string | string[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
    return handler({} as IpcMainInvokeEvent, id)
  }
  return { handlers, actions, invoke }
}

describe('Session action IPC handlers', () => {
  it('registers the five single and three batch Session actions', () => {
    const { handlers } = setup()
    expect([...handlers.keys()]).toEqual([
      'sessions:kill',
      'sessions:kill-batch',
      'sessions:revive',
      'sessions:revive-batch',
      'sessions:reconnect',
      'sessions:attach',
      'sessions:remove',
      'sessions:remove-batch',
    ])
  })

  it('logs a single Session failure and rejects with the original error', async () => {
    const { actions, invoke } = setup()
    const error = new Error('cannot reconnect')
    actions.reconnect.mockRejectedValueOnce(error)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(invoke('sessions:reconnect', 'one')).rejects.toBe(error)
      expect(actions.reconnect).toHaveBeenCalledWith('one')
      expect(log).toHaveBeenCalledWith('Failed to reconnect session one:', error)
    } finally {
      log.mockRestore()
    }
  })

  it('starts every batch action and resolves after logging individual failures', async () => {
    const { actions, invoke } = setup()
    const error = new Error('cannot kill')
    let finishSecond!: () => void
    actions.kill.mockImplementation((id) => {
      if (id === 'one') return Promise.reject(error)
      return new Promise<void>((resolve) => {
        finishSecond = resolve
      })
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let settled = false
      const result = invoke('sessions:kill-batch', ['one', 'two']).then(() => {
        settled = true
      })
      expect(actions.kill.mock.calls.map(([id]) => id)).toEqual(['one', 'two'])
      await Promise.resolve()
      expect(settled).toBe(false)
      finishSecond()
      await result
      expect(log).toHaveBeenCalledWith('Failed to kill session one:', error)
    } finally {
      log.mockRestore()
    }
  })
})
