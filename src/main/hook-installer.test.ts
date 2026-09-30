import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
  rmSync,
  statSync,
  symlinkSync,
  lstatSync,
  utimesSync,
} from 'fs'
import { execFileSync, execFile } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

const state = {
  tmpHome: '',
  tmpProject: '',
}

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => state.tmpHome }
})

vi.mock('./config', () => ({
  CONFIG_DIR: '/tmp/pewpew-test-config',
}))

beforeEach(() => {
  state.tmpHome = mkdtempSync(join(tmpdir(), 'codex-home-'))
  state.tmpProject = mkdtempSync(join(tmpdir(), 'codex-proj-'))
})

afterEach(() => {
  rmSync(state.tmpHome, { recursive: true, force: true })
  rmSync(state.tmpProject, { recursive: true, force: true })
})

async function loadInstaller(): Promise<typeof import('./hook-installer')> {
  vi.resetModules()
  return import('./hook-installer')
}

async function execLocally(argv: string[]) {
  try {
    const stdout = execFileSync(argv[0], argv.slice(1), { encoding: 'utf-8' })
    return { stdout, stderr: '', code: 0, timedOut: false }
  } catch (err) {
    const failure = err as {
      stdout?: Buffer | string
      stderr?: Buffer | string
      status?: number
    }
    return {
      stdout: failure.stdout?.toString() ?? '',
      stderr: failure.stderr?.toString() ?? '',
      code: failure.status ?? 1,
      timedOut: false,
    }
  }
}

const LEGACY_GUARD_COMMAND = "'/home/dev/.config/pewpew/hooks/worktree-guard.sh' '/home/dev/proj'"
const LEGACY_GUARD_GROUP = {
  matcher: 'Write|Edit|MultiEdit|NotebookEdit',
  hooks: [{ type: 'command', command: LEGACY_GUARD_COMMAND }],
}
const LOOKALIKE_GROUP = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: 'cd ~/dev/worktree-guard && ./check.sh' }],
}
const USER_PRE_TOOL_GROUP = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: '/usr/local/bin/other-guard.sh' }],
}

type HookGroup = { matcher?: string; hooks: Array<{ command: string }> }
type SettingsJson = { hooks: Record<string, HookGroup[]> }

function settingsPathOf(root: string): string {
  return join(root, '.claude', 'settings.local.json')
}

function writeSettings(root: string, settings: unknown, raw?: string): void {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(settingsPathOf(root), raw ?? JSON.stringify(settings))
}

function readSettings(root: string): SettingsJson {
  return JSON.parse(readFileSync(settingsPathOf(root), 'utf-8')) as SettingsJson
}

function ageFile(path: string): number {
  const old = new Date('2020-01-01T00:00:00Z')
  utimesSync(path, old, old)
  return statSync(path).mtimeMs
}

const legacySettings = () => ({
  permissions: { allow: ['Bash(ls)'] },
  hooks: {
    PreToolUse: [USER_PRE_TOOL_GROUP, LEGACY_GUARD_GROUP],
    Stop: [
      { hooks: [{ type: 'command', command: '/home/dev/.config/pewpew/hooks/notify.sh' }] },
      { hooks: [{ type: 'command', command: '/usr/local/bin/user-stop.sh' }] },
    ],
  },
})

describe('installHooks (Claude)', () => {
  it('installs notify hooks only — no PreToolUse guard on a fresh install', async () => {
    const { installHooks } = await loadInstaller()
    await installHooks(state.tmpProject, { skipGitignore: true })

    const raw = readFileSync(settingsPathOf(state.tmpProject), 'utf-8')
    const json = JSON.parse(raw) as SettingsJson
    expect(Object.keys(json.hooks).sort()).toEqual(
      ['Notification', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop'].sort()
    )
    expect(json.hooks.PostToolUse).toHaveLength(1)
    expect(raw).not.toContain('worktree-guard')
  })

  it('strips a pre-existing guard on upgrade and preserves every other hook', async () => {
    writeSettings(state.tmpProject, legacySettings())

    const { installHooks } = await loadInstaller()
    await installHooks(state.tmpProject, { skipGitignore: true })

    const raw = readFileSync(settingsPathOf(state.tmpProject), 'utf-8')
    const json = JSON.parse(raw) as SettingsJson & { permissions: unknown }
    expect(raw).not.toContain('worktree-guard')
    expect(json.permissions).toEqual({ allow: ['Bash(ls)'] })
    expect(json.hooks.PreToolUse).toEqual([USER_PRE_TOOL_GROUP])
    const stopCommands = json.hooks.Stop.map((g) => g.hooks[0].command)
    expect(stopCommands).toContain('/usr/local/bin/user-stop.sh')
    expect(stopCommands.filter((c) => c.endsWith('notify.sh'))).toHaveLength(1)
  })

  it('drops the PreToolUse key when the guard was its only entry', async () => {
    writeSettings(state.tmpProject, { hooks: { PreToolUse: [LEGACY_GUARD_GROUP] } })

    const { installHooks } = await loadInstaller()
    await installHooks(state.tmpProject, { skipGitignore: true })

    expect(readSettings(state.tmpProject).hooks).not.toHaveProperty('PreToolUse')
  })

  it('keeps a user handler that shares a matcher group with the guard', async () => {
    writeSettings(state.tmpProject, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [
              { type: 'command', command: LEGACY_GUARD_COMMAND },
              { type: 'command', command: '/usr/local/bin/lint-write.sh' },
            ],
          },
        ],
      },
    })

    const { installHooks } = await loadInstaller()
    await installHooks(state.tmpProject, { skipGitignore: true })

    expect(readSettings(state.tmpProject).hooks.PreToolUse).toEqual([
      {
        matcher: 'Write',
        hooks: [{ type: 'command', command: '/usr/local/bin/lint-write.sh' }],
      },
    ])
  })

  it('does not touch a user hook that merely mentions worktree-guard', async () => {
    writeSettings(state.tmpProject, {
      hooks: { PreToolUse: [LOOKALIKE_GROUP, LEGACY_GUARD_GROUP] },
    })

    const { installHooks } = await loadInstaller()
    await installHooks(state.tmpProject, { skipGitignore: true })

    expect(readSettings(state.tmpProject).hooks.PreToolUse).toEqual([LOOKALIKE_GROUP])
    expect(existsSync(`${settingsPathOf(state.tmpProject)}.tmp`)).toBe(false)
  })

  it('is idempotent: a second install leaves the file untouched', async () => {
    writeSettings(state.tmpProject, legacySettings())

    const { installHooks } = await loadInstaller()
    await installHooks(state.tmpProject, { skipGitignore: true })
    const afterFirst = readFileSync(settingsPathOf(state.tmpProject), 'utf-8')
    const mtime = ageFile(settingsPathOf(state.tmpProject))

    await installHooks(state.tmpProject, { skipGitignore: true })

    expect(readFileSync(settingsPathOf(state.tmpProject), 'utf-8')).toBe(afterFirst)
    expect(statSync(settingsPathOf(state.tmpProject)).mtimeMs).toBe(mtime)
  })
})

describe('removeLegacyGuardFromSettings / migrateLegacyGuardHooks', () => {
  it('removes only guard entries and reports the rewrite once', async () => {
    writeSettings(state.tmpProject, legacySettings())

    const { removeLegacyGuardFromSettings } = await loadInstaller()
    expect(removeLegacyGuardFromSettings(state.tmpProject)).toBe(true)

    const json = readSettings(state.tmpProject)
    expect(json.hooks.PreToolUse).toEqual([USER_PRE_TOOL_GROUP])
    expect(json.hooks.Stop).toHaveLength(2)

    const mtime = ageFile(settingsPathOf(state.tmpProject))
    expect(removeLegacyGuardFromSettings(state.tmpProject)).toBe(false)
    expect(statSync(settingsPathOf(state.tmpProject)).mtimeMs).toBe(mtime)
  })

  it('does not rewrite a file that has no guard entry, even if oddly formatted', async () => {
    const raw = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/x/notify.sh"}]}]}}'
    writeSettings(state.tmpProject, undefined, raw)
    const mtime = ageFile(settingsPathOf(state.tmpProject))

    const { removeLegacyGuardFromSettings } = await loadInstaller()
    expect(removeLegacyGuardFromSettings(state.tmpProject)).toBe(false)

    expect(readFileSync(settingsPathOf(state.tmpProject), 'utf-8')).toBe(raw)
    expect(statSync(settingsPathOf(state.tmpProject)).mtimeMs).toBe(mtime)
  })

  it('ignores absent, malformed, and non-object settings files', async () => {
    const { removeLegacyGuardFromSettings } = await loadInstaller()
    expect(removeLegacyGuardFromSettings(state.tmpProject)).toBe(false)

    writeSettings(state.tmpProject, undefined, '{ worktree-guard not json')
    expect(removeLegacyGuardFromSettings(state.tmpProject)).toBe(false)

    writeSettings(state.tmpProject, undefined, '["worktree-guard"]')
    expect(removeLegacyGuardFromSettings(state.tmpProject)).toBe(false)
  })

  it('migrates existing worktrees in bulk and returns only the ones it changed', async () => {
    const clean = mkdtempSync(join(tmpdir(), 'codex-clean-'))
    const missing = join(state.tmpProject, 'does-not-exist')
    try {
      writeSettings(state.tmpProject, legacySettings())
      writeSettings(clean, { hooks: { Stop: [] } })

      const { migrateLegacyGuardHooks } = await loadInstaller()
      const migrated = migrateLegacyGuardHooks([state.tmpProject, clean, missing, state.tmpProject])

      expect(migrated).toEqual([state.tmpProject])
      expect(readFileSync(settingsPathOf(state.tmpProject), 'utf-8')).not.toContain(
        'worktree-guard'
      )
    } finally {
      rmSync(clean, { recursive: true, force: true })
    }
  })
})

describe('installRemoteHooks', () => {
  const NOTIFY = '/home/dev/.config/pewpew/hooks/notify-v1.sh'

  it('sends notify hooks only — no PreToolUse guard entry', async () => {
    let hooksJsonArg = ''
    const execRemote = vi.fn(async (argv: string[]) => {
      hooksJsonArg = argv[argv.length - 1]
      return { stdout: '', stderr: '', code: 0, timedOut: false }
    })

    const { installRemoteHooks } = await loadInstaller()
    await installRemoteHooks(execRemote, '/home/dev/project/.claude/worktrees/wt1', NOTIFY)

    const hooks = JSON.parse(hooksJsonArg) as Record<string, unknown>
    expect(hooks).not.toHaveProperty('PreToolUse')
    expect(hooksJsonArg).not.toContain('worktree-guard')
  })

  it('throws when the remote merge command fails', async () => {
    const execRemote = vi.fn(async () => ({
      stdout: '',
      stderr: 'jq: command not found',
      code: 127,
      timedOut: false,
    }))

    const { installRemoteHooks } = await loadInstaller()
    await expect(installRemoteHooks(execRemote, '/wt', '/notify.sh')).rejects.toThrow(
      'jq: command not found'
    )
  })

  describe('with the merge script executed by a local sh + jq', () => {
    const execScript = async (argv: string[]) => {
      try {
        const stdout = execFileSync(argv[0], argv.slice(1), { encoding: 'utf-8' })
        return { stdout, stderr: '', code: 0, timedOut: false }
      } catch (err) {
        const failure = err as { stderr?: Buffer | string; status?: number }
        return {
          stdout: '',
          stderr: failure.stderr?.toString() ?? '',
          code: failure.status ?? 1,
          timedOut: false,
        }
      }
    }

    it('installs notify hooks into a fresh worktree', async () => {
      const { installRemoteHooks } = await loadInstaller()
      await installRemoteHooks(execScript, state.tmpProject, NOTIFY)

      const raw = readFileSync(settingsPathOf(state.tmpProject), 'utf-8')
      const json = JSON.parse(raw) as SettingsJson
      expect(Object.keys(json.hooks).sort()).toEqual(
        ['Notification', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop'].sort()
      )
      expect(raw).not.toContain('worktree-guard')
    })

    it('strips a pre-existing guard, preserves other hooks, and is idempotent', async () => {
      writeSettings(state.tmpProject, legacySettings())

      const { installRemoteHooks } = await loadInstaller()
      await installRemoteHooks(execScript, state.tmpProject, NOTIFY)

      const raw = readFileSync(settingsPathOf(state.tmpProject), 'utf-8')
      const json = JSON.parse(raw) as SettingsJson & { permissions: unknown }
      expect(raw).not.toContain('worktree-guard')
      expect(json.permissions).toEqual({ allow: ['Bash(ls)'] })
      expect(json.hooks.PreToolUse).toEqual([USER_PRE_TOOL_GROUP])
      const stopCommands = json.hooks.Stop.map((g) => g.hooks[0].command)
      expect(stopCommands).toContain('/usr/local/bin/user-stop.sh')
      expect(stopCommands.filter((c) => c === NOTIFY)).toHaveLength(1)
      expect(stopCommands.filter((c) => c.endsWith('notify.sh'))).toHaveLength(0)

      const mtime = ageFile(settingsPathOf(state.tmpProject))
      await installRemoteHooks(execScript, state.tmpProject, NOTIFY)
      expect(readFileSync(settingsPathOf(state.tmpProject), 'utf-8')).toBe(raw)
      expect(statSync(settingsPathOf(state.tmpProject)).mtimeMs).toBe(mtime)
      expect(existsSync(`${settingsPathOf(state.tmpProject)}.tmp`)).toBe(false)
    })

    it('does not touch a user hook that merely mentions worktree-guard', async () => {
      writeSettings(state.tmpProject, {
        hooks: { PreToolUse: [LOOKALIKE_GROUP, LEGACY_GUARD_GROUP] },
      })

      const { installRemoteHooks } = await loadInstaller()
      await installRemoteHooks(execScript, state.tmpProject, NOTIFY)

      expect(readSettings(state.tmpProject).hooks.PreToolUse).toEqual([LOOKALIKE_GROUP])
    })

    it('drops the PreToolUse key when the guard was its only entry', async () => {
      writeSettings(state.tmpProject, { hooks: { PreToolUse: [LEGACY_GUARD_GROUP] } })

      const { installRemoteHooks } = await loadInstaller()
      await installRemoteHooks(execScript, state.tmpProject, NOTIFY)

      expect(readSettings(state.tmpProject).hooks).not.toHaveProperty('PreToolUse')
    })

    it('keeps a user handler that shares a matcher group with the guard', async () => {
      writeSettings(state.tmpProject, {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Write',
              hooks: [
                { type: 'command', command: LEGACY_GUARD_COMMAND },
                { type: 'command', command: '/usr/local/bin/lint-write.sh' },
              ],
            },
          ],
        },
      })

      const { installRemoteHooks } = await loadInstaller()
      await installRemoteHooks(execScript, state.tmpProject, NOTIFY)

      expect(readSettings(state.tmpProject).hooks.PreToolUse).toEqual([
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: '/usr/local/bin/lint-write.sh' }],
        },
      ])
    })
  })
})

describe('installCodexHooks', () => {
  it('migrates an empty worktree .codex marker before installing hooks', async () => {
    const codexPath = join(state.tmpProject, '.codex')
    writeFileSync(codexPath, '')

    const { installCodexHooks } = await loadInstaller()
    await installCodexHooks(state.tmpProject, { skipGitignore: true })

    expect(statSync(codexPath).isDirectory()).toBe(true)
    expect(existsSync(join(codexPath, 'hooks.json'))).toBe(true)
  })

  it('writes .codex/hooks.json with codex event shape', async () => {
    const { installCodexHooks } = await loadInstaller()
    await installCodexHooks(state.tmpProject, { skipGitignore: true })

    const json = JSON.parse(
      readFileSync(join(state.tmpProject, '.codex', 'hooks.json'), 'utf-8')
    ) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> }

    expect(json.hooks.SessionStart).toHaveLength(1)
    expect(json.hooks.Stop).toHaveLength(1)
    expect(json.hooks.PostToolUse).toHaveLength(1)
    expect(json.hooks.PostToolUse[0].matcher).toBe('.*')
    expect(json.hooks.SessionStart[0].hooks[0].command).toContain('pewpew')
  })

  it('preserves existing non-pewpew entries when merging', async () => {
    const codexDir = join(state.tmpProject, '.codex')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(
      join(codexDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: '/usr/local/bin/other-hook.sh' }] }],
        },
      })
    )

    const { installCodexHooks } = await loadInstaller()
    await installCodexHooks(state.tmpProject, { skipGitignore: true })

    const json = JSON.parse(
      readFileSync(join(state.tmpProject, '.codex', 'hooks.json'), 'utf-8')
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }

    expect(json.hooks.SessionStart).toHaveLength(2)
    const commands = json.hooks.SessionStart.map((g) => g.hooks[0].command)
    expect(commands).toContain('/usr/local/bin/other-hook.sh')
    expect(commands.some((c: string) => c.includes('pewpew'))).toBe(true)
  })

  it('replaces stale pewpew entries on re-install', async () => {
    const { installCodexHooks } = await loadInstaller()
    await installCodexHooks(state.tmpProject, { skipGitignore: true })
    await installCodexHooks(state.tmpProject, { skipGitignore: true })

    const json = JSON.parse(
      readFileSync(join(state.tmpProject, '.codex', 'hooks.json'), 'utf-8')
    ) as { hooks: Record<string, unknown[]> }

    expect(json.hooks.SessionStart).toHaveLength(1)
    expect(json.hooks.Stop).toHaveLength(1)
    expect(json.hooks.PostToolUse).toHaveLength(1)
  })

  it.each([
    ['null', 'null'],
    ['number', '42'],
    ['string', '"hello"'],
    ['array', '[1,2,3]'],
    ['malformed', '{not json}'],
  ])('tolerates a %s hooks.json without throwing', async (_label, body) => {
    const codexDir = join(state.tmpProject, '.codex')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(join(codexDir, 'hooks.json'), body)

    const { installCodexHooks } = await loadInstaller()
    await expect(
      installCodexHooks(state.tmpProject, { skipGitignore: true })
    ).resolves.toBeDefined()

    const json = JSON.parse(
      readFileSync(join(state.tmpProject, '.codex', 'hooks.json'), 'utf-8')
    ) as { hooks: Record<string, unknown[]> }
    expect(json.hooks.SessionStart).toHaveLength(1)
  })
})

describe('installRemoteCodexHooks', () => {
  it('migrates an empty remote worktree .codex marker before installing hooks', async () => {
    const codexPath = join(state.tmpProject, '.codex')
    writeFileSync(codexPath, '')

    const { installRemoteCodexHooks } = await loadInstaller()
    await installRemoteCodexHooks(
      vi.fn(execLocally),
      state.tmpProject,
      '/home/dev/.config/pewpew/hooks/notify-v1.sh'
    )

    expect(statSync(codexPath).isDirectory()).toBe(true)
    expect(existsSync(join(codexPath, 'hooks.json'))).toBe(true)
  })
})

describe('ensureCodexProjectConfigDir', () => {
  it('migrates an empty legacy .codex file to the directory Codex config discovery requires', async () => {
    const codexPath = join(state.tmpProject, '.codex')
    writeFileSync(codexPath, '')

    const { ensureCodexProjectConfigDir } = await loadInstaller()
    ensureCodexProjectConfigDir(state.tmpProject)

    expect(statSync(codexPath).isDirectory()).toBe(true)
  })

  it('refuses to replace a non-empty .codex file', async () => {
    const codexPath = join(state.tmpProject, '.codex')
    writeFileSync(codexPath, 'keep me')

    const { ensureCodexProjectConfigDir } = await loadInstaller()
    expect(() => ensureCodexProjectConfigDir(state.tmpProject)).toThrow(/must be a directory/)
    expect(readFileSync(codexPath, 'utf-8')).toBe('keep me')
  })
})

describe('ensureRemoteCodexProjectConfigDir', () => {
  it('migrates an empty legacy .codex file on the remote project root', async () => {
    const codexPath = join(state.tmpProject, '.codex')
    writeFileSync(codexPath, '')
    const execRemote = vi.fn(execLocally)

    const { ensureRemoteCodexProjectConfigDir } = await loadInstaller()
    await ensureRemoteCodexProjectConfigDir(execRemote, state.tmpProject)

    expect(statSync(codexPath).isDirectory()).toBe(true)
    expect(execRemote).toHaveBeenCalledWith(
      expect.arrayContaining(['_', state.tmpProject]),
      expect.anything()
    )
  })

  it('refuses to replace a remote .codex symlink', async () => {
    const codexPath = join(state.tmpProject, '.codex')
    const targetPath = join(state.tmpProject, 'legacy-codex-marker')
    writeFileSync(targetPath, '')
    symlinkSync(targetPath, codexPath)

    const { ensureRemoteCodexProjectConfigDir } = await loadInstaller()
    await expect(
      ensureRemoteCodexProjectConfigDir(vi.fn(execLocally), state.tmpProject)
    ).rejects.toThrow(/must be a directory/)

    expect(statSync(targetPath).isFile()).toBe(true)
    expect(lstatSync(codexPath).isSymbolicLink()).toBe(true)
  })
})

describe('mergeCodexHooksFlag', () => {
  it('inserts [features] table when missing', async () => {
    const { mergeCodexHooksFlag } = await loadInstaller()
    const out = mergeCodexHooksFlag('')
    expect(out).toContain('[features]')
    expect(out).toContain('codex_hooks = true')
  })

  it('inserts codex_hooks key into existing [features] table', async () => {
    const { mergeCodexHooksFlag } = await loadInstaller()
    const input = '[features]\nother_flag = true\n'
    const out = mergeCodexHooksFlag(input)
    expect(out).toContain('other_flag = true')
    expect(out).toContain('codex_hooks = true')
  })

  it('replaces codex_hooks = false with true', async () => {
    const { mergeCodexHooksFlag } = await loadInstaller()
    const input = '[features]\ncodex_hooks = false\n'
    const out = mergeCodexHooksFlag(input)
    expect(out).toContain('codex_hooks = true')
    expect(out).not.toContain('codex_hooks = false')
  })

  it('is idempotent when codex_hooks = true is already set', async () => {
    const { mergeCodexHooksFlag } = await loadInstaller()
    const input = '[features]\ncodex_hooks = true\n'
    const out = mergeCodexHooksFlag(input)
    expect(out).toBe(input)
  })

  it('preserves unrelated tables', async () => {
    const { mergeCodexHooksFlag } = await loadInstaller()
    const input = '[model]\nname = "gpt-5"\n\n[mcp]\nfoo = "bar"\n'
    const out = mergeCodexHooksFlag(input)
    expect(out).toContain('[model]')
    expect(out).toContain('name = "gpt-5"')
    expect(out).toContain('[mcp]')
    expect(out).toContain('foo = "bar"')
    expect(out).toContain('[features]')
    expect(out).toContain('codex_hooks = true')
  })

  it('only matches codex_hooks inside [features], not in other tables', async () => {
    const { mergeCodexHooksFlag } = await loadInstaller()
    const input = '[other]\ncodex_hooks = false\n\n[features]\nfoo = true\n'
    const out = mergeCodexHooksFlag(input)
    // The decoy in [other] must remain untouched
    expect(out).toContain('[other]\ncodex_hooks = false')
    // And [features] must gain codex_hooks = true
    expect(out).toMatch(/\[features\][^[]*codex_hooks = true/)
  })
})

describe('ensureCodexHooksFeatureFlag', () => {
  it('creates ~/.codex/config.toml with [features].codex_hooks = true when missing', async () => {
    const { ensureCodexHooksFeatureFlag } = await loadInstaller()
    ensureCodexHooksFeatureFlag()
    const out = readFileSync(join(state.tmpHome, '.codex', 'config.toml'), 'utf-8')
    expect(out).toContain('[features]')
    expect(out).toContain('codex_hooks = true')
  })

  it('is idempotent', async () => {
    const { ensureCodexHooksFeatureFlag } = await loadInstaller()
    ensureCodexHooksFeatureFlag()
    const first = readFileSync(join(state.tmpHome, '.codex', 'config.toml'), 'utf-8')
    ensureCodexHooksFeatureFlag()
    const second = readFileSync(join(state.tmpHome, '.codex', 'config.toml'), 'utf-8')
    expect(second).toBe(first)
  })

  it('preserves existing config.toml content', async () => {
    mkdirSync(join(state.tmpHome, '.codex'), { recursive: true })
    writeFileSync(
      join(state.tmpHome, '.codex', 'config.toml'),
      '[model]\nname = "gpt-5"\n\n[features]\nother_flag = true\n'
    )

    const { ensureCodexHooksFeatureFlag } = await loadInstaller()
    ensureCodexHooksFeatureFlag()

    const out = readFileSync(join(state.tmpHome, '.codex', 'config.toml'), 'utf-8')
    expect(out).toContain('[model]')
    expect(out).toContain('name = "gpt-5"')
    expect(out).toContain('other_flag = true')
    expect(out).toContain('codex_hooks = true')
  })
})

describe('ensureRemoteCodexHooksFeatureFlag', () => {
  // Regression: the remote script used a fixed `config.toml.tmp` path, so two
  // sessions reviving concurrently on the same host (sessions:revive-batch)
  // could race on the same tmp file and crash under `set -e`. A PID-suffixed
  // tmp path removes that crash; the transform itself is idempotent, so a
  // lost update between the two concurrent runs is harmless.
  //
  // A naive Promise.all over two execFileSync-backed invocations would NOT
  // catch a regression here: execFileSync blocks the single JS thread, so the
  // first shell script runs to completion before the second is even spawned —
  // fully serialized, passing identically against the old shared-tmp-path
  // script. To force genuine overlap, wrap each invocation's `mv` step in a
  // barrier: both signal readiness, the test releases them together once both
  // have arrived, guaranteeing the two writes actually interleave instead of
  // relying on OS scheduling luck (which would make the test flaky at best).
  it('does not corrupt config.toml when two invocations for the same host truly overlap', async () => {
    const barrierDir = mkdtempSync(join(tmpdir(), 'codex-barrier-'))
    const readyDir = join(barrierDir, 'ready')
    const barrierFile = join(barrierDir, 'go')
    mkdirSync(readyDir)

    function execWithBarrier(
      argv: string[]
    ): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }> {
      const wrapped =
        'mv() { : > "$READY_DIR/$$"; while [ ! -f "$BARRIER_FILE" ]; do sleep 0.02; done; command mv "$@"; }\n' +
        argv[2]
      return new Promise((resolve) => {
        execFile(
          'sh',
          ['-c', wrapped],
          {
            encoding: 'utf-8',
            env: {
              ...process.env,
              HOME: state.tmpHome,
              READY_DIR: readyDir,
              BARRIER_FILE: barrierFile,
            },
          },
          (error, stdout, stderr) => {
            const code = error
              ? typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
                ? (error as { code: number }).code
                : 1
              : 0
            resolve({ stdout, stderr, code, timedOut: false })
          }
        )
      })
    }

    try {
      const { ensureRemoteCodexHooksFeatureFlag } = await loadInstaller()
      const both = Promise.all([
        ensureRemoteCodexHooksFeatureFlag(execWithBarrier),
        ensureRemoteCodexHooksFeatureFlag(execWithBarrier),
      ])
      while (readdirSync(readyDir).length < 2) {
        await new Promise((r) => setTimeout(r, 10))
      }
      writeFileSync(barrierFile, '')

      await expect(both).resolves.toBeDefined()

      const out = readFileSync(join(state.tmpHome, '.codex', 'config.toml'), 'utf-8')
      expect(out).toContain('[features]')
      expect(out).toContain('codex_hooks = true')
    } finally {
      rmSync(barrierDir, { recursive: true, force: true })
    }
  })
})

describe('rollbackCodexHooks', () => {
  it('removes .codex/hooks.json when there was no prior file', async () => {
    const { installCodexHooks, rollbackCodexHooks } = await loadInstaller()
    const snapshot = await installCodexHooks(state.tmpProject, { skipGitignore: true })
    expect(existsSync(join(state.tmpProject, '.codex', 'hooks.json'))).toBe(true)
    rollbackCodexHooks(snapshot)
    expect(existsSync(join(state.tmpProject, '.codex', 'hooks.json'))).toBe(false)
  })

  it('restores the prior file content (preserving unrelated user hooks)', async () => {
    const codexDir = join(state.tmpProject, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const priorJson = JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: '/usr/local/bin/other-hook.sh' }] }],
      },
    })
    writeFileSync(join(codexDir, 'hooks.json'), priorJson)

    const { installCodexHooks, rollbackCodexHooks } = await loadInstaller()
    const snapshot = await installCodexHooks(state.tmpProject, { skipGitignore: true })

    // Pretend the feature-flag step failed; rollback must put the original back.
    rollbackCodexHooks(snapshot)

    const restored = readFileSync(join(state.tmpProject, '.codex', 'hooks.json'), 'utf-8')
    expect(restored).toBe(priorJson)
  })
})
