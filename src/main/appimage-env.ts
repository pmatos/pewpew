const SCALAR_VARS = ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD'] as const

// ld.so(8) accepts both spaces and colons as LD_PRELOAD separators with no
// escaping, so this variable needs a wider split than the colon-only PATH-style
// list — otherwise `"/usr/lib/libasan.so /tmp/.mount_*/libfoo.so"` survives as
// a single non-matching entry and the AppImage preload leaks into children.
const PATH_LIST_VARS_COLON = [
  'LD_LIBRARY_PATH',
  'PATH',
  'XDG_DATA_DIRS',
  'XDG_CONFIG_DIRS',
  'PYTHONPATH',
  'PYTHONHOME',
  'PERLLIB',
  'PERL5LIB',
  'GIO_MODULE_DIR',
  'GSETTINGS_SCHEMA_DIR',
  'GST_PLUGIN_SYSTEM_PATH',
  'GDK_PIXBUF_MODULE_FILE',
  'QT_PLUGIN_PATH',
] as const

const PATH_LIST_VARS_SPACE_OR_COLON = ['LD_PRELOAD'] as const

const MOUNT_PREFIX_RE = /^\/tmp\/\.mount_[^/]+(\/|$)/

function isAppImageEntry(entry: string, appDir: string | undefined): boolean {
  // Empty entries in LD_LIBRARY_PATH/PATH-style lists mean "current dir" — never
  // safe to forward, so treat them as drop-able alongside actual AppImage paths.
  if (entry === '') return true
  if (appDir && (entry === appDir || entry.startsWith(`${appDir}/`))) return true
  return MOUNT_PREFIX_RE.test(entry)
}

export function sanitizeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }

  // npm exports npm_config_*/npm_package_*/npm_execpath/npm_lifecycle_* as
  // real env vars for the duration of an npm script (e.g. `npm run dev`) and
  // all its descendants, so an agent pewpew spawns from a dev run inherits
  // pewpew's own npm config (e.g. legacy-peer-deps) and silently applies it
  // in unrelated repos. Unlike the AppImage vars below, this must run
  // unconditionally — it's not gated on APPIMAGE being set.
  for (const key of Object.keys(out)) {
    if (key.startsWith('npm_')) delete out[key]
  }

  if (out.APPIMAGE === undefined) return out
  const appDir = out.APPDIR

  for (const key of PATH_LIST_VARS_COLON) {
    const value = out[key]
    if (typeof value !== 'string') continue
    const kept = value.split(':').filter((entry) => !isAppImageEntry(entry, appDir))
    if (kept.length === 0) {
      delete out[key]
    } else {
      out[key] = kept.join(':')
    }
  }

  for (const key of PATH_LIST_VARS_SPACE_OR_COLON) {
    const value = out[key]
    if (typeof value !== 'string') continue
    // Both separators are semantically equivalent to ld.so, so normalize to
    // single spaces on output.
    const kept = value.split(/[ :]+/).filter((entry) => !isAppImageEntry(entry, appDir))
    if (kept.length === 0) {
      delete out[key]
    } else {
      out[key] = kept.join(' ')
    }
  }

  for (const key of SCALAR_VARS) delete out[key]
  for (const key of Object.keys(out)) {
    if (key.startsWith('APPIMAGE_')) delete out[key]
  }
  return out
}
