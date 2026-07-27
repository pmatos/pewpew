import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
  renameSync,
  rmSync,
} from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { homedir } from 'os'
import { CONFIG_DIR } from './config'
import { shellQuote } from './shell-quote'
import type { ExecResult } from './host-connection'

const execFileAsync = promisify(execFile)

const NOTIFY_SCRIPT = join(CONFIG_DIR, 'hooks', 'notify.sh')
const GUARD_SCRIPT = join(CONFIG_DIR, 'hooks', 'worktree-guard.sh')

// omp (oh-my-pi) loads its hook bridge directly via the CLI's `--hook <path>`
// flag rather than a declarative JSON hooks file, so there's no install/merge
// step analogous to installHooks/installCodexHooks — just a fixed path that
// buildAgentArgs points `--hook` at. The file itself is copied into place by
// installOmpNotifyScript in index.ts (mirrors installNotifyScript for
// notify.sh), from the repo's hooks/omp-notify.ts.
export const OMP_HOOK_SCRIPT = join(CONFIG_DIR, 'hooks', 'omp-notify.ts')

// Claude Code's own sandbox only isolates Bash subprocesses; the built-in
// Write/Edit/MultiEdit/NotebookEdit tools go through the permission system
// instead, which --dangerously-skip-permissions (always passed by pewpew)
// disables. This PreToolUse hook is the only thing left that stops an agent
// from writing outside its session worktree through those tools — see
// hooks/worktree-guard.sh. It does not cover Bash writes.
function buildHooks(
  notifyScript: string,
  guardScript: string,
  root: string
): Record<string, unknown[]> {
  const notifyHook = { type: 'command', command: notifyScript }
  const guardHook = {
    type: 'command',
    command: `${shellQuote(guardScript)} ${shellQuote(root)}`,
  }
  return {
    SessionStart: [{ hooks: [notifyHook] }],
    Stop: [{ hooks: [notifyHook] }],
    PostToolUse: [{ matcher: 'Read|Write|Edit|Bash', hooks: [notifyHook] }],
    SessionEnd: [{ hooks: [notifyHook] }],
    Notification: [{ hooks: [notifyHook] }],
    PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [guardHook] }],
  }
}

function buildCodexHooks(notifyScript: string): Record<string, unknown[]> {
  const hook = { type: 'command', command: notifyScript }
  return {
    SessionStart: [{ hooks: [hook] }],
    Stop: [{ hooks: [hook] }],
    PostToolUse: [{ matcher: '.*', hooks: [hook] }],
  }
}

function ccPewpewHookJson(notifyScript: string, guardScript: string, root: string): string {
  return JSON.stringify(buildHooks(notifyScript, guardScript, root))
}

function ccPewpewCodexHookJson(notifyScript: string): string {
  return JSON.stringify(buildCodexHooks(notifyScript))
}

function atomicWrite(path: string, contents: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, contents)
  renameSync(tmp, path)
}

// Read file contents or return a fallback if the file is absent. The
// existsSync-then-readFileSync pattern is a classic TOCTOU race (the file
// can vanish between the two calls); doing the read directly inside a
// try/catch on ENOENT removes the gap.
function tryReadFile(path: string, fallback: string | null = null): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw err
  }
}

// JSON.parse can return any valid JSON value — null, primitives, arrays — so
// callers that go on to read `.hooks` need to coerce non-object results back
// to an empty object. Without this, a syntactically valid `null` or `"text"`
// hooks file would crash session setup at the next property access.
function parseAsObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through to empty object
  }
  return {}
}

function isExternalHook(entry: unknown): boolean {
  return !/pewpew/.test(JSON.stringify(entry))
}

export async function installHooks(
  projectPath: string,
  { skipGitignore = false }: { skipGitignore?: boolean } = {}
): Promise<void> {
  const claudeDir = join(projectPath, '.claude')
  mkdirSync(claudeDir, { recursive: true })

  const settingsPath = join(claudeDir, 'settings.local.json')

  const raw = tryReadFile(settingsPath)
  const existing: Record<string, unknown> = raw === null ? {} : parseAsObject(raw)

  const newHooks = buildHooks(NOTIFY_SCRIPT, GUARD_SCRIPT, projectPath)
  const existingHooks = (existing.hooks || {}) as Record<string, unknown[]>
  const merged: Record<string, unknown[]> = { ...existingHooks }

  for (const [event, entries] of Object.entries(newHooks)) {
    const kept = (existingHooks[event] || []).filter(isExternalHook)
    merged[event] = [...kept, ...entries]
  }

  existing.hooks = merged
  writeFileSync(settingsPath, JSON.stringify(existing, null, 2))

  if (!skipGitignore) {
    ensureGitignore(projectPath, '.claude/settings.local.json')
  }
}

export async function installRemoteHooks(
  execRemote: (argv: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>,
  worktreePath: string,
  notifyScriptPath: string,
  guardScriptPath: string
): Promise<void> {
  const hooksJson = ccPewpewHookJson(notifyScriptPath, guardScriptPath, worktreePath)
  const script =
    'set -e\n' +
    'claude_dir="$1/.claude"\n' +
    'settings="$claude_dir/settings.local.json"\n' +
    'mkdir -p "$claude_dir"\n' +
    'if [ -s "$settings" ]; then cat "$settings"; else printf "{}"; fi |\n' +
    'jq --argjson newHooks "$2" \'\n' +
    '  .hooks = (.hooks // {}) |\n' +
    '  reduce ($newHooks | keys[]) as $k (.;\n' +
    '    .hooks[$k] = (((.hooks[$k] // []) | map(select(((. | tostring) | contains("pewpew")) | not))) + $newHooks[$k])\n' +
    '  )\n' +
    '\' > "$settings.tmp"\n' +
    'mv "$settings.tmp" "$settings"\n'
  const result = await execRemote(['sh', '-c', script, '_', worktreePath, hooksJson], {
    timeoutMs: 15000,
  })
  if (result.timedOut || result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    throw new Error(`Failed to install remote hooks: ${detail}`)
  }
}

export async function isSettingsGitignored(projectPath: string): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['-C', projectPath, 'check-ignore', '-q', '.claude/settings.local.json'],
      { timeout: 5000 }
    )
    return true
  } catch {
    return false
  }
}

function ensureGitignore(projectPath: string, entry: string): void {
  const gitignorePath = join(projectPath, '.gitignore')

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8')
    if (content.includes(entry)) return
    appendFileSync(gitignorePath, `\n${entry}\n`)
  } else {
    writeFileSync(gitignorePath, `${entry}\n`)
  }
}

// Codex hook config is a JSON file at <project>/.codex/hooks.json. The shape
// mirrors Claude's `hooks` block (event → matcher groups → handlers) but lives
// in its own file rather than under a settings key.
export interface CodexHooksInstallSnapshot {
  hooksPath: string
  priorContent: string | null
}

export async function installCodexHooks(
  projectPath: string,
  { skipGitignore = false }: { skipGitignore?: boolean } = {}
): Promise<CodexHooksInstallSnapshot> {
  const codexDir = join(projectPath, '.codex')
  mkdirSync(codexDir, { recursive: true })

  const hooksPath = join(codexDir, 'hooks.json')

  // Snapshot the prior file (or its absence) so a rollback after a partial
  // install can restore exactly what was there — including any unrelated
  // user-authored hooks that the merge step folded into the new file.
  const priorContent = tryReadFile(hooksPath)

  const existing: Record<string, unknown> = priorContent !== null ? parseAsObject(priorContent) : {}

  const newHooks = buildCodexHooks(NOTIFY_SCRIPT)
  const existingHooks = (existing.hooks || {}) as Record<string, unknown[]>
  const merged: Record<string, unknown[]> = { ...existingHooks }

  for (const [event, entries] of Object.entries(newHooks)) {
    const kept = (existingHooks[event] || []).filter(isExternalHook)
    merged[event] = [...kept, ...entries]
  }

  existing.hooks = merged
  atomicWrite(hooksPath, JSON.stringify(existing, null, 2))

  if (!skipGitignore) {
    ensureGitignore(projectPath, '.codex/hooks.json')
  }

  return { hooksPath, priorContent }
}

export interface RemoteCodexHooksSnapshot {
  worktreePath: string
  // True when a prior `.codex/hooks.json` existed and was backed up to
  // `.codex/hooks.json.pewpew.bak` before merge. Rollback restores from
  // that backup. False means there was no prior file; rollback unlinks.
  hadPrior: boolean
}

export async function installRemoteCodexHooks(
  execRemote: (argv: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>,
  worktreePath: string,
  notifyScriptPath: string
): Promise<RemoteCodexHooksSnapshot> {
  const hooksJson = ccPewpewCodexHookJson(notifyScriptPath)
  // Snapshot-and-merge in a single SSH round trip: `cp` the prior file to
  // a known backup path (so rollback can restore unrelated user-authored
  // hooks), then run the same merge logic as before. Echo a single line —
  // "1" if a prior file existed, "0" otherwise — so the caller knows
  // whether rollback should restore from the backup or unlink.
  // Mirror the local installer's tolerance for a malformed/non-object prior
  // file. Pre-validate with `jq -e empty`: if the existing hooks.json is
  // unparseable (or not an object), feed `{}` to the merge step instead of
  // letting `jq` abort the whole pipeline. The backup is still made so
  // rollback can restore exactly what was there.
  const script =
    'set -e\n' +
    'codex_dir="$1/.codex"\n' +
    'hooks="$codex_dir/hooks.json"\n' +
    'backup="$codex_dir/hooks.json.pewpew.bak"\n' +
    'mkdir -p "$codex_dir"\n' +
    'if [ -f "$hooks" ]; then cp "$hooks" "$backup"; printf "1"; else printf "0"; fi\n' +
    'if [ -s "$hooks" ] && jq -e \'type == "object"\' "$hooks" >/dev/null 2>&1; then\n' +
    '  cat "$hooks"\n' +
    'else\n' +
    '  printf "{}"\n' +
    'fi |\n' +
    'jq --argjson newHooks "$2" \'\n' +
    '  .hooks = (.hooks // {}) |\n' +
    '  reduce ($newHooks | keys[]) as $k (.;\n' +
    '    .hooks[$k] = (((.hooks[$k] // []) | map(select(((. | tostring) | contains("pewpew")) | not))) + $newHooks[$k])\n' +
    '  )\n' +
    '\' > "$hooks.tmp"\n' +
    'mv "$hooks.tmp" "$hooks"\n'
  const result = await execRemote(['sh', '-c', script, '_', worktreePath, hooksJson], {
    timeoutMs: 15000,
  })
  if (result.timedOut || result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    throw new Error(`Failed to install remote codex hooks: ${detail}`)
  }
  const hadPrior = result.stdout.trim() === '1'
  return { worktreePath, hadPrior }
}

export async function rollbackRemoteCodexHooks(
  execRemote: (argv: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>,
  snapshot: RemoteCodexHooksSnapshot
): Promise<void> {
  const script = snapshot.hadPrior
    ? // Restore prior file from the backup; clean up the backup. If the
      // backup mysteriously vanished, leave the post-merge file in place
      // rather than deleting it (less destructive).
      'set -e\n' +
      'hooks="$1/.codex/hooks.json"\n' +
      'backup="$1/.codex/hooks.json.pewpew.bak"\n' +
      'if [ -f "$backup" ]; then mv "$backup" "$hooks"; fi\n'
    : 'set -e\n' + 'rm -f "$1/.codex/hooks.json"\n'
  await execRemote(['sh', '-c', script, '_', snapshot.worktreePath], {
    timeoutMs: 10000,
  }).catch(() => undefined)
}

// Successful install: drop the .bak we left for rollback. Best-effort.
export async function commitRemoteCodexHooks(
  execRemote: (argv: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>,
  snapshot: RemoteCodexHooksSnapshot
): Promise<void> {
  if (!snapshot.hadPrior) return
  await execRemote(
    ['sh', '-c', 'rm -f "$1/.codex/hooks.json.pewpew.bak"', '_', snapshot.worktreePath],
    { timeoutMs: 5000 }
  ).catch(() => undefined)
}

// Best-effort restoration if the feature-flag enable step fails after we've
// already written .codex/hooks.json. The snapshot lets us restore unrelated
// user-authored hooks that the merge folded in — deleting unconditionally
// would silently lose them. The caller re-throws the original error.
export function rollbackCodexHooks(snapshot: CodexHooksInstallSnapshot): void {
  try {
    if (snapshot.priorContent === null) {
      rmSync(snapshot.hooksPath, { force: true })
    } else {
      atomicWrite(snapshot.hooksPath, snapshot.priorContent)
    }
  } catch {
    // ignore — best-effort
  }
}

const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml')

// Hand-rolled minimal TOML merge — codex hooks are gated behind
// `[features].codex_hooks = true`. We avoid pulling a TOML dep just for one
// boolean, so this finds the [features] table and either sets, replaces, or
// inserts the key. Any other content is preserved verbatim.
export function mergeCodexHooksFlag(input: string): string {
  const lines = input.split('\n')
  const isFeaturesHeader = (l: string): boolean => /^\s*\[\s*features\s*\]\s*(#.*)?$/.test(l)
  const isOtherTable = (l: string): boolean => /^\s*\[/.test(l) && !isFeaturesHeader(l)
  const codexHooksKey = /^\s*codex_hooks\s*=/

  let inFeatures = false
  let featuresHeaderIdx = -1
  let foundKeyIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isFeaturesHeader(line)) {
      inFeatures = true
      featuresHeaderIdx = i
      continue
    }
    if (inFeatures && isOtherTable(line)) {
      inFeatures = false
      continue
    }
    if (inFeatures && codexHooksKey.test(line)) {
      foundKeyIdx = i
      break
    }
  }

  if (foundKeyIdx >= 0) {
    if (/^\s*codex_hooks\s*=\s*true\s*(#.*)?$/.test(lines[foundKeyIdx])) return input
    lines[foundKeyIdx] = 'codex_hooks = true'
    return lines.join('\n')
  }

  if (featuresHeaderIdx >= 0) {
    lines.splice(featuresHeaderIdx + 1, 0, 'codex_hooks = true')
    return lines.join('\n')
  }

  const trailing = input.length === 0 || input.endsWith('\n') ? '' : '\n'
  return `${input}${trailing}\n[features]\ncodex_hooks = true\n`
}

export function ensureCodexHooksFeatureFlag(): void {
  mkdirSync(join(homedir(), '.codex'), { recursive: true })
  const current = tryReadFile(CODEX_CONFIG_PATH, '') ?? ''
  const next = mergeCodexHooksFlag(current)
  if (next === current) return
  atomicWrite(CODEX_CONFIG_PATH, next)
}

export async function ensureRemoteCodexHooksFeatureFlag(
  execRemote: (argv: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>
): Promise<void> {
  // Mirrors mergeCodexHooksFlag in shell: parse line-by-line via awk, set
  // codex_hooks=true inside [features], inserting the table if absent. Atomic
  // via tmp+mv. Idempotent — re-running yields identical content.
  const script =
    'set -e\n' +
    'cfg="$HOME/.codex/config.toml"\n' +
    'mkdir -p "$HOME/.codex"\n' +
    '[ -f "$cfg" ] || printf "" > "$cfg"\n' +
    "awk '\n" +
    '  BEGIN { inFeat=0; injected=0; replaced=0 }\n' +
    '  /^[[:space:]]*\\[[[:space:]]*features[[:space:]]*\\][[:space:]]*(#.*)?$/ { print; inFeat=1; next }\n' +
    '  /^[[:space:]]*\\[/ {\n' +
    '    if (inFeat==1 && injected==0 && replaced==0) { print "codex_hooks = true"; injected=1 }\n' +
    '    inFeat=0; print; next\n' +
    '  }\n' +
    '  inFeat==1 && /^[[:space:]]*codex_hooks[[:space:]]*=/ { print "codex_hooks = true"; replaced=1; next }\n' +
    '  { print }\n' +
    '  END {\n' +
    '    if (replaced==1) exit 0\n' +
    '    if (inFeat==1 && injected==0) { print "codex_hooks = true"; exit 0 }\n' +
    '    if (injected==0) { print ""; print "[features]"; print "codex_hooks = true" }\n' +
    '  }\n' +
    '\' "$cfg" > "$cfg.tmp"\n' +
    'mv "$cfg.tmp" "$cfg"\n'
  const result = await execRemote(['sh', '-c', script], { timeoutMs: 10000 })
  if (result.timedOut || result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    throw new Error(`Failed to enable codex hooks feature flag on remote: ${detail}`)
  }
}
