import { BrowserWindow, Notification } from 'electron'
import { randomUUID } from 'crypto'
import { getMainWindow, safeSend } from './window-registry'
import type { Session, ToastEvent } from '../shared/types'

export function notifyNeedsInput(session: Session): void {
  if (!Notification.isSupported()) return

  const notification = new Notification({
    title: 'Session needs input',
    body: `${session.projectName}/${session.worktreeName}`,
  })

  notification.on('click', () => {
    const win = getMainWindow()
    if (win) {
      win.show()
      win.focus()
      win.webContents.send('sessions:open-detail', session.id)
    }
  })

  notification.show()
}

export function emitToast(event: Omit<ToastEvent, 'id'> & { id?: string }): void {
  const payload: ToastEvent = {
    id: event.id ?? randomUUID(),
    ttlMs: event.ttlMs ?? 6000,
    severity: event.severity,
    title: event.title,
    detail: event.detail,
    hostLabel: event.hostLabel,
  }
  for (const win of BrowserWindow.getAllWindows()) {
    safeSend(win, 'toast:show', payload)
  }
}
