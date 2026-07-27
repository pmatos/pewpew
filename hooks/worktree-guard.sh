#!/usr/bin/env bash
# pewpew worktree write guard — PreToolUse hook for Write/Edit/MultiEdit/NotebookEdit.
#
# Claude Code's own sandbox only isolates Bash subprocesses; the built-in file
# tools go through the permission system instead, which --dangerously-skip-permissions
# (pewpew always passes) disables entirely. This hook is the only thing left
# that stops an agent from writing outside its session worktree via those
# tools, for Claude Code sessions only — Codex and omp sessions have their own
# separate hook mechanisms and are not wired to this guard (see
# hook-installer.ts). It does not see Bash writes — that containment is a
# separate layer.
#
# Usage: worktree-guard.sh <worktree-root>
# The root is baked in at hook-install time as an argv arg, never read from
# the hook payload's `cwd` field: by the time an agent has escaped, cwd is
# exactly what it already moved.

root="$1"
[ -z "$root" ] && exit 0

# Canonicalize the root itself (resolves any symlinks in the worktree path).
root_real=$(cd "$root" 2>/dev/null && pwd -P) || exit 0

payload=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  # jq is required for every decision this hook makes, so its absence can't
  # be treated as "nothing to guard here" — that would silently disable the
  # guard for the rest of the session. Deny with a hand-built JSON reason
  # (there's no jq available to build one) instead of failing open.
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"pewpew: worktree guard cannot run because jq is not installed on this host; blocking the write (fail-closed)"}}'
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
  iterations=0
  while [ "${#queue[@]}" -gt 0 ]; do
    iterations=$((iterations + 1))
    # Bound total work so a symlink cycle can't hang the hook indefinitely.
    [ "$iterations" -gt 256 ] && return 1

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
      last=$((${#resolved[@]} - 1))
      unset 'resolved[last]'
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
[ -z "$target_real" ] && exit 0

# Path-boundary check: target must be the root itself, or start with "root/".
# A plain string-prefix check would let a sibling like "<root>-evil" through.
case "$target_real" in
  "$root_real") allowed=1 ;;
  "$root_real"/*) allowed=1 ;;
  *) allowed=0 ;;
esac

reason=""
guard_settings="$root_real/.claude/settings.local.json"
if [ "$target_real" = "$guard_settings" ]; then
  allowed=0
  reason="pewpew: this hook's own settings file ($guard_settings) may not be edited"
fi

[ "${allowed:-0}" = "1" ] && exit 0

if [ -z "$reason" ]; then
  reason="pewpew: blocked write outside the session worktree ($root_real) — target resolved to $target_real"
fi

jq -nc --arg reason "$reason" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
exit 0
