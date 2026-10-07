import type { IpcMain } from 'electron'

type SessionAction = (id: string) => Promise<void>

interface SessionActions {
  kill: SessionAction
  revive: SessionAction
  reconnect: SessionAction
  attach: SessionAction
  remove: SessionAction
}

export function registerSessionActionHandlers(
  ipc: Pick<IpcMain, 'handle'>,
  actions: SessionActions
): void {
  const routes = [
    { verb: 'kill', run: actions.kill, batch: true },
    { verb: 'revive', run: actions.revive, batch: true },
    { verb: 'reconnect', run: actions.reconnect, batch: false },
    { verb: 'attach', run: actions.attach, batch: false },
    { verb: 'remove', run: actions.remove, batch: true },
  ]

  for (const { verb, run, batch } of routes) {
    ipc.handle(`sessions:${verb}`, async (_event, id: string) => {
      try {
        await run(id)
      } catch (err) {
        console.error(`Failed to ${verb} session ${id}:`, err)
        throw err
      }
    })

    if (batch) {
      ipc.handle(`sessions:${verb}-batch`, async (_event, ids: string[]) => {
        await Promise.all(
          ids.map(async (id) => {
            try {
              await run(id)
            } catch (err) {
              console.error(`Failed to ${verb} session ${id}:`, err)
            }
          })
        )
      })
    }
  }
}
