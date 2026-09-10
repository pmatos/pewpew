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

function deleteKeysWithPrefix(env: NodeJS.ProcessEnv, prefix: string): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith(prefix)) delete env[key]
  }
}

// Shared by every colon-separated list var this file filters (PATH and its
// npm-launch node_modules/.bin entries, the AppImage PATH_LIST_VARS_COLON
// vars): split, drop unwanted entries, and collapse back to a single string,
// or undefined when nothing survives — the caller deletes the key in that case.
function filterColonList(value: string, keep: (entry: string) => boolean): string | undefined {
  const kept = value.split(':').filter(keep)
  return kept.length > 0 ? kept.join(':') : undefined
}

export function sanitizeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }

  // npm exports npm_config_*/npm_package_*/npm_execpath/npm_lifecycle_*/INIT_CWD,
  // prepends every ancestor directory's node_modules/.bin (and node-gyp-bin) to
  // PATH, and points NODE at its own node binary — all for the life of any
  // npm-mediated launch (run/exec/npx) and all descendants. Left unstripped, an
  // agent pewpew spawns from `npm run dev` inherits pewpew's own npm config
  // (e.g. legacy-peer-deps), and a bare `eslint`/`tsc`/`prettier` the agent runs
  // in an unrelated repo silently resolves through pewpew's own node_modules/.bin
  // ahead of that repo's. Gate on npm_execpath — only ever set by npm itself,
  // never by a user — so a packaged/.deb launch where a user has deliberately
  // exported e.g. npm_config_registry/npm_config_proxy for their own npm usage
  // keeps it.
  if (out.npm_execpath !== undefined) {
    deleteKeysWithPrefix(out, 'npm_')
    delete out.INIT_CWD
    delete out.NODE
    const path = out.PATH
    if (typeof path === 'string') {
      const filtered = filterColonList(
        path,
        (entry) => !entry.endsWith('/node_modules/.bin') && !entry.endsWith('/node-gyp-bin')
      )
      if (filtered === undefined) {
        delete out.PATH
      } else {
        out.PATH = filtered
      }
    }
  }

  if (out.APPIMAGE === undefined) return out
  const appDir = out.APPDIR

  for (const key of PATH_LIST_VARS_COLON) {
    const value = out[key]
    if (typeof value !== 'string') continue
    const filtered = filterColonList(value, (entry) => !isAppImageEntry(entry, appDir))
    if (filtered === undefined) {
      delete out[key]
    } else {
      out[key] = filtered
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
  deleteKeysWithPrefix(out, 'APPIMAGE_')
  return out
}
