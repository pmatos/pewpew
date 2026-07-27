#!/usr/bin/env bash
# pewpew worktree write guard — PreToolUse hook for Write/Edit/MultiEdit/NotebookEdit.
#
# Claude Code's own sandbox only isolates Bash subprocesses; the built-in file
# tools go through the permission system instead, which --dangerously-skip-permissions
# (pewpew always passes) disables entirely. This hook is the only thing left
# that stops an agent from writing outside its session worktree via those
# tools. It does not see Bash writes — that containment is a separate layer.
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
target=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)
[ -z "$target" ] && exit 0

# Resolve an absolute, symlink-free path even when the target doesn't exist
# yet (a new file's parent directory may not have been created). Walk up from
# the target until an existing *directory* ancestor is found (an existing
# regular file can't be cd'd into, so -d rather than -e), canonicalize that,
# then re-append the unresolved remainder.
resolve_path() {
  p="$1"
  case "$p" in
    /*) ;;
    *) p="$root_real/$p" ;;
  esac
  suffix=""
  while [ ! -d "$p" ]; do
    suffix="/${p##*/}$suffix"
    parent="${p%/*}"
    if [ "$parent" = "$p" ] || [ -z "$parent" ]; then
      p="/"
      break
    fi
    p="$parent"
  done
  base=$(cd "$p" 2>/dev/null && pwd -P) || { printf ''; return; }
  printf '%s%s\n' "$base" "$suffix"
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
