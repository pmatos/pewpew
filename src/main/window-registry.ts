import { BrowserWindow } from 'electron'

const windows = new Set<BrowserWindow>()
let mainWindow: BrowserWindow | null = null

export function registerWindow(win: BrowserWindow, isMain = false): void {
  windows.add(win)
  if (isMain) mainWindow = win
  win.on('closed', () => {
    windows.delete(win)
    if (win === mainWindow) mainWindow = null
  })
}

export function unregisterWindow(win: BrowserWindow): void {
  windows.delete(win)
  if (win === mainWindow) mainWindow = null
}

// Sends to a single window, tolerating a disposed render frame. win.isDestroyed()
// only reports whether the *window* object was destroyed; after a renderer
// process crash (or mid-reload/navigation) the window survives but its render
// frame is gone, and webContents.send() then throws "Render frame was disposed
// before WebFrameMain could be accessed". Guard on the webContents state and
// swallow the residual race so a crashed renderer can't spam the main log (the
// 16ms pty flush loop was the visible offender).
export function safeSend(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (win.isDestroyed()) return
  const wc = win.webContents
  if (wc.isDestroyed() || wc.isCrashed()) return
  try {
    wc.send(channel, ...args)
  } catch {
    // Frame can be disposed between the checks above and the send; ignore — the
    // renderer resyncs once it finishes (re)loading.
  }
}

export function broadcastToAll(channel: string, ...args: unknown[]): void {
  for (const win of windows) {
    safeSend(win, channel, ...args)
  }
}

export function getMainWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  return null
}
