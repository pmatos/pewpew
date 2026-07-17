import { describe, it, expect, vi } from 'vitest'
import { branchRefExists } from './branch-ref'

describe('branchRefExists', () => {
  it('reports the branch exists when the runner resolves', async () => {
    const run = vi.fn(async () => ({ stdout: 'abc123\n' }))
    expect(await branchRefExists(run, 'feature/login')).toBe(true)
  })

  it('reports the branch is absent when the runner rejects', async () => {
    const run = vi.fn(async () => {
      throw new Error('fatal: Needed a single revision')
    })
    expect(await branchRefExists(run, 'feature/login')).toBe(false)
  })

  it('verifies the fully-qualified local ref, not a bare name', async () => {
    const run = vi.fn(async () => ({ stdout: '' }))
    await branchRefExists(run, 'pewpew/pr-335')
    expect(run).toHaveBeenCalledWith(['rev-parse', '--verify', 'refs/heads/pewpew/pr-335'])
  })

  it('omits --quiet by default', async () => {
    const run = vi.fn(async () => ({ stdout: '' }))
    await branchRefExists(run, 'proj/feat')
    expect(run).toHaveBeenCalledWith(['rev-parse', '--verify', 'refs/heads/proj/feat'])
  })

  it('inserts --quiet before the ref when requested', async () => {
    const run = vi.fn(async () => ({ stdout: '' }))
    await branchRefExists(run, 'pewpew/pr-335', { quiet: true })
    expect(run).toHaveBeenCalledWith([
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/heads/pewpew/pr-335',
    ])
  })
})
