import { describe, expect, it } from 'vitest'
import type { Session } from '../shared/types'
import { applyHookEvent } from './session-state-machine'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    hostId: null,
    projectPath: '/p',
    projectName: 'p',
    worktreeName: 'w',
    worktreePath: '/p/w',
    branch: 'main',
    pid: 0,
    tmuxSession: 'pewpew-s1',
    status: 'idle',
    lastActivity: 0,
    hookEvents: [],
    tool: 'claude',
    ...overrides,
  }
}

function stateOf(...sessions: Session[]): Map<string, Session> {
  return new Map(sessions.map((s) => [s.id, s]))
}

describe('applyHookEvent — session.stop', () => {
  it('sets status to needs_input and emits a notifyNeedsInput intent for a matching local session', () => {
    const session = makeSession({ id: 's1', worktreePath: '/p/w', status: 'running' })
    const state = stateOf(session)
    const now = 1_700_000_000_000

    const result = applyHookEvent(
      state,
      { method: 'session.stop', params: { cwd: '/p/w' }, originHostId: null },
      now
    )

    expect(result.matched).toBe(true)
    expect(result.state.get('s1')?.status).toBe('needs_input')
    expect(result.state.get('s1')?.lastActivity).toBe(now)
    expect(result.intents).toContainEqual({ kind: 'notifyNeedsInput', sessionId: 's1' })
  })
})

describe('applyHookEvent — session.start', () => {
  it('captures session_id as agentSessionId for codex sessions', () => {
    const session = makeSession({ id: 'cx1', worktreePath: '/cx/wt', tool: 'codex' })
    const result = applyHookEvent(
      stateOf(session),
      {
        method: 'session.start',
        params: { cwd: '/cx/wt', session_id: 'codex-uuid-9' },
        originHostId: null,
      },
      1
    )
    expect(result.matched).toBe(true)
    expect(result.state.get('cx1')?.agentSessionId).toBe('codex-uuid-9')
    expect(result.state.get('cx1')?.status).toBe('running')
  })

  it('does not capture agentSessionId for claude sessions', () => {
    const session = makeSession({ id: 'cl1', worktreePath: '/cl/wt', tool: 'claude' })
    const result = applyHookEvent(
      stateOf(session),
      {
        method: 'session.start',
        params: { cwd: '/cl/wt', session_id: 'should-not-store' },
        originHostId: null,
      },
      1
    )
    expect(result.state.get('cl1')?.agentSessionId).toBeUndefined()
  })

  it('does not overwrite an existing agentSessionId', () => {
    const session = makeSession({
      id: 'cx2',
      worktreePath: '/cx/wt',
      tool: 'codex',
      agentSessionId: 'first',
    })
    const result = applyHookEvent(
      stateOf(session),
      {
        method: 'session.start',
        params: { cwd: '/cx/wt', session_id: 'second' },
        originHostId: null,
      },
      1
    )
    expect(result.state.get('cx2')?.agentSessionId).toBe('first')
  })

  it('captures camelCase sessionId alias as agentSessionId for codex sessions', () => {
    const session = makeSession({ id: 'cx3', worktreePath: '/cx/wt', tool: 'codex' })
    const result = applyHookEvent(
      stateOf(session),
      {
        method: 'session.start',
        params: { cwd: '/cx/wt', sessionId: 'codex-uuid-camel' },
        originHostId: null,
      },
      1
    )
    expect(result.state.get('cx3')?.agentSessionId).toBe('codex-uuid-camel')
  })
})

describe('applyHookEvent — session.activity', () => {
  it('flips status to running and emits no intents', () => {
    const session = makeSession({ id: 's1', status: 'idle' })
    const result = applyHookEvent(
      stateOf(session),
      { method: 'session.activity', params: { cwd: '/p/w' }, originHostId: null },
      42
    )
    expect(result.matched).toBe(true)
    expect(result.state.get('s1')?.status).toBe('running')
    expect(result.state.get('s1')?.lastActivity).toBe(42)
    expect(result.intents).toEqual([])
  })
})

describe('applyHookEvent — session.end', () => {
  it('emits promptCleanup intent and returns state unchanged when reason is prompt_input_exit', () => {
    const session = makeSession({ id: 's1', status: 'running', lastActivity: 0 })
    const original = stateOf(session)
    const result = applyHookEvent(
      original,
      {
        method: 'session.end',
        params: { cwd: '/p/w', reason: 'prompt_input_exit' },
        originHostId: null,
      },
      99
    )
    expect(result.matched).toBe(true)
    expect(result.intents).toContainEqual({ kind: 'promptCleanup', sessionId: 's1' })
    // State must be unchanged — promptCleanup runs async and removeSession will
    // reduce state separately. The reducer must not pre-emptively mutate.
    expect(result.state.get('s1')).toEqual(session)
  })

  it.each(['clear', 'resume'])(
    'does not emit promptCleanup when reason is %p (session still alive)',
    (reason) => {
      const session = makeSession({ id: 's1', status: 'running' })
      const result = applyHookEvent(
        stateOf(session),
        {
          method: 'session.end',
          params: { cwd: '/p/w', reason },
          originHostId: null,
        },
        1
      )
      expect(result.matched).toBe(true)
      expect(result.intents).toEqual([])
    }
  )

  it.each(['logout', 'bypass_permissions_disabled', 'other', 'unrecognised'])(
    'emits promptCleanup when reason is %p (agent process gone)',
    (reason) => {
      const session = makeSession({ id: 's1', status: 'running' })
      const result = applyHookEvent(
        stateOf(session),
        {
          method: 'session.end',
          params: { cwd: '/p/w', reason },
          originHostId: null,
        },
        1
      )
      expect(result.matched).toBe(true)
      expect(result.intents).toContainEqual({ kind: 'promptCleanup', sessionId: 's1' })
    }
  )

  it('emits promptCleanup when reason is absent (treat as a real end)', () => {
    const session = makeSession({ id: 's1', status: 'running' })
    const result = applyHookEvent(
      stateOf(session),
      { method: 'session.end', params: { cwd: '/p/w' }, originHostId: null },
      1
    )
    expect(result.matched).toBe(true)
    expect(result.intents).toContainEqual({ kind: 'promptCleanup', sessionId: 's1' })
  })
})

describe('applyHookEvent — session.notification', () => {
  it('appends a HookEvent and bumps lastActivity', () => {
    const session = makeSession({ id: 's1', hookEvents: [] })
    const params = { cwd: '/p/w', session_id: 'cc-uuid', message: 'hi' }
    const result = applyHookEvent(
      stateOf(session),
      { method: 'session.notification', params, originHostId: null },
      77
    )
    expect(result.matched).toBe(true)
    const updated = result.state.get('s1')!
    expect(updated.lastActivity).toBe(77)
    expect(updated.hookEvents).toHaveLength(1)
    expect(updated.hookEvents[0]).toMatchObject({
      method: 'session.notification',
      sessionId: 'cc-uuid',
      timestamp: 77,
      originHostId: null,
      data: params,
    })
  })

  it('falls back to internal id when session_id is absent', () => {
    const session = makeSession({ id: 's2', hookEvents: [] })
    const result = applyHookEvent(
      stateOf(session),
      { method: 'session.notification', params: { cwd: '/p/w' }, originHostId: null },
      1
    )
    expect(result.state.get('s2')!.hookEvents[0].sessionId).toBe('s2')
  })

  it('uses camelCase sessionId alias for the appended hook-event sessionId', () => {
    const session = makeSession({ id: 's3', hookEvents: [] })
    const result = applyHookEvent(
      stateOf(session),
      {
        method: 'session.notification',
        params: { cwd: '/p/w', sessionId: 'cc-uuid-camel' },
        originHostId: null,
      },
      1
    )
    expect(result.state.get('s3')!.hookEvents[0].sessionId).toBe('cc-uuid-camel')
  })
})

describe('applyHookEvent — origin host filtering', () => {
  it('does not match a local session when event originHostId is set', () => {
    const local = makeSession({ id: 'local', hostId: null, worktreePath: '/shared/wt' })
    const result = applyHookEvent(
      stateOf(local),
      { method: 'session.stop', params: { cwd: '/shared/wt' }, originHostId: 'h1' },
      1
    )
    expect(result.matched).toBe(false)
    expect(result.state.get('local')?.status).toBe('idle')
  })

  it('does not match a remote session when event originHostId is null', () => {
    const remote = makeSession({ id: 'remote', hostId: 'h1', worktreePath: '/shared/wt' })
    const result = applyHookEvent(
      stateOf(remote),
      { method: 'session.stop', params: { cwd: '/shared/wt' }, originHostId: null },
      1
    )
    expect(result.matched).toBe(false)
  })

  it('picks the remote session over a same-cwd local one when origin matches', () => {
    const local = makeSession({ id: 'local', hostId: null, worktreePath: '/shared/wt' })
    const remote = makeSession({ id: 'remote', hostId: 'h1', worktreePath: '/shared/wt' })
    const result = applyHookEvent(
      new Map([
        ['local', local],
        ['remote', remote],
      ]),
      { method: 'session.stop', params: { cwd: '/shared/wt' }, originHostId: 'h1' },
      1
    )
    expect(result.matched).toBe(true)
    expect(result.state.get('remote')?.status).toBe('needs_input')
    expect(result.state.get('local')?.status).toBe('idle')
  })
})

describe('applyHookEvent — match precedence', () => {
  it('matches when cwd is a subdirectory of worktreePath (startsWith, not equality)', () => {
    const session = makeSession({ id: 's1', worktreePath: '/p/w', status: 'running' })
    const result = applyHookEvent(
      stateOf(session),
      { method: 'session.stop', params: { cwd: '/p/w/sub/dir' }, originHostId: null },
      1
    )
    expect(result.matched).toBe(true)
    expect(result.state.get('s1')?.status).toBe('needs_input')
  })

  it('falls back to internal id when no session matches by cwd', () => {
    const session = makeSession({ id: 'abc12345', worktreePath: '/p/w', status: 'running' })
    const result = applyHookEvent(
      stateOf(session),
      {
        method: 'session.stop',
        params: { cwd: '/elsewhere', session_id: 'abc12345' },
        originHostId: null,
      },
      1
    )
    expect(result.matched).toBe(true)
    expect(result.state.get('abc12345')?.status).toBe('needs_input')
  })

  it('also accepts sessionId (camelCase) as a session_id alias', () => {
    const session = makeSession({ id: 'abc12345', worktreePath: '/p/w' })
    const result = applyHookEvent(
      stateOf(session),
      { method: 'session.stop', params: { sessionId: 'abc12345' }, originHostId: null },
      1
    )
    expect(result.matched).toBe(true)
  })
})

describe('applyHookEvent — remote connectionState', () => {
  it.each(['session.start', 'session.stop', 'session.activity'])(
    '%s on a remote session sets connectionState to live',
    (method) => {
      const session = makeSession({
        id: 'r1',
        hostId: 'h1',
        worktreePath: '/p/w',
        connectionState: 'pending',
      })
      const result = applyHookEvent(
        stateOf(session),
        { method, params: { cwd: '/p/w' }, originHostId: 'h1' },
        1
      )
      expect(result.state.get('r1')?.connectionState).toBe('live')
    }
  )

  it('preserves connectionState on local session.start (no originHostId)', () => {
    const session = makeSession({ id: 'l1', hostId: null, connectionState: undefined })
    const result = applyHookEvent(
      stateOf(session),
      { method: 'session.start', params: { cwd: '/p/w' }, originHostId: null },
      1
    )
    expect(result.state.get('l1')?.connectionState).toBeUndefined()
  })
})

describe('applyHookEvent — unknown method', () => {
  it('returns state unchanged with no intents and matched=false even when a session matches by cwd', () => {
    const session = makeSession({ id: 's1', worktreePath: '/p/w', status: 'running' })
    const original = stateOf(session)
    const result = applyHookEvent(
      original,
      { method: 'session.fnord', params: { cwd: '/p/w' }, originHostId: null },
      1
    )
    expect(result.matched).toBe(false)
    expect(result.intents).toEqual([])
    expect(result.state).toBe(original)
  })

  it('returns matched=false when no session matches at all', () => {
    const session = makeSession({ id: 's1', worktreePath: '/p/w' })
    const result = applyHookEvent(
      stateOf(session),
      { method: 'session.stop', params: { cwd: '/elsewhere' }, originHostId: null },
      1
    )
    expect(result.matched).toBe(false)
    expect(result.intents).toEqual([])
  })
})
