# Architecture deepening backlog

Persisted candidate memory for the `pm-deepen` routine. Reconciled against `gh` at the start of every run. Never delete rows — statuses change, rows stay.

## spawn-remote-agent-pipeline

- **Status**: in-flight
- **Score**: 23/25 (leverage 5, locality 4, blast radius 2, heat 5)
- **Files**: 3 (session-manager.ts + new remote-agent-spawn.ts + its test)
- **Modules**: `src/main/session-manager.ts`, new `src/main/remote-agent-spawn.ts`
- **Summary**: Extract the verbatim post-worktree remote spawn tail (resolve branch → install hooks → create pty) shared by the four remote create/adopt paths into one deep primitive; leave revive as-is.
- **First seen**: 2026-09-02
- **PR**: #300

### Run 2026-09-02 — complete

- **Outcome**: complete
- **Stopped at**: step 6 — PR opened
- **Branch**: `sym/pewpew/routine/refactor-audit/01M1FK9R13`, adopted (all four adoption conditions held; not renamed — the harness note about a `pm-deepen/<slug>` branch describes the create-branch path only)
- **Committed**: report, backlog, `remote-agent-spawn.ts` + its test, `session-manager.ts` (4 commits)
- **Evidence**: PR #300; gate green — tsc, eslint, vitest 866/866 (under `TMPDIR=/tmp`), build
- **Next**: review/merge #300; next firing picks up `remote-reconnect-coordinator` (21/25)

## remote-reconnect-coordinator

- **Status**: proposed
- **Score**: 21/25 (leverage 4, locality 5, blast radius 2, heat 4)
- **Files**: ~3 estimated
- **Modules**: `src/main/session-manager.ts` (1183-1529), new `src/main/remote-reconnect.ts`
- **Summary**: House reconnect/probe orchestration (two in-flight maps + prepared-host lease lifecycle) behind a coordinator with an injected SessionLookup seam.
- **First seen**: 2026-09-02
- **Reason (note)**: runner-up candidate; direction partly depends on the session-store SessionLookup seam, so best sequenced after it.

## session-store

- **Status**: proposed
- **Score**: 20/25 (leverage 4, locality 5, blast radius 4, heat 5)
- **Files**: large diff (~3 files, broad test-harness churn)
- **Modules**: `src/main/session-manager.ts`, new `src/main/session-store.ts`
- **Summary**: Replace the raw sessions Map + hand-paired onSessionsChanged() with a SessionStore that owns mutate+persist+notify and exposes a batch() primitive (must preserve the #185 write-storm batching).
- **First seen**: 2026-09-02

## materialize-pr-worktree

- **Status**: proposed
- **Score**: 20/25 (leverage 4, locality 4, blast radius 2, heat 4)
- **Files**: ~3 estimated
- **Modules**: `src/main/session-manager.ts`, `src/main/pr-worktree-planner.ts`, new `src/main/pr-worktree-materializer.ts`
- **Summary**: One executor for the PR-worktree plan, probe-first, driven by an injected GitRunner; removes a latent local-path try-then-fallback bug the remote path already fixed.
- **First seen**: 2026-09-02

## resolve-local-review-context

- **Status**: proposed
- **Score**: 19/25 (leverage 3, locality 4, blast radius 2, heat 5)
- **Files**: ~1–2 estimated
- **Modules**: `src/main/index.ts` (596-641)
- **Summary**: Extract the shared review-IPC preamble (getSession → reject remote → reviewGit) into one resolver; the three review:* handlers collapse to a call each.
- **First seen**: 2026-09-02

## create-broadcast-setting-store

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 5, blast radius 2, heat 3)
- **Files**: ~3 estimated
- **Modules**: `src/renderer/stores/theme.ts`, `src/renderer/stores/animations.ts`
- **Summary**: A createBroadcastSetting factory owning the stale-reply race guard the two setting stores currently hand-sync.
- **First seen**: 2026-09-02

## git-runner-factories

- **Status**: proposed
- **Score**: 17/25 (leverage 3, locality 3, blast radius 2, heat 4)
- **Files**: ~2 estimated
- **Modules**: `src/main/session-manager.ts`, new `src/main/git-runner.ts`
- **Summary**: localGitRunner/remoteGitRunner factories owning the GitRunner adapter and a uniform timeout policy (createPrSession's runner currently has no timeout).
- **First seen**: 2026-09-02

## single-owner-pr-metadata

- **Status**: proposed
- **Score**: 17/25 (leverage 3, locality 5, blast radius 2, heat 2)
- **Files**: ~2 estimated
- **Modules**: `src/main/github.ts` (9-52), `src/main/pr-worktree-planner.ts` (12-58)
- **Summary**: Collapse the verbatim PrViewInfo/PR_VIEW_FIELDS/forkFieldsFromPr/describePrLookupFailure duplication to a single owner (github.ts).
- **First seen**: 2026-09-02

## unify-gh-query-dispatch

- **Status**: proposed
- **Score**: 16/25 (leverage 3, locality 4, blast radius 1, heat 1)
- **Files**: ~1 estimated
- **Modules**: `src/main/github-items.ts`
- **Summary**: A runGh dispatcher owning probe + local/remote branch + error wrapping once, so each gh query declares only its endpoint/jq/parser.
- **First seen**: 2026-09-02

## hunk-key-value

- **Status**: proposed
- **Score**: 15/25 (leverage 3, locality 3, blast radius 3, heat 3)
- **Files**: ~4 estimated
- **Modules**: `src/renderer/stores/review.ts`, `src/renderer/utils/prompt-generator.ts`, `src/renderer/components/review/DiffViewer.tsx`, `src/renderer/components/ReviewOverlay.tsx`
- **Summary**: Give the `filePath::hunkIndex` composite key a hunkKey/parseHunkKey owner instead of building it in three places and splitting it in a fourth.
- **First seen**: 2026-09-02

## config-ipc-passthrough

- **Status**: dropped
- **Score**: not scored (hard-filtered)
- **Files**: ~4+ estimated
- **Modules**: `src/main/index.ts` (643-721), `src/preload`, `src/renderer/env.d.ts`
- **Summary**: A registerConfigChannel helper over the 13 config:* IPC channels.
- **First seen**: 2026-09-02
- **Reason**: Leverage 1 — fails the deletion test; mostly moves IPC plumbing rather than concentrating behaviour, and touches the published IPC contract.

## repo-ref-value-object

- **Status**: dropped
- **Score**: not scored (hard-filtered)
- **Files**: many (exported types + preload + renderer consumers)
- **Modules**: `src/shared/types.ts`, `src/main/github.ts`, `src/main/pr-worktree-planner.ts`, `src/main/github-items.ts`
- **Summary**: A RepoRef value object (parse/format/equality) for owner/name pairs.
- **First seen**: 2026-09-02
- **Reason**: Published-interface change — rewrites exported shared types and the preload IPC surface; the autonomy contract bars expanding a published interface unattended beyond what the pick requires.

## gh-string-error-union

- **Status**: dropped
- **Score**: not scored (hard-filtered)
- **Files**: many (pervasive convention)
- **Modules**: `src/main/github-items.ts`, `src/renderer/components/ProjectTree.tsx`
- **Summary**: Replace the `T | string` value-or-error-message channel with a typed Result.
- **First seen**: 2026-09-02
- **Reason**: Pervasive-convention migration across many files, not a single seam.
