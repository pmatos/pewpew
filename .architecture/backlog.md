# Architecture deepening backlog

Persisted memory for the `pm-deepen` routine. Statuses: `proposed` (surfaced, scored, eligible), `in-flight` (branch + PR exist), `landed` (merged), `dropped` (a hard filter excluded it — reversible), `rejected` (a human declined it — only a human reopens). Never delete entries.

## remote-spawn-epilogue

- **Status**: in-flight
- **Score**: not scored by this firing (prior firing's pick)
- **Files**: `src/main/session-manager.ts`, `src/main/session-manager.test.ts`
- **Modules**: `src/main/session-manager.ts`
- **Summary**: Collapse the four remote session-creation functions (`adoptRemoteWorktree`, `createRemoteSession`, `createRemotePrSession`, `createRemoteIssueSession`) — the shared `withPreparedHost` prologue and `installRemoteAgentHooks → createRemotePty → buildSession → registerSpawnedSession` epilogue — into one deep seam.
- **First seen**: 2026-09-04 (by reconciliation; PR opened 2026-09-02)
- **PR**: #301
- **Reason**: Open architecture PR from a prior firing of this routine. Overlaps `remote-agent-spawn` (#300); the two cannot both merge cleanly.

## remote-agent-spawn

- **Status**: in-flight
- **Score**: not scored by this firing (prior firing's pick)
- **Files**: `src/main/remote-agent-spawn.ts`, `src/main/remote-agent-spawn.test.ts`, `src/main/session-manager.ts`
- **Modules**: `src/main/session-manager.ts`, `src/main/remote-agent-spawn.ts`
- **Summary**: Extract the remote agent spawn tail out of `session-manager.ts` into a new `remote-agent-spawn.ts` deep module.
- **First seen**: 2026-09-04 (by reconciliation; PR opened 2026-09-01)
- **PR**: #300
- **Reason**: Open architecture PR from a prior firing of this routine. Overlaps `remote-spawn-epilogue` (#301).

## session-manager-spawn-reattach-seam

- **Status**: dropped
- **Score**: 22/25 (leverage 4, locality 4, blast radius 1, heat 5)
- **Files**: ~4 estimated
- **Modules**: `src/main/session-manager.ts` (`:1614-1641`, `:1555-1597`, `:1660-1689`), new `src/main/agent-spawn.ts`
- **Summary**: One `resumeOrSpawnAgent(session, transport, {onHookError})` seam for the reattach-or-resume decision the three revive/attach paths re-assemble by hand.
- **First seen**: 2026-09-04
- **PR**: —
- **Reason**: Hard filter — overlaps in-flight PRs #300/#301 (same file, remote-spawn family). Reversible: reconsider the local reattach-or-resume remainder once #300/#301 merge.

## local-remote-git-twins-exec-adapter

- **Status**: proposed
- **Score**: 20/25 (leverage 4, locality 3, blast radius 1, heat 4)
- **Files**: ~3 estimated
- **Modules**: `src/main/session-manager.ts`, `src/main/worktree-adoption.ts`
- **Summary**: A `GitExec` adapter so the create-or-adopt git argv lives once instead of being written twice, per transport (execFile vs ssh).
- **First seen**: 2026-09-04
- **Reason**: Runner-up candidate. Not started — one-architecture-PR-at-a-time while #300/#301 are open, and it touches the same hot file those PRs rewrite.

## agent-state-path-prefixes-centralize

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 4, blast radius 1, heat 3)
- **Files**: ~4 estimated
- **Modules**: `src/main/agent-state-paths.ts`, `src/main/pty-manager.ts`, `src/main/remote-agent-state.ts`, `src/main/agent-resumability.ts`
- **Summary**: Move the `.claude/projects` / `.omp/agent/sessions` prefixes next to their encoders (finishing commit `fccb2ca`), including the shell-script analogues.
- **First seen**: 2026-09-04
- **Reason**: Not started — one-architecture-PR-at-a-time while #300/#301 are open. Independent of the spawn subsystem; a good next pick.

## agent-profile-table

- **Status**: proposed
- **Score**: 18/25 (leverage 4, locality 3, blast radius 3, heat 4)
- **Files**: ~9 estimated
- **Modules**: `src/main/pty-manager.ts`, `src/main/remote-agent-state.ts`, `src/main/agent-resumability.ts`, `src/main/session-manager.ts`, `src/main/numbered-session-plan.ts`, `src/main/session-state-machine.ts`, `src/main/host-bootstrap.ts`
- **Summary**: Back the three tools (claude/codex/omp) with a data-only `AGENT_PROFILES` table so per-tool policy stops being nine scattered switch statements. North-star; approach incrementally.
- **First seen**: 2026-09-04
- **Reason**: Not started. Larger blast radius (9 files); only safe if rows stay data. Best reached via the smaller candidates.

## agent-hook-install-two-seams

- **Status**: proposed
- **Score**: 16/25 (leverage 3, locality 3, blast radius 2, heat 3)
- **Files**: ~3 estimated
- **Modules**: `src/main/session-manager.ts`, `src/main/hook-installer.ts`
- **Summary**: Unify `installAgentHooks` / `installRemoteAgentHooks` / the claude-only `relocateProject` bypass behind one tool-dispatched installer, exposing `hooksEmbedWorktreePath(tool)` from `hook-installer.ts`.
- **First seen**: 2026-09-04
- **Reason**: Not started. Touches the same hot file as #300/#301.

## omp-hook-bridge-hand-sync-drift

- **Status**: proposed
- **Score**: 16/25 (leverage 3, locality 3, blast radius 2, heat 3)
- **Files**: ~3 estimated
- **Modules**: `src/main/host-bootstrap.ts`, `hooks/omp-notify.ts`
- **Summary**: Derive the remote omp bridge from `hooks/omp-notify.ts` (build-time raw import + path substitution) instead of hand-maintaining a second copy. Preserves the omp `--hook` script contract.
- **First seen**: 2026-09-04
- **Reason**: Not started — one-architecture-PR-at-a-time. Independent of the spawn subsystem.

## ssh-base-argv-prologue

- **Status**: proposed
- **Score**: 14/25 (leverage 2, locality 3, blast radius 1, heat 2)
- **Files**: ~2 estimated
- **Modules**: `src/main/host-connection.ts`
- **Summary**: Collapse the repeated `-o BatchMode=yes …` ssh prologue (7 sites) into `sshBaseArgv(runtime, {master?})`.
- **First seen**: 2026-09-04
- **Reason**: Not started. Lowest-leverage candidate; consistency win, not a depth win.

## Run log

### Run 2026-09-04 — bailed (concurrent architecture PRs)

- **Outcome**: bailed-mid-flight (blocked at pick — one-architecture-PR-at-a-time)
- **Stopped at**: step 2 (reconcile/pick) — the top candidate `session-manager-spawn-reattach-seam` (22/25) targets the remote-spawn family in `session-manager.ts` that two open PRs from prior firings already refactor.
- **Branch**: `sym/pewpew/routine/refactor-audit/01M1MR2N1C` (adopted — non-default, 0 ahead of origin/main, no upstream, unpublished; kept the caller's name, not renamed to the slug)
- **Committed**: `.architecture/reviews/2026-09-04-session-manager-spawn-reattach-seam.md` and this `.architecture/backlog.md`.
- **Evidence**: PR #300 (`sym/pewpew/routine/refactor-audit/01M1FK9R13`, OPEN/MERGEABLE, remote agent spawn tail → `remote-agent-spawn.ts`) and PR #301 (`sym/pewpew/routine/refactor-audit/01M1J5Q8D9`, OPEN/MERGEABLE, collapse the 4 remote-spawn copies). Both refactor the same file and overlap each other. `.architecture/` does not exist on `origin/main` because neither has merged, so this backlog was reconciled by direct `gh` inspection.
- **Next**: A human should land or close PR #300 and #301 (they conflict with each other — pick one). Once the remote-spawn refactor settles, the next firing can reconsider the local reattach-or-resume remainder of `session-manager-spawn-reattach-seam`, or pick the runner-up `local-remote-git-twins-exec-adapter` (20/25), or an independent candidate such as `agent-state-path-prefixes-centralize` / `omp-hook-bridge-hand-sync-drift`.
