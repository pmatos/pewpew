# Architecture deepening backlog

Persistent memory for the `pm-deepen` routine. Each `## <slug>` is a deepening
candidate; `### Run` blocks under a slug (or under `## Run log`) are firing
history. Status is one of `proposed | in-flight | landed | dropped | rejected`.

> **Note (2026-09-10):** `origin/main` does not yet carry this file. Two prior
> firings opened architecture PRs (#300, #301) that remain unmerged, so their
> backlogs live only on their own branches. Until one merges, every firing starts
> from a backlog-less `origin/main` and re-derives the same deterministic top
> pick. See the Run log.

## remote-agent-spawn-seam

- **Status**: in-flight
- **Score**: 22/25 (leverage 4, locality 4, blast radius 1, heat 5)
- **Files**: ~2 estimated — `src/main/session-manager.ts`, `src/main/session-manager.test.ts`
- **Modules**: `src/main/session-manager.ts` (the 4 remote session creators + `reviveSession`)
- **Summary**: The four remote-session creators (`adoptRemoteWorktree`, `createRemoteSession`, `createRemotePrSession`, `createRemoteIssueSession`) repeat a verbatim prologue (resolve agent binary) and 3-step epilogue (rev-parse branch → install hooks → create remote pty), each destructuring 6 lease fields only to re-thread 5 straight onward — a shallow, leaky seam that has already drifted (throw-vs-return error contract; buildSession placement in-vs-out of the lease). Collapse into one deep `spawnRemoteAgent` seam.
- **First seen**: 2026-09-01 (as `spawn-remote-agent-pipeline`, PR #300) / 2026-09-02 (as `remote-spawn-epilogue`, PR #301)
- **PR**: #300 and #301 (two open, mergeable, duplicate implementations)
- **Reason**: Already in flight. Highest-scoring candidate, but blocked by the one-architecture-PR-at-a-time rule — not re-picked while a PR is open.

## git-runner-factory-pair

- **Status**: proposed
- **Score**: 21/25 (leverage 4, locality 3, blast radius 1, heat 5)
- **Files**: ~1–2 estimated — `src/main/session-manager.ts` (optionally `src/main/origin-base.ts`)
- **Modules**: `src/main/session-manager.ts`, `src/main/origin-base.ts` (`GitRunner`)
- **Summary**: The `GitRunner` adapter already exists but is hand-inlined seven times — local as `(argv) => execFileAsync('git', ['-C', projectPath, ...argv])`, remote as `(argv) => expectRemoteOk(host, ['git','-C',projectPath,...argv])`. Two factory functions (`localGitRunner`, `remoteGitRunner`) concentrate git transport into two spots. Watch-out: local inline runners disagree on timeout (5000 / 30000 / none) — the factory must take a `timeoutMs`. Runner-up candidate to `remote-agent-spawn-seam`; enables `unified-worktree-at-base`.
- **First seen**: 2026-09-10

## unified-worktree-at-base

- **Status**: proposed
- **Score**: 21/25 (leverage 4, locality 4, blast radius 2, heat 5)
- **Files**: ~1–2 estimated — `src/main/session-manager.ts`, possibly `src/main/worktree-adoption.ts`
- **Modules**: `src/main/session-manager.ts`, `src/main/worktree-adoption.ts`
- **Summary**: Four creators resolve a base then build the same `createOrAdoptWorktree({ addNewBranch, branchExists, adoptExistingBranch })` triple, differing only by git transport (what `git-runner-factory-pair` abstracts). Also surfaces a live inconsistency: `createSession`/`createRemoteSession` use try-then-fallback while `createRemotePrSession`'s own comment says that pattern "masked real failures" and was replaced with probe-first. Unifying forces the choice. Depends on `git-runner-factory-pair`; carries a real behaviour decision, so needs a pinning test.
- **First seen**: 2026-09-10

## session-open-summary

- **Status**: proposed
- **Score**: 21/25 (leverage 4, locality 4, blast radius 1, heat 4)
- **Files**: ~2 estimated — new `src/renderer/utils/session-open-summary.ts`, `src/renderer/components/ProjectTree.tsx`
- **Modules**: `src/renderer/components/ProjectTree.tsx`
- **Summary**: Pure `(OpenSessionsSummary) => string` formatters (`describeCreateError`, `formatPrSpecSummary`, `formatPrSpecErrors`, `formatOpenAllSummary`) plus a copy-pasted mirror epilogue live as closures inside a 1196-line component, reachable only by rendering the tree and simulating IPC. Extract to a pure, unit-testable util. Follows the existing `resolveBulkPrDialogDefaults` precedent (already extracted + tested in `ProjectTree.test.ts`).
- **First seen**: 2026-09-10

## exec-target-seam

- **Status**: proposed
- **Score**: 21/25 (leverage 5, locality 5, blast radius 4, heat 4)
- **Files**: ~8 estimated — `host-connection.ts`, `pty-manager.ts`, `remote-thumbnail.ts`, `agent-resumability.ts`, `host-bootstrap.ts`, `remote-host-runtime.ts`, `session-manager.ts`, `github-items.ts`
- **Modules**: main-process command layer
- **Summary**: The `(argv, opts) => Promise<ExecResult>` shape is redeclared ~11 times but has only a _remote_ adapter — a hypothetical seam. Local code hand-rolls `execFile`. Two adapters (`remoteTarget`, `localTarget`) would collapse paired git/tmux helpers (`resolveGitDir`/`resolveRemoteGitDir`, `hasTmuxSession`/`hasRemoteTmuxSession`, etc.). Highest raw leverage, but blast radius 4: touches exported (non-wire) types across the tier and forces `createPty` sync→async. Depends on `ssh-invoke-and-exec-result-helpers` (which supplies `isSshTransportFailure`/`execFailureDetail` for the remote adapter). Too large to be a good unattended first pick.
- **First seen**: 2026-09-10

## ssh-invoke-and-exec-result-helpers

- **Status**: proposed
- **Score**: 20/25 (leverage 4, locality 4, blast radius 2, heat 4)
- **Files**: ~5 estimated — `host-connection.ts`, `remote-command.ts`, `host-bootstrap.ts`, `pty-manager.ts`, `hook-installer.ts`
- **Modules**: `src/main/host-connection.ts`, `src/main/remote-command.ts` (currently a 25-line, 2-function shallow module)
- **Summary**: The ssh-argv prologue (`-o BatchMode=yes`, `ControlPath`, `-tt`, `--`, alias, cmd) is hand-built ~6×; the `ExecResult` failure epilogue (`stderr||stdout||exit N`) appears 10× across 5 files; the `classifySshExit` 4-reason transport check appears 3×. Grow shallow `remote-command.ts` into a deep home for `execFailureDetail` + `isSshTransportFailure`, and add a private `buildSshArgv` in `host-connection.ts`. Tractable first slice and a prerequisite for `exec-target-seam`.
- **First seen**: 2026-09-10

## canvas-geometry

- **Status**: proposed
- **Score**: 20/25 (leverage 4, locality 5, blast radius 1, heat 2)
- **Files**: ~2 estimated — new `src/renderer/utils/canvas-geometry.ts`, `src/renderer/components/SessionCanvas.tsx`
- **Modules**: `src/renderer/components/SessionCanvas.tsx`
- **Summary**: The zoom/pan re-anchor invariant (`pan = screenAnchor − worldAnchor × zoom`) is duplicated three times inside the canvas component, with a comment warning two copies must be hand-kept-in-sync, and is only reachable through a real DOM + ResizeObserver + rAF. Extract to a pure module (`zoomAtPoint`, `clampForPersist`, `reAnchor`, `assignDefaultPositions`). The truest shallow→deep transform in the renderer, and the cleanest test-first target — but low heat.
- **First seen**: 2026-09-10

## coalesce-adoption-seam

- **Status**: proposed
- **Score**: 19/25 (leverage 3, locality 3, blast radius 1, heat 5)
- **Files**: ~1 estimated — `src/main/session-manager.ts`
- **Modules**: `src/main/session-manager.ts`
- **Summary**: `createSessionForWorktree` and `createRemoteSessionForWorktree` run a near-verbatim ~30-line in-flight-dedup dance (lookup → `assertToolCompatible` → check inflight map → identical mismatch error → set map → `try/finally delete`), differing only by lookup fn and map key. Extract `coalesceAdoption(map, key, tool, existing, run)`.
- **First seen**: 2026-09-10

## hunk-annotations

- **Status**: proposed
- **Score**: 18/25 (leverage 4, locality 4, blast radius 2, heat 2)
- **Files**: ~5 estimated — new `src/renderer/utils/hunk-annotations.ts`, `prompt-generator.ts`, `DiffViewer.tsx`, `stores/review.ts`, `ReviewOverlay.tsx`
- **Modules**: review feature (renderer)
- **Summary**: The `"path::index"` hunk-key contract is duplicated (`getHunkKey` defined in two modules), parsed ad hoc (`.split('::')`), and the severity precedence rule (rejected > commented > approved) is copy-pasted across three files. One module owning key construction/parsing + `hunkSeverity`. Touches an exported interface (`getHunkKey` exported twice), so blast radius 2.
- **First seen**: 2026-09-10

## host-lifecycle-cascade

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 4, blast radius 2, heat 4)
- **Files**: ~3 estimated — `src/main/index.ts`, `src/main/host-registry.ts` (or new `host-lifecycle.ts`), one test
- **Modules**: `src/main/index.ts` (`hosts:delete`, `hosts:update` IPC handlers)
- **Summary**: The `hosts:delete` IPC handler owns a load-bearing 7-module teardown cascade (documented in a 12-line comment); `host-registry.deleteHost` is only the trivial last step. Extract `forgetHost`/`retargetHost` so the ordering lives behind one call and the handler shrinks to a one-liner. Genuine leaky seam, but only 2 call sites.
- **First seen**: 2026-09-10

## detail-pane-view

- **Status**: proposed
- **Score**: 16/25 (leverage 3, locality 3, blast radius 1, heat 2)
- **Files**: ~2 estimated — new util, `src/renderer/components/DetailPane.tsx`
- **Modules**: `src/renderer/components/DetailPane.tsx`
- **Summary**: `(status, connectionState)` is decoded into ~8 overlapping booleans that the JSX re-branches on — a small state machine embedded in a component, reachable only by rendering. Extract `deriveDetailView(session) => { mode, reason }`. Weakest candidate.
- **First seen**: 2026-09-10

## Run log

### Run 2026-09-10 — bailed (top candidate in-flight)

- **Outcome**: bailed — top candidate already in-flight (one-architecture-PR-at-a-time gate)
- **Stopped at**: step 2 — the highest-scoring candidate `remote-agent-spawn-seam` (22/25) is already implemented by two open, mergeable PRs from prior firings of this routine, so opening a third concurrent architecture PR is forbidden.
- **Branch**: `sym/pewpew/routine/refactor-audit/01M246JVDA` (adopted — non-default, 0 commits ahead of `origin/main`, no upstream, unpublished on origin)
- **Committed**: `.architecture/backlog.md`, `.architecture/reviews/2026-09-10-remote-agent-spawn-seam.md`
- **Evidence**: PR #300 (`refactor(session-manager): extract remote agent spawn tail into a deep module`, branch `01M1FK9R13`, opened 2026-09-01, OPEN/MERGEABLE) and PR #301 (`refactor(session-manager): collapse the 4 remote-spawn copies into one deep seam`, branch `01M1J5Q8D9`, opened 2026-09-02, OPEN/MERGEABLE) both implement `remote-agent-spawn-seam`. Neither has merged, so `origin/main` carries no `.architecture/backlog.md`; each firing re-derives the same deterministic top pick because the persisted-backlog dedup is defeated by the unmerged PRs.
- **Next**: A human should merge or close #300/#301 (they are duplicates of each other — #300 extracts a new `remote-agent-spawn.ts` module + test; #301 keeps the seam inside `session-manager.ts`). Once one merges, its backlog lands on `origin/main`, the candidate reconciles to `landed`, and the next firing advances to the runner-up candidate `git-runner-factory-pair` (21/25). The one-PR-at-a-time rule — not lack of candidates — stopped this run; ten further scored candidates are recorded above.
