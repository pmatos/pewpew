# Architecture deepening backlog

Persisted memory of deepening candidates across `pm-deepen` runs. Statuses change;
rows are never deleted. See `.architecture/reviews/<date>-<slug>.md` for the full
scored cards.

## remote-spawn-epilogue

- **Status**: in-flight
- **Score**: 22/25 (leverage 4, locality 4, blast radius 1, heat 5)
- **Files**: ~1 estimated (`src/main/session-manager.ts`, +1 test file)
- **Modules**: `src/main/session-manager.ts` (`adoptRemoteWorktree`, `createRemoteSession`, `createRemotePrSession`, `createRemoteIssueSession`)
- **Summary**: Collapse the four hand-duplicated remote session-spawn prologue/epilogue copies (prepared-host + agent check → resolve-branch → hooks → pty → build → register → broadcast) into one deep seam, unifying the drifted missing-agent contract and branch-fallback.
- **First seen**: 2026-09-03
- **PR**: (set at step 6)

## local-vs-remote-parallel-create

- **Status**: proposed
- **Score**: 21/25 (leverage 5, locality 4, blast radius 4, heat 5)
- **Files**: ~4 estimated
- **Modules**: `src/main/session-manager.ts`, a new git-runner module, `src/main/origin-base.ts`, `src/main/pr-worktree-planner.ts`
- **Summary**: Converge the five local/remote create entrypoint pairs behind a shared `GitRunner` adapter; fixes the local `createPrSession` try-then-fallback masking bug that the remote path already fixed, and the double serialize-batch policy. Natural follow-on to `remote-spawn-epilogue` (a superset of it).
- **First seen**: 2026-09-03

## hook-installer-remote-runner

- **Status**: proposed
- **Score**: 20/25 (leverage 4, locality 4, blast radius 1, heat 3)
- **Files**: ~1 estimated
- **Modules**: `src/main/hook-installer.ts`, `src/main/remote-command.ts`
- **Summary**: One `runRemoteScript` seam + shared jq/TS hook-merge; closes a live divergence where `installRemoteHooks` hard-throws on a malformed prior hooks file while its three sibling installers tolerate it. Distinct runner-up to the pick.
- **First seen**: 2026-09-03

## pty-lifecycle-bimodal-dispatch

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 3, blast radius 2, heat 5)
- **Files**: ~2 estimated
- **Modules**: `src/main/pty-manager.ts`, `src/main/session-manager.ts`
- **Summary**: A `destroyPty(session)`/`reattachPty(session)`/`hasSession(session)` facade dispatching on `session.hostId` collapses ~5 bimodal lifecycle sites in session-manager. Partial concentrate (moves the branch into pty-manager).
- **First seen**: 2026-09-03

## github-items-gh-runner-seam

- **Status**: proposed
- **Score**: 18/25 (leverage 4, locality 4, blast radius 1, heat 1)
- **Files**: ~1 estimated
- **Modules**: `src/main/github-items.ts`
- **Summary**: A `runGh(projectPath, hostId, ghArgs, {errorLabel})` seam collapses the 3× remote-probe prologue and 7× error epilogue and makes `ghApiOpenItemsArgs` the single query source for local and the untested remote shell strings. Cold code (heat 1) — YAGNI ranks it low despite high duplication.
- **First seen**: 2026-09-03

## index-session-ipc-handlers

- **Status**: proposed
- **Score**: 17/25 (leverage 3, locality 3, blast radius 1, heat 3)
- **Files**: ~1 estimated
- **Modules**: `src/main/index.ts`
- **Summary**: Table-drive the 8 single/batch session-op IPC handlers and the 3 review handlers behind `singleOp`/`batchOp` factories and a `localSessionCwd` guard. Shallow (boilerplate reduction, no new hiding seam).
- **First seen**: 2026-09-03

## session-queries-occupancy

- **Status**: proposed
- **Score**: 14/25 (leverage 2, locality 2, blast radius 1, heat 3)
- **Summary**: Six near-identical session predicates in `session-queries.ts`; a shared builder mostly moves complexity rather than concentrating it (each has distinct match rules). Not really a deepening.
- **Modules**: `src/main/session-queries.ts`
- **First seen**: 2026-09-03

## omp-notify-single-source

- **Status**: proposed
- **Score**: 13/25 (leverage 2, locality 2, blast radius 2, heat 3)
- **Summary**: `hooks/omp-notify.ts` and `host-bootstrap.ts:buildOmpHookScript` are hand-synced but currently in sync; unifying risks moving complexity into a template engine. A parity test is the cheaper guard.
- **Modules**: `hooks/omp-notify.ts`, `src/main/host-bootstrap.ts`
- **First seen**: 2026-09-03
