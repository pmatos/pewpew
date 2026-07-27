import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Host, RemoteProject } from '../shared/types'

let fakeHosts: Host[] = []
const saveConfigSpy = vi.fn()

vi.mock('./config', () => ({
  CONFIG_DIR: '/tmp/pewpew-test',
  getConfig: () => ({
    scanDirs: [],
    pinnedPaths: [],
    followSymlinks: true,
    canvas: { zoom: 1, panX: 0, panY: 0 },
    clusterPositions: {},
    sidebarWidth: 250,
    uiScale: 1,
    hosts: fakeHosts,
    remoteProjects: [] as RemoteProject[],
  }),
  saveConfig: (cfg: { hosts: Host[] }) => {
    fakeHosts = cfg.hosts
    saveConfigSpy(cfg)
  },
}))

vi.mock('./remote-project-registry', () => ({
  hasRemoteProjectsBoundTo: vi.fn(() => false),
}))

const fsState = { sessionsJson: null as string | null }

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: (p: string) =>
      p.endsWith('sessions.json') ? fsState.sessionsJson !== null : actual.existsSync(p),
    readFileSync: (p: string, enc?: BufferEncoding) =>
      p.endsWith('sessions.json') && fsState.sessionsJson !== null
        ? fsState.sessionsJson
        : actual.readFileSync(p, enc),
  }
})

import {
  validateAlias,
  validateLabel,
  addHost,
  updateHost,
  deleteHost,
  listHosts,
  getHost,
  setHostAgentPaths,
} from './host-registry'
import { hasRemoteProjectsBoundTo } from './remote-project-registry'

beforeEach(() => {
  fakeHosts = []
  fsState.sessionsJson = null
  saveConfigSpy.mockClear()
  vi.mocked(hasRemoteProjectsBoundTo).mockReturnValue(false)
})

describe('validateAlias', () => {
  it('rejects empty and whitespace-only', () => {
    expect(() => validateAlias('')).toThrow(/required/)
    expect(() => validateAlias('   ')).toThrow(/required/)
  })

  it('rejects leading dash (argv-injection guard)', () => {
    expect(() => validateAlias('-oProxyCommand=foo')).toThrow(/start with/)
  })

  it('trims leading/trailing whitespace', () => {
    expect(validateAlias('  dev  ')).toBe('dev')
  })

  it('rejects embedded whitespace', () => {
    expect(() => validateAlias('dev box')).toThrow(/whitespace/)
    expect(() => validateAlias('dev\tbox')).toThrow(/whitespace/)
    expect(() => validateAlias('dev\nbox')).toThrow(/whitespace/)
  })

  it('rejects NUL byte', () => {
    expect(() => validateAlias('dev\x00box')).toThrow(/NUL/)
  })

  it('rejects aliases longer than 64 chars', () => {
    expect(() => validateAlias('a'.repeat(65))).toThrow(/64/)
    expect(validateAlias('a'.repeat(64))).toBe('a'.repeat(64))
  })
})

describe('validateLabel', () => {
  it('rejects empty', () => {
    expect(() => validateLabel('')).toThrow(/required/)
    expect(() => validateLabel('   ')).toThrow(/required/)
  })

  it('trims and accepts', () => {
    expect(validateLabel('  ok  ')).toBe('ok')
  })

  it('rejects labels longer than 40 chars', () => {
    expect(() => validateLabel('a'.repeat(41))).toThrow(/40/)
    expect(validateLabel('a'.repeat(40))).toBe('a'.repeat(40))
  })
})

describe('addHost', () => {
  it('persists a new host with a UUID', () => {
    const host = addHost({ alias: 'dev', label: 'Dev box' })
    expect(host.alias).toBe('dev')
    expect(host.label).toBe('Dev box')
    expect(host.hostId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(listHosts()).toHaveLength(1)
    expect(saveConfigSpy).toHaveBeenCalledOnce()
  })

  it('rejects duplicate alias (exact match)', () => {
    addHost({ alias: 'dev', label: 'One' })
    expect(() => addHost({ alias: 'dev', label: 'Two' })).toThrow(/already exists/)
  })

  it('accepts case-differing alias (matches OpenSSH case sensitivity)', () => {
    addHost({ alias: 'dev', label: 'lower' })
    expect(() => addHost({ alias: 'Dev', label: 'Upper' })).not.toThrow()
    expect(listHosts()).toHaveLength(2)
  })
})

describe('updateHost', () => {
  it('renames label and alias', () => {
    const h = addHost({ alias: 'dev', label: 'Old' })
    const updated = updateHost(h.hostId, { alias: 'prod', label: 'New' })
    expect(updated.alias).toBe('prod')
    expect(updated.label).toBe('New')
    expect(getHost(h.hostId)?.alias).toBe('prod')
  })

  it('allows keeping the same alias (no-op rename)', () => {
    const h = addHost({ alias: 'dev', label: 'x' })
    expect(() => updateHost(h.hostId, { alias: 'dev', label: 'y' })).not.toThrow()
  })

  it('rejects renaming onto another host alias', () => {
    addHost({ alias: 'a', label: 'A' })
    const b = addHost({ alias: 'b', label: 'B' })
    expect(() => updateHost(b.hostId, { alias: 'a', label: 'B' })).toThrow(/already exists/)
  })

  it('throws on unknown hostId', () => {
    expect(() => updateHost('nope', { alias: 'x', label: 'y' })).toThrow(/Unknown/)
  })
})

describe('deleteHost', () => {
  // Cascade guards moved out of deleteHost in issue #14: deletion is now an
  // unconditional local-only forget. The IPC handler in index.ts orchestrates
  // PTY teardown, SSH connection close, hook-listener unlink, and remote
  // project removal around this final registry strip.
  it('deletes when sessions.json is missing', () => {
    const h = addHost({ alias: 'dev', label: 'x' })
    deleteHost(h.hostId)
    expect(listHosts()).toHaveLength(0)
  })

  it('deletes despite a session bound to the host', () => {
    const h = addHost({ alias: 'dev', label: 'x' })
    fsState.sessionsJson = JSON.stringify([{ session: { id: 's1', hostId: h.hostId } }])
    expect(() => deleteHost(h.hostId)).not.toThrow()
    expect(listHosts()).toHaveLength(0)
  })

  it('deletes despite a remote project bound to the host', () => {
    const h = addHost({ alias: 'dev', label: 'x' })
    vi.mocked(hasRemoteProjectsBoundTo).mockReturnValue(true)
    expect(() => deleteHost(h.hostId)).not.toThrow()
    expect(listHosts()).toHaveLength(0)
  })

  it('throws on unknown hostId', () => {
    expect(() => deleteHost('nope')).toThrow(/Unknown/)
  })
})

describe('updateHost retarget guards', () => {
  // The cascade guards still gate alias retargeting in updateHost (label-only
  // edits stay safe). These tests pin that contract so a future refactor of
  // deleteHost doesn't accidentally drop the retarget protection too.
  it('refuses alias retarget when a remote project is bound', () => {
    const h = addHost({ alias: 'dev', label: 'x' })
    vi.mocked(hasRemoteProjectsBoundTo).mockReturnValue(true)
    expect(() => updateHost(h.hostId, { alias: 'prod', label: 'x' })).toThrow(/remote projects/)
  })

  it('refuses alias retarget when a session is bound', () => {
    const h = addHost({ alias: 'dev', label: 'x' })
    fsState.sessionsJson = JSON.stringify([{ session: { id: 's1', hostId: h.hostId } }])
    expect(() => updateHost(h.hostId, { alias: 'prod', label: 'x' })).toThrow(/bound/)
  })

  it('allows label-only edit even with bindings', () => {
    const h = addHost({ alias: 'dev', label: 'old' })
    vi.mocked(hasRemoteProjectsBoundTo).mockReturnValue(true)
    fsState.sessionsJson = JSON.stringify([{ session: { id: 's1', hostId: h.hostId } }])
    expect(() => updateHost(h.hostId, { alias: 'dev', label: 'new' })).not.toThrow()
  })

  it('preserves agentPaths on label-only edit', () => {
    const h = addHost({ alias: 'dev', label: 'old' })
    setHostAgentPaths(h.hostId, { claude: '/u/.local/bin/claude' })
    updateHost(h.hostId, { alias: 'dev', label: 'new' })
    expect(getHost(h.hostId)?.agentPaths).toEqual({ claude: '/u/.local/bin/claude' })
  })

  it('drops agentPaths on alias retarget', () => {
    const h = addHost({ alias: 'dev', label: 'x' })
    setHostAgentPaths(h.hostId, { claude: '/u/.local/bin/claude' })
    updateHost(h.hostId, { alias: 'prod', label: 'x' })
    expect(getHost(h.hostId)?.agentPaths).toBeUndefined()
  })
})

describe('setHostAgentPaths', () => {
  it('persists newly resolved paths', () => {
    const h = addHost({ alias: 'dev', label: 'x' })
    setHostAgentPaths(h.hostId, { claude: '/u/bin/claude', codex: '/u/bin/codex' })
    expect(getHost(h.hostId)?.agentPaths).toEqual({
      claude: '/u/bin/claude',
      codex: '/u/bin/codex',
    })
  })

  it('persists an omp path alongside claude and codex', () => {
    const h = addHost({ alias: 'dev', label: 'x' })
    setHostAgentPaths(h.hostId, {
      claude: '/u/bin/claude',
      codex: '/u/bin/codex',
      omp: '/u/bin/omp',
    })
    expect(getHost(h.hostId)?.agentPaths).toEqual({
      claude: '/u/bin/claude',
      codex: '/u/bin/codex',
      omp: '/u/bin/omp',
    })
  })

  it('drops a previously cached tool when the resolver no longer finds it', () => {
    const h = addHost({ alias: 'dev', label: 'x' })
    setHostAgentPaths(h.hostId, { claude: '/u/bin/claude', codex: '/u/bin/codex' })
    setHostAgentPaths(h.hostId, { claude: '/u/bin/claude' })
    expect(getHost(h.hostId)?.agentPaths).toEqual({ claude: '/u/bin/claude' })
  })

  it('removes the agentPaths field entirely when nothing resolves', () => {
    const h = addHost({ alias: 'dev', label: 'x' })
    setHostAgentPaths(h.hostId, { claude: '/u/bin/claude' })
    setHostAgentPaths(h.hostId, {})
    expect(getHost(h.hostId)?.agentPaths).toBeUndefined()
  })

  it('is a no-op when the merged result equals what is on disk', () => {
    const h = addHost({ alias: 'dev', label: 'x' })
    setHostAgentPaths(h.hostId, { claude: '/u/bin/claude' })
    saveConfigSpy.mockClear()
    setHostAgentPaths(h.hostId, { claude: '/u/bin/claude' })
    expect(saveConfigSpy).not.toHaveBeenCalled()
  })

  it('silently ignores unknown hostId', () => {
    expect(() => setHostAgentPaths('nope', { claude: '/u/bin/claude' })).not.toThrow()
  })
})
