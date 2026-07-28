// Shared between session-manager.ts (resume-probing) and pty-manager.ts
// (sandbox writable-path scoping) so both stay keyed off the exact same
// per-worktree directory — a mismatch here would make one think history
// exists while the other binds a different directory.
import { realpathSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { relative, isAbsolute } from 'path'

export function canonicalPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

function encodeOmpRelativeSessionDirName(prefix: string, relativePath: string): string {
  const encoded = relativePath.replace(/[/\\:]/g, '-')
  if (!encoded) return prefix
  return prefix.endsWith('-') ? `${prefix}${encoded}` : `${prefix}-${encoded}`
}

// Mirrors omp's own session-directory naming so hasOmpConversationHistory
// (and the sandbox's writable-path scoping) can predict where omp will
// read/write without shelling out. Kept in sync against the POSIX shell port
// below (OMP_ENCODE_SHELL_SCRIPT) by running both against the same table of
// paths.
export function encodeOmpSessionDirName(cwd: string): string {
  const resolvedCwd = canonicalPath(cwd)
  const home = canonicalPath(homedir())
  const tempRoot = canonicalPath(tmpdir())
  const homeRelative = relative(home, resolvedCwd)
  if (homeRelative === '' || (!homeRelative.startsWith('..') && !isAbsolute(homeRelative))) {
    return encodeOmpRelativeSessionDirName('-', homeRelative)
  }
  const tempRelative = relative(tempRoot, resolvedCwd)
  if (tempRelative === '' || (!tempRelative.startsWith('..') && !isAbsolute(tempRelative))) {
    return encodeOmpRelativeSessionDirName('-tmp', tempRelative)
  }
  return `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

// Remote analogue of encodeOmpSessionDirName, mirroring the same
// home-relative / tmp-relative / legacy-absolute encoding in POSIX shell.
// Canonicalizes cwd, $HOME, and the temp root with `cd -P`/`pwd -P` (portable,
// unlike GNU-only `readlink -f`), then pattern-matches which root the cwd
// falls under via `case`. The temp root resolves TMPDIR, then TMP, then TEMP,
// then /tmp — matching Node's own os.tmpdir() fallback order (which the local
// encodeOmpSessionDirName delegates to via tmpdir()), so a remote host that
// sets only TMP or TEMP still encodes a temp-rooted worktree the same way
// omp itself would. session-manager.test.ts runs this through a real shell
// (echoing $enc instead of testing a directory) and asserts parity with
// encodeOmpSessionDirName across a table of representative paths.
export const OMP_ENCODE_SHELL_SCRIPT =
  'canon() { CDPATH= cd -P -- "$1" 2>/dev/null && pwd -P; }; ' +
  'p=$(canon "$1"); [ -n "$p" ] || p="$1"; ' +
  'h=$(canon "$HOME"); [ -n "$h" ] || h="$HOME"; ' +
  'case "$p" in ' +
  '"$h") enc="-" ;; ' +
  '"$h"/*) rel=${p#"$h"/}; enc="-$(printf \'%s\' "$rel" | sed \'s/[\\/\\\\:]/-/g\')" ;; ' +
  '*) t=$(canon "${TMPDIR:-${TMP:-${TEMP:-/tmp}}}"); [ -n "$t" ] || t="${TMPDIR:-${TMP:-${TEMP:-/tmp}}}"; ' +
  'case "$p" in ' +
  '"$t") enc="-tmp" ;; ' +
  '"$t"/*) rel=${p#"$t"/}; enc="-tmp-$(printf \'%s\' "$rel" | sed \'s/[\\/\\\\:]/-/g\')" ;; ' +
  '*) enc="--$(printf \'%s\' "$p" | sed \'s/^[\\/\\\\]//; s/[\\/\\\\:]/-/g\')--" ;; ' +
  'esac ;; ' +
  'esac'
