// Real-tmux regression test for the detach-on-destroy bug (see pty-manager.ts's
// setDetachOnDestroy doc comment). Some distros (Omarchy) ship a tmux.conf
// that sets `detach-on-destroy off` globally: with that in effect, killing a
// session migrates its attached client to another session instead of exiting
// it, so pewpew's dead-session detection (which is entirely onExit-based)
// never fires and a dead session's card keeps showing another session's
// output. This exercises the exact tmux invocation sequence pty-manager.ts
// issues (new-session, then `set-option -t <session> detach-on-destroy on`)
// against a real tmux server — a mocked child_process can't catch a wrong
// assumption about tmux's own behavior, only a real tmux binary can.
//
// Deliberately does not import pty-manager.ts's setDetachOnDestroy itself:
// that function is hardwired to TMUX_SOCKET ('pewpew'), which is the name of
// the user's real, live, persistent tmux server — running this suite against
// it would create and kill sessions there. Each test gets its own throwaway
// socket instead, but the exact argv setDetachOnDestroy sends is imported
// from production (detachOnDestroyArgs) so this test can't silently drift
// from what pewpew actually runs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { unlinkSync } from 'fs'
import { tmpdir } from 'os'
import * as pty from 'node-pty'
import { detachOnDestroyArgs, isTmuxAvailable } from './pty-manager'

describe.skipIf(!isTmuxAvailable())('detach-on-destroy against a real tmux server', () => {
  let socket: string

  function tmux(...args: string[]): string {
    return execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf-8' })
  }

  async function waitForClientOn(session: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        const clients = tmux('list-clients', '-F', '#{client_session}').trim()
        if (clients.split('\n').includes(session)) return
      } catch {
        // No clients yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`no client attached to ${session} within ${timeoutMs}ms`)
  }

  function attach(session: string): Promise<void> {
    const ptyProcess = pty.spawn('tmux', ['-L', socket, 'attach-session', '-t', session], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
    })
    return new Promise<void>((resolve) => {
      ptyProcess.onExit(() => resolve())
    })
  }

  async function exitedWithin(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
    const result = await Promise.race([
      exited.then(() => 'exited' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    ])
    return result === 'exited'
  }

  beforeEach(() => {
    socket = `pewpew-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // -f /dev/null keeps this hermetic against whatever tmux.conf this
    // machine happens to have. The hostile `detach-on-destroy off` global
    // default some distros ship is then applied explicitly below, so the
    // test reproduces the bug regardless of the machine it runs on.
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'A', '-x', '80', '-y', '24', 'sleep', '600')
    tmux('new-session', '-d', '-s', 'B', '-x', '80', '-y', '24', 'sleep', '600')
    tmux('set-option', '-g', 'detach-on-destroy', 'off')
  })

  afterEach(() => {
    try {
      execFileSync('tmux', ['-L', socket, 'kill-server'])
    } catch {
      // Already gone.
    }
    // tmux doesn't reliably unlink its socket file on kill-server; clean up
    // so throwaway sockets don't pile up in TMPDIR across runs.
    try {
      unlinkSync(`${tmpdir()}/tmux-${process.getuid?.() ?? 0}/${socket}`)
    } catch {
      // Already gone, or never created (e.g. new-session itself failed).
    }
  })

  it('client migrates instead of exiting when the hostile global default is left in place', async () => {
    const exited = attach('A')
    await waitForClientOn('A')

    tmux('kill-session', '-t', 'A')

    expect(await exitedWithin(exited, 1000)).toBe(false)
    const remaining = tmux('list-clients', '-F', '#{client_session}').trim()
    expect(remaining).toBe('B')
  })

  it('client exits when pewpew pins detach-on-destroy on for its own session', async () => {
    tmux(...detachOnDestroyArgs('A'))
    const exited = attach('A')
    await waitForClientOn('A')

    tmux('kill-session', '-t', 'A')

    expect(await exitedWithin(exited, 1000)).toBe(true)
  })
})
