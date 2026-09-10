import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { sanitizeChildEnv } from './child-env'

describe('sanitizeChildEnv', () => {
  it('drops APPIMAGE and APPDIR when both are set', () => {
    const env = {
      APPIMAGE: '/home/u/dev/pewpew/release/pewpew-0.2.1-pre.0.AppImage',
      APPDIR: '/tmp/.mount_pewpewXYZ',
      HOME: '/home/u',
    }

    const out = sanitizeChildEnv(env)

    expect(out.APPIMAGE).toBeUndefined()
    expect(out.APPDIR).toBeUndefined()
    expect(out.HOME).toBe('/home/u')
  })

  it('drops other AppImage launcher variables', () => {
    const env = {
      APPIMAGE: '/path/to/pewpew.AppImage',
      APPDIR: '/tmp/.mount_pewpewXYZ',
      ARGV0: 'pewpew-0.2.1-pre.0',
      OWD: '/home/u/dev/project',
      APPIMAGE_UUID: 'abc-123',
      APPIMAGE_EXTRACT_AND_RUN: '1',
      HOME: '/home/u',
    }

    const out = sanitizeChildEnv(env)

    expect(out.ARGV0).toBeUndefined()
    expect(out.OWD).toBeUndefined()
    expect(out.APPIMAGE_UUID).toBeUndefined()
    expect(out.APPIMAGE_EXTRACT_AND_RUN).toBeUndefined()
    expect(out.HOME).toBe('/home/u')
  })

  it('filters AppImage mount entries out of LD_LIBRARY_PATH but keeps user entries', () => {
    const env = {
      APPIMAGE: '/path/to/pewpew.AppImage',
      APPDIR: '/tmp/.mount_pewpewXYZ',
      LD_LIBRARY_PATH: '/tmp/.mount_pewpewXYZ/usr/lib:/usr/lib/custom:/opt/local/lib',
    }

    const out = sanitizeChildEnv(env)

    expect(out.LD_LIBRARY_PATH).toBe('/usr/lib/custom:/opt/local/lib')
  })

  it('removes LD_LIBRARY_PATH entirely when filtering empties it', () => {
    const env = {
      APPIMAGE: '/path/to/pewpew.AppImage',
      APPDIR: '/tmp/.mount_pewpewXYZ',
      LD_LIBRARY_PATH: '/tmp/.mount_pewpewXYZ/usr/lib:',
    }

    const out = sanitizeChildEnv(env)

    expect('LD_LIBRARY_PATH' in out).toBe(false)
  })

  it('filters /tmp/.mount_* entries even when APPDIR was already scrubbed by an intermediate process', () => {
    const env = {
      APPIMAGE: '/path/to/pewpew.AppImage',
      LD_LIBRARY_PATH: '/tmp/.mount_pewpewXYZ/usr/lib:/usr/lib/custom',
    }

    const out = sanitizeChildEnv(env)

    expect(out.LD_LIBRARY_PATH).toBe('/usr/lib/custom')
  })

  it('broad-scrubs other path-list variables touched by the AppImage runtime', () => {
    const appDir = '/tmp/.mount_pewpewXYZ'
    const env = {
      APPIMAGE: '/path/to/pewpew.AppImage',
      APPDIR: appDir,
      PATH: `${appDir}/usr/bin:/usr/local/bin:/usr/bin`,
      XDG_DATA_DIRS: `${appDir}/usr/share:/usr/local/share:/usr/share`,
      PYTHONPATH: `${appDir}/usr/lib/python3.12`,
      GIO_MODULE_DIR: `${appDir}/usr/lib/gio/modules`,
      GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas`,
      QT_PLUGIN_PATH: `${appDir}/usr/plugins`,
      LD_PRELOAD: `${appDir}/usr/lib/libfake.so`,
    }

    const out = sanitizeChildEnv(env)

    expect(out.PATH).toBe('/usr/local/bin:/usr/bin')
    expect(out.XDG_DATA_DIRS).toBe('/usr/local/share:/usr/share')
    expect('PYTHONPATH' in out).toBe(false)
    expect('GIO_MODULE_DIR' in out).toBe(false)
    expect('GSETTINGS_SCHEMA_DIR' in out).toBe(false)
    expect('QT_PLUGIN_PATH' in out).toBe(false)
    expect('LD_PRELOAD' in out).toBe(false)
  })

  // ld.so(8): "The items of the list can be separated by spaces or colons,
  // and there is no support for escaping either separator."
  it('filters space-delimited AppImage entries from LD_PRELOAD', () => {
    const appDir = '/tmp/.mount_pewpewXYZ'
    const env = {
      APPIMAGE: '/path/to/pewpew.AppImage',
      APPDIR: appDir,
      LD_PRELOAD: `/usr/lib/libasan.so ${appDir}/usr/lib/libfoo.so`,
    }

    const out = sanitizeChildEnv(env)

    expect(out.LD_PRELOAD).toBe('/usr/lib/libasan.so')
  })

  it('handles LD_PRELOAD with mixed space and colon delimiters', () => {
    const appDir = '/tmp/.mount_pewpewXYZ'
    const env = {
      APPIMAGE: '/path/to/pewpew.AppImage',
      APPDIR: appDir,
      LD_PRELOAD: `/usr/lib/libasan.so ${appDir}/usr/lib/libfoo.so:/opt/local/lib/libbar.so`,
    }

    const out = sanitizeChildEnv(env)

    expect(out.LD_PRELOAD).toBe('/usr/lib/libasan.so /opt/local/lib/libbar.so')
  })

  it('removes LD_PRELOAD entirely when only AppImage entries remain after space split', () => {
    const appDir = '/tmp/.mount_pewpewXYZ'
    const env = {
      APPIMAGE: '/path/to/pewpew.AppImage',
      APPDIR: appDir,
      LD_PRELOAD: `${appDir}/usr/lib/libfoo.so ${appDir}/usr/lib/libbar.so`,
    }

    const out = sanitizeChildEnv(env)

    expect('LD_PRELOAD' in out).toBe(false)
  })

  it('leaves non-npm vars untouched when APPIMAGE is not set (dev runs, .deb installs)', () => {
    const env = {
      HOME: '/home/u',
      PATH: '/usr/local/bin:/usr/bin',
      LD_LIBRARY_PATH: '/usr/lib/custom',
      // An empty entry that would normally be filtered — proves we don't touch
      // LD_LIBRARY_PATH at all when not running under AppImage.
      PYTHONPATH: '',
    }

    const out = sanitizeChildEnv(env)

    expect(out).toEqual(env)
  })

  it('strips npm_config_*/npm_package_*/npm_execpath/npm_lifecycle_* even when APPIMAGE is not set', () => {
    const env = {
      HOME: '/home/u',
      npm_config_legacy_peer_deps: 'true',
      npm_config_local_prefix: '/home/u/dev/pewpew',
      npm_package_name: 'pewpew',
      npm_package_version: '0.10.5',
      npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
      npm_lifecycle_event: 'dev',
      npm_lifecycle_script: 'electron-vite dev',
      npm_command: 'run',
    }

    const out = sanitizeChildEnv(env)

    expect(out).toEqual({ HOME: '/home/u' })
  })

  it('keeps a user-exported npm_config_* var when there is no npm_execpath marker (packaged/.deb launch, not an npm script)', () => {
    const env = {
      HOME: '/home/u',
      npm_config_registry: 'https://npm.corp.example.com/',
    }

    const out = sanitizeChildEnv(env)

    expect(out).toEqual(env)
  })

  it('strips INIT_CWD alongside npm_* vars when npm_execpath marks a real npm-mediated launch', () => {
    const env = {
      HOME: '/home/u',
      npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
      INIT_CWD: '/home/u/dev/pewpew',
    }

    const out = sanitizeChildEnv(env)

    expect(out).toEqual({ HOME: '/home/u' })
  })

  it('strips NODE and node_modules/.bin (and node-gyp-bin) PATH entries when npm_execpath marks a real npm-mediated launch', () => {
    const env = {
      HOME: '/home/u',
      npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
      NODE: '/home/u/.nvm/versions/node/v26.5.0/bin/node',
      PATH: '/home/u/dev/pewpew/node_modules/.bin:/usr/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin:/usr/local/bin:/usr/bin',
    }

    const out = sanitizeChildEnv(env)

    expect('NODE' in out).toBe(false)
    expect(out.PATH).toBe('/usr/local/bin:/usr/bin')
  })

  it('strips npm_*/INIT_CWD/NODE even when APPIMAGE is also set, without disturbing the AppImage-specific scrub', () => {
    const appDir = '/tmp/.mount_pewpewXYZ'
    const env = {
      APPIMAGE: '/path/to/pewpew.AppImage',
      APPDIR: appDir,
      HOME: '/home/u',
      npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
      npm_config_legacy_peer_deps: 'true',
      INIT_CWD: '/home/u/dev/pewpew',
      LD_LIBRARY_PATH: `${appDir}/usr/lib:/usr/lib/custom`,
    }

    const out = sanitizeChildEnv(env)

    expect(out).toEqual({
      HOME: '/home/u',
      LD_LIBRARY_PATH: '/usr/lib/custom',
    })
  })

  it('leaves user-provided path-list variables alone when they contain no AppImage entries', () => {
    const env = {
      APPIMAGE: '/path/to/pewpew.AppImage',
      APPDIR: '/tmp/.mount_pewpewXYZ',
      PATH: '/home/u/.local/bin:/usr/local/bin:/usr/bin',
      PYTHONPATH: '/home/u/code/lib',
    }

    const out = sanitizeChildEnv(env)

    expect(out.PATH).toBe('/home/u/.local/bin:/usr/local/bin:/usr/bin')
    expect(out.PYTHONPATH).toBe('/home/u/code/lib')
  })

  describe('end-to-end through real child_process spawn', () => {
    const hasEnv = existsSync('/usr/bin/env')

    it.skipIf(!hasEnv)(
      'a child spawned with sanitized env does not see APPIMAGE/APPDIR or AppImage mount paths',
      () => {
        const poisoned = {
          ...process.env,
          APPIMAGE: '/path/to/pewpew-0.2.1-pre.0.AppImage',
          APPDIR: '/tmp/.mount_pewpewXYZ',
          ARGV0: 'pewpew-0.2.1-pre.0',
          OWD: '/home/u/dev/project',
          LD_LIBRARY_PATH: '/tmp/.mount_pewpewXYZ/usr/lib:/usr/lib/custom',
          PATH: `/tmp/.mount_pewpewXYZ/usr/bin:${process.env.PATH ?? '/usr/bin'}`,
        }

        const stdout = execFileSync('/usr/bin/env', {
          env: sanitizeChildEnv(poisoned) as NodeJS.ProcessEnv,
          encoding: 'utf-8',
        })

        const lines = stdout.split('\n')
        expect(lines.some((l) => l.startsWith('APPIMAGE='))).toBe(false)
        expect(lines.some((l) => l.startsWith('APPDIR='))).toBe(false)
        expect(lines.some((l) => l.startsWith('ARGV0='))).toBe(false)
        expect(lines.some((l) => l.startsWith('OWD='))).toBe(false)
        expect(stdout).not.toContain('/tmp/.mount_pewpew')

        const ldLine = lines.find((l) => l.startsWith('LD_LIBRARY_PATH='))
        expect(ldLine).toBe('LD_LIBRARY_PATH=/usr/lib/custom')
      }
    )
  })
})
