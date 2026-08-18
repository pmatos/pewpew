#!/usr/bin/env bash
# pewpew worktree write guard — PreToolUse hook for Write/Edit/MultiEdit/NotebookEdit.
#
# Claude Code's own sandbox only isolates Bash subprocesses; the built-in file
# tools go through the permission system instead. pewpew runs claude under
# --permission-mode=auto (see buildAgentArgs in pty-manager.ts) rather than
# --dangerously-skip-permissions, so that system's own classifier is in the
# loop — but it's a probabilistic approval mode, not a hard boundary, and its
# own docs note it can be bypassed on context compaction. This hook is the
# backstop that unconditionally blocks writes outside the session worktree
# via those tools, for Claude Code sessions only — Codex and omp sessions
# have their own separate hook mechanisms and are not wired to this guard
# (see hook-installer.ts). It does not see Bash writes — that containment is
# a separate layer.
#
# This hook only validates the target and exits; the actual Write/Edit runs
# afterward as a separate step, so a TOCTOU race between validation and write
# (e.g. a path swapped out from under a symlink) is a structural limitation,
# not something this script can close.
#
# Usage: worktree-guard.sh <worktree-root>
# The root is baked in at hook-install time as an argv arg, never read from
# the hook payload's `cwd` field: by the time an agent has escaped, cwd is
# exactly what it already moved.

root="$1"
[ -z "$root" ] && exit 0

payload=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  # jq is required for every decision this hook makes, so its absence can't
  # be treated as "nothing to guard here" — that would silently disable the
  # guard for the rest of the session. Deny with a hand-built JSON reason
  # (there's no jq available to build one) instead of failing open.
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"pewpew: worktree guard cannot run because jq is not installed on this host; blocking the write (fail-closed)"}}'
  exit 0
fi

# A payload that isn't valid JSON at all is indistinguishable, further down,
# from "a tool call with no file_path" (both make the later jq extractions
# come back empty) — which exits allow. That's the wrong default for
# malformed input: legitimate Write/Edit/MultiEdit/NotebookEdit calls from
# Claude Code are always well-formed JSON, so anything else must fail closed.
if ! printf '%s' "$payload" | jq -e . >/dev/null 2>&1; then
  jq -nc --arg reason "pewpew: the hook payload is not valid JSON; blocking the write (fail-closed)" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
fi

# Canonicalize the root itself (resolves any symlinks in the worktree path).
# A cd failure means the baked-in root no longer matches reality (e.g. the
# worktree was relocated or deleted after this hook was installed) — deny
# rather than silently allowing every write, the same fail-closed posture
# used for every other failure mode below.
root_real=$(cd "$root" 2>/dev/null && pwd -P)
if [ -z "$root_real" ]; then
  jq -nc --arg reason "pewpew: could not resolve the worktree root ($root) — it may have been moved or deleted; blocking the write (fail-closed)" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
fi

# /tmp is exempt from the worktree boundary: under the bwrap sandbox it's a
# private --tmpfs mount unique to this session (see agent-sandbox.ts), not
# the host's shared /tmp, so a write there can't reach another session or
# the host filesystem the way a write to an arbitrary host path could. This
# hook has no visibility into whether bwrap is actually active for *this*
# session (it's installed with just the worktree root baked in), so on an
# unsandboxed session /tmp is genuinely the shared host /tmp and this
# exemption is a real (accepted) gap there — bwrap being unavailable already
# degrades every other write-containment guarantee this project makes, not
# just this one. Canonicalized the same way as root_real so a symlinked
# /tmp (e.g. macOS's /tmp -> /private/tmp) still matches.
tmp_real=$(cd /tmp 2>/dev/null && pwd -P)

# ~/.claude is exempt from the worktree boundary too: Claude Code keeps
# adding per-invocation scratch state directly under ~/.claude
# (session-env/, tasks/, and its cross-project auto-memory system under
# projects/<other-project>/memory/, keyed by the MAIN repo's path — not
# this worktree's), so a write there is expected and this hook would
# otherwise be the one thing left blocking it. claude sessions are never
# bwrap-sandboxed (see buildAgentArgs in pty-manager.ts), so
# CLAUDE_DIR_WRITE_DENYLIST below — this hook's own list, not shared with
# any other file — is what re-closes the specific entries that would turn
# a compromised write into a persistence vector for every later session
# that loads them. Canonicalized the same way as root_real/tmp_real so a
# symlinked ~/.claude (e.g. a dotfiles-managed home) still matches, and
# gated the same way below on being non-empty so a failed `cd` can't
# collapse the case pattern into a match-everything wildcard.
#
# Deliberately NOT extended to ~/.claude.json (sibling of this dir, not a
# child — mixes benign per-project bookkeeping with global MCP server
# config): the boundary check below only matches "$claude_real" or
# "$claude_real"/*, which a sibling file never does, so no extra exclusion
# is needed for it.
claude_real=$(cd "$HOME/.claude" 2>/dev/null && pwd -P)
CLAUDE_DIR_WRITE_DENYLIST=(
  commands output-styles skills agents plugins backups daemon shell-snapshots
  settings.json settings.backup.json CLAUDE.md statusline.sh .credentials.json
)

# Check for an embedded/trailing newline in the raw JSON string BEFORE ever
# assigning it into a shell variable: `target=$(...)` below would silently
# strip a trailing newline via command substitution, so validating $target
# after the fact can't detect it — a file literally named "evil\n" would
# then be checked as the (different, likely nonexistent) path "evil" while
# Write/Edit still operates on the real newline-suffixed name. jq's `test()`
# runs against the full string value jq parsed from the JSON, unaffected by
# shell stripping.
has_newline=$(printf '%s' "$payload" | jq -r '(.tool_input.file_path // .tool_input.notebook_path // "") | test("\n")' 2>/dev/null)
if [ "$has_newline" = "true" ]; then
  jq -nc --arg reason "pewpew: the write target contains a newline; blocking the write (fail-closed)" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
fi

target=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)
[ -z "$target" ] && exit 0

# Resolve an absolute, symlink-free, `.`/`..`-normalized path even when the
# target doesn't exist yet (a new file's parent directory may not have been
# created). Processes path components left to right through a work queue:
# `..` pops the last resolved component lexically, independent of whether
# that component currently exists on disk; any component that resolves to an
# existing symlink — including the FINAL component, and including a symlink
# to a regular file rather than a directory — has its target re-queued for
# the same treatment, so a chain of symlinks and `..` segments is fully
# unwound rather than left partially resolved (which previously let a
# final-component symlink, or a `..` past a not-yet-created component,
# through unresolved).
resolve_path() {
  p="$1"
  case "$p" in
    /*) ;;
    *) p="$root_real/$p" ;;
  esac

  queue=()
  IFS='/' read -r -a queue <<< "$p"

  resolved=()
  symlink_hops=0
  iterations=0
  while [ "${#queue[@]}" -gt 0 ]; do
    iterations=$((iterations + 1))
    # Backstop against a pathological number of path components; ordinary
    # paths never come close to this.
    [ "$iterations" -gt 10000 ] && return 1

    part="${queue[0]}"
    queue=("${queue[@]:1}")

    case "$part" in
      '' | '.') continue ;;
      '..')
        last=$((${#resolved[@]} - 1))
        [ "$last" -ge 0 ] && unset 'resolved[last]'
        continue
        ;;
    esac

    resolved+=("$part")
    candidate="/$(IFS=/; printf '%s' "${resolved[*]}")"

    if [ -L "$candidate" ]; then
      symlink_hops=$((symlink_hops + 1))
      # Bound symlink dereferences specifically (matching Linux's own
      # MAXSYMLINKS), not ordinary path components, so a genuinely deep but
      # legitimate path can't spuriously hit this cap — only a symlink cycle
      # can.
      [ "$symlink_hops" -gt 40 ] && return 1
      last=$((${#resolved[@]} - 1))
      unset 'resolved[last]'
      # Same newline-truncation class as the target extraction above: a
      # symlink whose target string itself contains a newline would have
      # that newline silently dropped by `$(readlink ...)`, potentially
      # collapsing an out-of-worktree target onto an in-worktree-looking
      # string. `readlink` normally emits exactly one line (the target plus
      # its own terminator); more than one line means the target contains an
      # embedded or trailing newline. Piped directly to `wc -l`, unaffected
      # by command-substitution stripping.
      [ "$(readlink "$candidate" | wc -l)" -gt 1 ] && return 1
      linktarget=$(readlink "$candidate") || return 1
      case "$linktarget" in
        /*) resolved=() ;;
      esac
      target_parts=()
      IFS='/' read -r -a target_parts <<< "$linktarget"
      queue=("${target_parts[@]}" "${queue[@]}")
    fi
  done

  printf '/%s' "$(IFS=/; printf '%s' "${resolved[*]}")"
}

target_real=$(resolve_path "$target")

reason=""
allowed=0

if [ -z "$target_real" ]; then
  # resolve_path failed (symlink-cycle cap, a component vanishing mid-walk,
  # or similar) — the same fail-closed reasoning as everywhere else in this
  # script: if the guard can't determine whether a target is safe, it must
  # not let it through.
  reason="pewpew: could not canonicalize the write target ($target); blocking the write (fail-closed)"
else
  # Path-boundary check: target must be the root itself, or start with "root/".
  # A plain string-prefix check would let a sibling like "<root>-evil" through.
  case "$target_real" in
    "$root_real") allowed=1 ;;
    "$root_real"/*) allowed=1 ;;
    *) allowed=0 ;;
  esac

  # /tmp exemption (see tmp_real above). Guarded on tmp_real being non-empty
  # and checked outside the case above rather than as extra arms in it: an
  # empty case pattern (if `cd /tmp` ever failed) would collapse "$tmp_real"/*
  # into the wildcard /*, matching every absolute path.
  if [ "$allowed" != "1" ] && [ -n "$tmp_real" ]; then
    case "$target_real" in
      "$tmp_real") allowed=1 ;;
      "$tmp_real"/*) allowed=1 ;;
    esac
  fi

  # ~/.claude exemption (see claude_real above), minus CLAUDE_DIR_WRITE_DENYLIST.
  if [ "$allowed" != "1" ] && [ -n "$claude_real" ]; then
    case "$target_real" in
      "$claude_real") allowed=1 ;;
      "$claude_real"/*) allowed=1 ;;
    esac
    if [ "$allowed" = "1" ]; then
      for entry in "${CLAUDE_DIR_WRITE_DENYLIST[@]}"; do
        denylisted="$claude_real/$entry"
        case "$target_real" in
          "$denylisted" | "$denylisted"/*)
            allowed=0
            reason="pewpew: ~/.claude/$entry is a global execution/config surface loaded by every future session; blocking the write (fail-closed)"
            ;;
        esac
      done
    fi
  fi

  guard_settings="$root_real/.claude/settings.local.json"
  # `-ef` (same file, via inode/device) catches what the exact string match
  # above misses on a case-insensitive-but-case-preserving filesystem (e.g.
  # macOS's default APFS mode): a differently-cased path like
  # ".claude/Settings.local.json" opens the identical on-disk file without
  # matching the string comparison. `-ef` requires both operands to exist,
  # so it only ever adds a match — it can't be tricked by a nonexistent path.
  if [ "$target_real" = "$guard_settings" ] || \
    { [ -e "$target_real" ] && [ -e "$guard_settings" ] && [ "$target_real" -ef "$guard_settings" ]; }; then
    allowed=0
    reason="pewpew: this hook's own settings file ($guard_settings) may not be edited"
  fi
fi

[ "${allowed:-0}" = "1" ] && exit 0

if [ -z "$reason" ]; then
  reason="pewpew: blocked write outside the session worktree ($root_real) — target resolved to $target_real"
fi

jq -nc --arg reason "$reason" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
exit 0
