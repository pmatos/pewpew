import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  dialog: {
    showErrorBox: () => undefined,
  },
}))

import { buildAgentArgs } from './pty-manager'
import { OMP_HOOK_SCRIPT } from './hook-installer'

describe('buildAgentArgs', () => {
  it('defaults to claude with --dangerously-skip-permissions', () => {
    expect(buildAgentArgs()).toEqual(['claude', '--dangerously-skip-permissions'])
  })

  it('claude with continueSession appends --continue', () => {
    expect(buildAgentArgs({ tool: 'claude', continueSession: true })).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--continue',
    ])
  })

  it('codex without resume uses bypass flag only', () => {
    expect(buildAgentArgs({ tool: 'codex' })).toEqual([
      'codex',
      '--dangerously-bypass-approvals-and-sandbox',
    ])
  })

  it('codex with continueSession + agentSessionId emits resume <id>', () => {
    expect(
      buildAgentArgs({
        tool: 'codex',
        continueSession: true,
        agentSessionId: 'abc-123',
      })
    ).toEqual(['codex', 'resume', 'abc-123', '--dangerously-bypass-approvals-and-sandbox'])
  })

  it('codex with continueSession but no agentSessionId falls back to fresh spawn', () => {
    expect(buildAgentArgs({ tool: 'codex', continueSession: true })).toEqual([
      'codex',
      '--dangerously-bypass-approvals-and-sandbox',
    ])
  })

  it('uses agentPath as argv[0] when provided (claude)', () => {
    expect(buildAgentArgs({ agentPath: '/u/.local/bin/claude' })).toEqual([
      '/u/.local/bin/claude',
      '--dangerously-skip-permissions',
    ])
  })

  it('uses agentPath as argv[0] when provided (codex resume)', () => {
    expect(
      buildAgentArgs({
        tool: 'codex',
        continueSession: true,
        agentSessionId: 'abc-123',
        agentPath: '/u/.npm/codex',
      })
    ).toEqual(['/u/.npm/codex', 'resume', 'abc-123', '--dangerously-bypass-approvals-and-sandbox'])
  })

  it('omp without continueSession uses --auto-approve and the default local hook path', () => {
    expect(buildAgentArgs({ tool: 'omp' })).toEqual([
      'omp',
      '--auto-approve',
      '--hook',
      OMP_HOOK_SCRIPT,
    ])
  })

  it('omp with continueSession appends --continue (no session id needed)', () => {
    expect(buildAgentArgs({ tool: 'omp', continueSession: true })).toEqual([
      'omp',
      '--auto-approve',
      '--hook',
      OMP_HOOK_SCRIPT,
      '--continue',
    ])
  })

  it('uses agentPath as argv[0] when provided (omp)', () => {
    expect(buildAgentArgs({ tool: 'omp', agentPath: '/u/.bun/bin/omp' })).toEqual([
      '/u/.bun/bin/omp',
      '--auto-approve',
      '--hook',
      OMP_HOOK_SCRIPT,
    ])
  })

  it('omp uses notifyHookPath override when provided (remote sessions)', () => {
    expect(
      buildAgentArgs({
        tool: 'omp',
        notifyHookPath: '/home/dev/.config/pewpew/hooks/omp-notify.ts',
      })
    ).toEqual(['omp', '--auto-approve', '--hook', '/home/dev/.config/pewpew/hooks/omp-notify.ts'])
  })
})
