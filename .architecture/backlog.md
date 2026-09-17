# Architecture deepening backlog

Persisted candidate memory for the `pm-deepen` routine. Reconciled against `gh` at the start of every run. Never delete rows — statuses change, rows stay.

## spawn-remote-agent-pipeline

- **Status**: landed
- **Score**: 23/25 (leverage 5, locality 4, blast radius 2, heat 5)
- **Files**: 3 (session-manager.ts + new remote-agent-spawn.ts + its test)
- **Modules**: `src/main/session-manager.ts`, new `src/main/remote-agent-spawn.ts`
- **Summary**: Extract the verbatim post-worktree remote spawn tail (resolve branch → install hooks → create pty) shared by the four remote create/adopt paths into one deep primitive; leave revive as-is.
- **First seen**: 2026-09-02
- **PR**: #300

### Run 2026-09-11 — reconciled

- PR #300 merged 2026-09-10 (also `fc9c9e4` on main) → status `in-flight` → `landed`. PR #301, a duplicate firing of this same candidate, was closed unmerged; no separate row.

### Run 2026-09-02 — complete

- **Outcome**: complete
- **Stopped at**: step 6 — PR opened
- **Branch**: `sym/pewpew/routine/refactor-audit/01M1FK9R13`, adopted (all four adoption conditions held; not renamed — the harness note about a `pm-deepen/<slug>` branch describes the create-branch path only)
- **Committed**: report, backlog, `remote-agent-spawn.ts` + its test, `session-manager.ts` (4 commits)
- **Evidence**: PR #300; gate green — tsc, eslint, vitest 866/866 (under `TMPDIR=/tmp`), build
- **Next**: review/merge #300; next firing picks up `remote-reconnect-coordinator` (21/25)

## remote-reconnect-coordinator

- **Status**: landed
- **Score**: 21/25 (leverage 4, locality 5, blast radius 2, heat 4)
- **Files**: 3 (session-manager.ts + new remote-reconnect.ts + its test)
- **Modules**: `src/main/session-manager.ts`, new `src/main/remote-reconnect.ts`
- **Summary**: House reconnect/probe orchestration (two in-flight maps + prepared-host lease lifecycle) behind a coordinator with an injected SessionLookup seam.
- **First seen**: 2026-09-02
- **PR**: #312
- **Reason (note)**: 2026-09-11 — picked this run (top surviving score, 21/25). Sequencing note honoured, not blocked: the coordinator defines its own minimal SessionLookup port; session-manager satisfies it via a thin Map adapter today, and session-store (next) will implement the same port.

### Run 2026-09-18 — reconciled

- PR #312 merged 2026-09-16 (`760f6b5` on main) → status `in-flight` → `landed`. The `SessionLookup` port it declared at `remote-reconnect.ts:13-24` is still satisfied by session-manager's hand-written Map adapter; `session-store` (picked this run) implements it for real.

### Run 2026-09-11 — complete

- **Outcome**: complete
- **Stopped at**: step 6 — PR opened
- **Branch**: `sym/pewpew/routine/refactor-audit/01M26RZFY4`, adopted (all four adoption conditions held: non-default, 0 commits ahead of origin/main, no upstream, unpublished on origin). Not renamed — an adopted branch keeps the caller's name so the harness can find the PR.
- **Committed**: report, backlog, `remote-reconnect.ts` + its test, `session-manager.ts` delegation (4 commits)
- **Evidence**: PR #312; gate green — tsc, eslint, vitest 879/879 (under `TMPDIR=/tmp`), build. session-manager.ts −298 net lines.
- **Next**: review/merge #312; next firing picks up the two 20/25 runner-ups — `session-store` (which should implement the SessionLookup port) or `materialize-pr-worktree`.

## session-store

- **Status**: in-flight
- **Score**: 24/25 (leverage 5, locality 5, blast radius 2, heat 5)
- **Files**: ~5 estimated (new `session-store.ts` + its test, `session-manager.ts`, `remote-reconnect.ts`, `session-manager.test.ts`)
- **Modules**: `src/main/session-manager.ts`, `src/main/remote-reconnect.ts`, new `src/main/session-store.ts`
- **Summary**: Replace the raw sessions Map + hand-paired onSessionsChanged() with a SessionStore that owns mutate+persist+notify+tray and exposes a batch() primitive, implementing the `SessionLookup` port `remote-reconnect.ts:13-24` already declares.
- **First seen**: 2026-09-02
- **Reason (note)**: 2026-09-18 — **re-scored 20/25 → 24/25**; picked this run. Blast radius 4 was a mis-score against the band description: band 4 requires "crosses a package/tier seam, or touches a published interface" and this does neither (`sessions` is module-private; `getSession`/`getSessions` and the `sessions:updated` payload are unchanged). Corrected to 2. Leverage raised 4 → 5: a consumer has already written the interface down, and two latent deferred-notify bugs follow mechanically from the unenforced pairing.
- **Correction**: the write-storm batching fix is **not** issue #185. It is `ffb5083` ("fix: preserve reconnect state across release + batch lastKnownState writes", a PR #53 follow-up), hardened by `6a7bbf3c`. Git #185 is the animations/GPU work (`545dd45`, `6d5a609`) and belongs to `create-broadcast-setting-store`.
- **Invariants any implementation must preserve**:
  1. `batch()` must permit **zero** notifies — `updateLastKnownStatesBatch` (`session-manager.ts:286-299`) ORs per-update dirty flags and may fire nothing at all; `session-manager.test.ts:1537-1601` asserts that case. A `try { fn() } finally { changed() }` batch breaks it.
  2. The store must hand back **live references, not copies** — `remote-reconnect.ts:18-19` says a store returning copies would silently break its re-read. Disqualifies an immutable-snapshot design.
- **Bug-scope decision**: structural only. Existing call sites keep their current notify placement; the two deferred-notify bugs (`relocateProject:1973`, `restoreSessions:2132`) are documented, not fixed, in this PR.
- **PR**: #320
- **Landed shape**: ports-and-adapters design (3 ports: persist/broadcast/tray), `batch(body: () => boolean)` making the try/finally shape unrepresentable, caller-supplied `now` so the store has no clock dependency. 3 files, `session-manager.ts` -86 net lines, `session-manager.test.ts` and `remote-reconnect.ts` both untouched. Gate green: tsc, eslint, vitest 912/912, build.
- **Follow-ups this PR deliberately left**: the two deferred-notify bugs above (now one-line fixes in the store's vocabulary); `lastKnownStateWrites` is not pruned on `delete` (slow leak, unobservable because ids are `randomUUID`); the `?? 0` "never written" sentinel in the rate limiter is carried over and pinned by a test rather than replaced with an absence check.

## materialize-pr-worktree

- **Status**: proposed
- **Score**: 20/25 (leverage 4, locality 4, blast radius 2, heat 4)
- **Files**: ~3 estimated
- **Modules**: `src/main/session-manager.ts`, `src/main/pr-worktree-planner.ts`, new `src/main/pr-worktree-materializer.ts`
- **Summary**: One executor for the PR-worktree plan, probe-first, driven by an injected GitRunner; removes a latent local-path try-then-fallback bug the remote path already fixed.
- **First seen**: 2026-09-02
- **Correction**: 2026-09-18 — the bug claim is true but **narrower** than filed. The local path does probe (`session-manager.ts:1685`) but uses the result only to gate the fork bail-out; only the **same-repo** case still does try-then-fallback (`:1691` → `:1700`). The fork branch is already symmetric with remote.
- **Prerequisite**: there are **zero tests for `createRemotePrSession`** — all 12 `createPrSession` test calls pass `hostId = null`. Remote-executor tests are prerequisite work, not optional.

## resolve-local-review-context

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 4, blast radius 1, heat 3)
- **Files**: ~2 estimated
- **Modules**: `src/main/index.ts` (628-673)
- **Summary**: Extract the shared review-IPC preamble (getSession → reject remote → reviewGit) into one resolver; the three review:* handlers collapse to a call each.
- **First seen**: 2026-09-02
- **Score note**: 2026-09-18 — re-scored 19 → 18. Range shifted 596-641 → 628-673 (5 duplicated lines × 3 handlers). Heat 5 → 3: `index.ts` moved 2026-09-12 but this block dates to 2026-07-10. Blast radius 2 → 1. Caveat: there is **no `src/main/index.test.ts`** anywhere in the repo, so the preamble has zero coverage today; `review.test.ts` covers only the pure functions it calls into.

## create-broadcast-setting-store

- **Status**: proposed
- **Score**: 17/25 (leverage 3, locality 5, blast radius 2, heat 2)
- **Files**: ~4 estimated
- **Modules**: `src/renderer/stores/theme.ts`, `src/renderer/stores/animations.ts`
- **Summary**: A createBroadcastSetting factory owning the stale-reply race guard the two setting stores currently hand-sync.
- **First seen**: 2026-09-02
- **Reason (note)**: 2026-09-18 — re-scored 18 → 17 (heat 3 → 2; `theme.ts` last touched 2026-05-11, `animations.ts` 2026-07-13). **This is where issue #185 actually lives** (`545dd45`, `6d5a609`), not on `session-store`. The predicted drift has already happened: `theme.ts:38` still carries the no-op-broadcast bug that `animations.ts:53-63` fixed in `6d5a609` — a matching cross-window broadcast returns early without bumping `mutationCount`, so a slow in-flight `getTheme()` reply passes the guard at `:55` and clobbers. No `theme.test.ts` or `animations.test.ts` exists; all three race-guard fixes landed untested, so characterization tests are prerequisite work and also most of the value.

## git-runner-factories

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 4, blast radius 2, heat 4)
- **Files**: ~6 estimated
- **Modules**: `src/main/session-manager.ts`, `src/main/index.ts`, `src/main/origin-base.ts`, `src/main/review.ts`, new `src/main/git-runner.ts`
- **Summary**: localGitRunner/remoteGitRunner factories owning the GitRunner adapter and a uniform timeout policy (createPrSession's runner currently has no timeout).
- **First seen**: 2026-09-02
- **Score note**: 2026-09-18 — re-scored 17 → 18 (locality 3 → 4). Timeout claim **confirmed**: `session-manager.ts:1614-1619` passes no options object at all, while the otherwise byte-identical `createIssueSession` runner at `:1756-1763` passes `{ timeout: 30000 }`. The un-timed runner performs `git fetch` against a possibly-unreachable fork upstream at `:1677`. Eight construction sites, five different timeout policies. Bonus: the `GitRunner` **type** is declared byte-identically in `origin-base.ts:6` and `review.ts:9`. Constraint: the `deps.runGit ??` injection points at `:1614-1615`/`:1756-1757` are the existing test seam and must be preserved.

## single-owner-pr-metadata

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 5, blast radius 1, heat 2)
- **Files**: ~2 estimated (`github.ts`, `github.test.ts` — **zero production files change**)
- **Modules**: `src/main/github.ts` (6-52), `src/main/pr-worktree-planner.ts` (9-60)
- **Summary**: Delete the dead duplicate of PrViewInfo/PR_VIEW_FIELDS/forkFieldsFromPr/describePrLookupFailure from `github.ts`, leaving `pr-worktree-planner.ts` the single owner.
- **First seen**: 2026-09-02
- **Reason (note)**: 2026-09-18 — re-scored 17 → 18 (blast radius 2 → 1). It is a **pure deletion**, not a migration: `github.ts`'s `PrViewInfo`/`PR_VIEW_FIELDS` have zero importers repo-wide, and its `forkFieldsFromPr`/`describePrLookupFailure` are reachable only from `github.test.ts`. The duplication is byte-identical across ~33 lines but for one return annotation. `pr-worktree-planner.test.ts` already holds a superset of the coverage being deleted. Residual of commit `92129d6`, which did the same for five other symbols. Ranked below the 21s on heat alone (both files cold since 2026-07-10).

## unify-gh-query-dispatch

- **Status**: proposed
- **Score**: 16/25 (leverage 3, locality 4, blast radius 1, heat 1)
- **Files**: ~3 estimated
- **Modules**: `src/main/github-items.ts`, `src/main/session-manager.ts` (851-853, a 4th probe site outside the module)
- **Summary**: A runGh dispatcher owning probe + local/remote branch + error wrapping once, so each gh query declares only its endpoint/jq/parser.
- **First seen**: 2026-09-02
- **Constraint**: 2026-09-18 — the return types (`NumberedGhItem[] | string` etc.) are mirrored in `preload/index.ts:44-66` and `env.d.ts:65-71`. A dispatcher is safe **only if** it preserves the `T | string` convention; it must stay strictly separate from `gh-string-error-union`. Best-covered module of the set (30 tests), so low-risk whenever scheduled.

## hunk-key-value

- **Status**: proposed
- **Score**: 14/25 (leverage 3, locality 3, blast radius 2, heat 1)
- **Files**: ~6 estimated
- **Modules**: `src/renderer/stores/review.ts`, `src/renderer/utils/prompt-generator.ts`, `src/renderer/components/review/DiffViewer.tsx`, `src/renderer/components/ReviewOverlay.tsx`
- **Summary**: Give the `filePath::hunkIndex` composite key a hunkKey/parseHunkKey owner instead of building it in three places and splitting it in a fourth.
- **First seen**: 2026-09-02
- **Score note**: 2026-09-18 — re-scored 15 → 14 (heat 3 → 1; all four files last touched 2026-05-11). Confirmed: byte-identical `getHunkKey` copies at `DiffViewer.tsx:11-13` and `prompt-generator.ts:31-33`, inlined at `review.ts:31`, split at `ReviewOverlay.tsx:287`. The split uses `split('::')[0]`, which truncates at the first `::` — a tie-breaker, not the headline. The string form is load-bearing: it keys `ReviewSessionState.annotations` and leaks into the DOM as `data-hunk-key`.

## config-ipc-passthrough

- **Status**: dropped
- **Score**: not scored (hard-filtered)
- **Files**: ~4+ estimated
- **Modules**: `src/main/index.ts` (643-721), `src/preload`, `src/renderer/env.d.ts`
- **Summary**: A registerConfigChannel helper over the 13 config:* IPC channels.
- **First seen**: 2026-09-02
- **Reason**: Leverage 1 — fails the deletion test; mostly moves IPC plumbing rather than concentrating behaviour, and touches the published IPC contract.
- **Re-checked**: 2026-09-18 — **filter still applies, strengthened.** Now 14 channels (`index.ts:675-753`). Each channel name is mirrored three times (handler → `preload/index.ts:95-117` → `env.d.ts:97-112`), so a dispatcher edits 3 layers plus 5 renderer consumers / 15 call sites and *widens* the IPC surface to an untyped key-string channel. Two of the 14 are not passthroughs at all (`config:save-theme`, `config:save-reduce-animations` each fan out a `BrowserWindow.getAllWindows()` broadcast).

## repo-ref-value-object

- **Status**: dropped
- **Score**: not scored (hard-filtered)
- **Files**: many (exported types + preload + renderer consumers)
- **Modules**: `src/shared/types.ts`, `src/main/github.ts`, `src/main/pr-worktree-planner.ts`, `src/main/github-items.ts`
- **Summary**: A RepoRef value object (parse/format/equality) for owner/name pairs.
- **First seen**: 2026-09-02
- **Reason**: Published-interface change — rewrites exported shared types and the preload IPC surface; the autonomy contract bars expanding a published interface unattended beyond what the pick requires.
- **Re-checked**: 2026-09-18 — **filter still applies.** 25 declaration sites in 10 files, crossing `shared/types.ts:177-181`, `preload/index.ts:44/57/66` and `env.d.ts:58/64/69` simultaneously. Staging note for a human: `pr-worktree-planner.ts` already concentrates the `owner/name` parsing and is the natural home; `single-owner-pr-metadata` should land first.

## gh-string-error-union

- **Status**: dropped
- **Score**: not scored (hard-filtered)
- **Files**: many (pervasive convention)
- **Modules**: `src/main/github-items.ts`, `src/renderer/components/ProjectTree.tsx`
- **Summary**: Replace the `T | string` value-or-error-message channel with a typed Result.
- **First seen**: 2026-09-02
- **Reason**: Pervasive-convention migration across many files, not a single seam.
- **Re-checked**: 2026-09-18 — **filter still applies.** 25 signature sites and 10 `typeof x === 'string'` discrimination sites across 7 files. Every `Promise<T | string>` in `env.d.ts:42-71` is a de-facto wire-format commitment (the renderer discriminates by `typeof`), so it cannot be done file-by-file without compatibility shims on both sides.

## pty-entry-registration

- **Status**: proposed
- **Score**: 22/25 (leverage 4, locality 5, blast radius 1, heat 4)
- **Files**: ~3 estimated (`pty-manager.ts`, `pty-manager.test.ts`, `session-record.ts` for the name helper)
- **Modules**: `src/main/pty-manager.ts`, `src/main/session-record.ts`
- **Summary**: One `registerPtyEntry` primitive owning the four-times-repeated pty registration epilogue (entry construction, onData/onExit wiring, SSH refcount release, exit notification, `ptys.set`), plus a `tmuxSessionName` helper for the 11 open-coded `pewpew-${id}` sites.
- **First seen**: 2026-09-18
- **Evidence**: 4 epilogues at `pty-manager.ts:418-433`, `:538-555`, `:804-818`, `:847-863`. Omitting `releaseRemoteEntry` leaks an SSH refcount (only path back to `releaseHostConnection`); omitting `notifyUnexpectedExitIfPresent` breaks the dead-session detection `session-manager.ts:311-341` depends on. `reattachPty:820-832` re-implements `getScrollback`'s local branch verbatim (cf. `:762-771`) while `reattachRemotePty:865` just calls it. Three teardown paths order delete/release/kill differently (`:577-583`, `:593-599`, `:641-647`), undocumented. `ptys.set` at `:818` overwrites without destroying, leaking the prior node-pty — a hazard documented in a *different file*, `session-manager.ts:1228-1231`.
- **Test surface**: `reattachPty` and `reattachRemotePty` have **no tests at all**, and `pty-manager.test.ts`'s `fakePty()` (`:26-34`) stubs `onData`/`onExit` as no-ops so even the tested paths never exercise the wiring. Making `fakePty` capture its handlers is a self-contained first step.
- **Constraint**: the `pewpew-${id}` string form is persisted into `Session.tmuxSession` (`session-record.ts:38`) and must be produced byte-identically.

## remote-hook-merge-executor

- **Status**: proposed
- **Score**: 21/25 (leverage 4, locality 5, blast radius 1, heat 3)
- **Files**: ~3 estimated
- **Modules**: `src/main/hook-installer.ts`, new hook-merge executor
- **Summary**: Collapse the hook-merge policy — written three times in two languages across four install functions — onto one `mergeHookFile({ read, write }, newHooks)` executor over a FileStore port (local `fs`, remote `sh`), deleting both `jq` programs.
- **First seen**: 2026-09-18
- **Carries a verified bug**: `installRemoteHooks` (`hook-installer.ts:158`) pipes the prior settings file straight into `jq` with no validity pre-check, while `installRemoteCodexHooks` (`:328-329`) has an explicit `jq -e 'type == "object"'` guard — added with a comment saying it mirrors the local installer's tolerance — and local `installHooks` gets the same tolerance from `parseAsObject` (`:101-111`). A malformed `.claude/settings.local.json` in a remote worktree therefore makes `jq` exit non-zero, `set -e` aborts before the `mv`, and the remote **claude** session cannot be created; local claude and remote codex both recover silently. Nothing documents the divergence as deliberate. **A human scheduling from this entry should read it as a bug report, not only a refactor.**
- **Evidence**: TS merge loop byte-identical at `:127-137` and `:277-287`; `jq` reduce program byte-identical at `:159-164` and `:334-339`; `mergeCodexHooksFlag` re-encoded a fourth time as awk at `:465-482`.
- **Test surface**: `hook-installer.test.ts:46-63` already has an `execLocally` harness that runs the remote shell script for real against a `mkdtempSync` dir (used at `:259-273`). Writing a malformed settings file and asserting `installRemoteHooks` does not throw is **a red test available today** — the best immediate red-green in the 2026-09-18 report.

## remote-exec-result-check

- **Status**: proposed
- **Score**: 21/25 (leverage 4, locality 4, blast radius 2, heat 5)
- **Files**: ~6 estimated
- **Modules**: `src/main/remote-command.ts`, `src/main/hook-installer.ts`, `src/main/pty-manager.ts`, `src/main/host-bootstrap.ts`, `src/main/session-manager.ts`
- **Summary**: Give `expectRemoteOk` an options bag and bind it to a host as a `RemoteShell` (`{ run, expectOk }`), so the six sites that rebuilt its body only because it takes no timeout can call it, and `host-bootstrap`'s private `expectOk` copy collapses into it.
- **First seen**: 2026-09-18
- **Evidence**: the detail line `result.stderr.trim() || result.stdout.trim() || \`exit ${result.code}\`` appears at 10 non-test sites across 5 modules, always inside `if (result.timedOut || result.code !== 0)`. Existing helper at `remote-command.ts:18-24`; bypassed at `hook-installer.ts:169-172`, `:248-252`, `:344-347`, `:486-489`, `pty-manager.ts:524-527`, `session-manager.ts:864-868`; second private copy at `host-bootstrap.ts:547-557`. All five remote hook-installer functions thread `execRemote` as their first parameter, and `remote-agent-spawn.ts:26` / `pty-manager.ts:502-505` each rebuild the same binding closure.
- **Test surface**: `hook-installer.test.ts:155-167` already asserts the thrown message carries remote stderr; the detail precedence and timeout branch are assertable through existing `vi.fn` stubs.

## worktree-add-strategy

- **Status**: proposed
- **Score**: 21/25 (leverage 4, locality 4, blast radius 2, heat 5)
- **Files**: ~4 estimated
- **Modules**: `src/main/session-manager.ts`, `src/main/worktree-adoption.ts`
- **Summary**: One `addWorktree(runner, { path, branch, base })` executor owning base resolution, add-form choice (probe-first) and failure wording, replacing the three competing strategies for one operation.
- **First seen**: 2026-09-18
- **Evidence**: `worktree-adoption.ts:1-3` claims to be the shared fallback "used by both the local and remote issue- and session-creation paths so those four sites can't drift" — but it covers only the `baseRef === 'origin-default'` half. The `else` half still runs try-then-fallback at `session-manager.ts:1010-1021` (local) and `:776-786` (remote), the exact pattern `createRemotePrSession:895-898` documents removing because "the fallback masked real failures … by surfacing the second attempt's misleading 'branch already exists' error". The `no-origin-remote` / `no-origin-default-branch` mapping is duplicated verbatim at `:1771-1776` and `:1826-1831` and is **absent** from `createSession`/`createRemoteSession`, which let the raw sentinel escape as an Error message.
- **Test surface**: `session-manager.test.ts:763` and `:2510` already drive these paths through injected `runGit`/`branchExists` deps; the current-HEAD branch of `createSession` needs a `child_process` mock the suite already uses elsewhere.

## adoption-gate

- **Status**: proposed
- **Score**: 21/25 (leverage 3, locality 5, blast radius 1, heat 5)
- **Files**: ~3 estimated
- **Modules**: `src/main/session-manager.ts`
- **Summary**: A `runExclusiveAdoption({ key, tool, findExisting, adopt })` primitive owning the mixed-tool policy, the in-flight map lifecycle and the `finally` cleanup that `createSessionForWorktree` and `createRemoteSessionForWorktree` hand-sync.
- **First seen**: 2026-09-18
- **Evidence**: `session-manager.ts:413-442` and `:603-637` are structurally identical prologues; the mixed-tool rejection message is duplicated verbatim at `:430-432` and `:622-624`. The two `Map<string, InflightAdoption>` at `:411` and `:598` differ only in key shape (`canonicalPath(worktreePath)` vs `` `${hostId} ${worktreePath}` ``); the comment at `:598-601` says "Mirrors `inflightAdoptions` (local)."
- **Test surface**: `session-manager.test.ts:494`, `:613`, `:680` already exercise both gates, and `mirrorAllWorktrees` accepts an injected `adopt` dep (`MirrorAllDeps`, `:555-557`).

## session-op-ipc

- **Status**: dropped
- **Score**: 22/25 (leverage 4, locality 5, blast radius 1, heat 4) — scored, then hard-filtered
- **Files**: ~3 estimated
- **Modules**: `src/main/index.ts`, new session-IPC registrar
- **Summary**: `registerSessionOp` / `registerSessionBatchOp` registrars owning the "single-session handlers log and re-throw, batch handlers swallow per-session errors" policy that is currently a comment enforced eight times by hand.
- **First seen**: 2026-09-18
- **Reason**: **Not pinnable before the change.** The handlers register inside the `app.whenReady()` closure and `src/main/index.ts` has no test file at all, so no characterization test can be written first — the "no way to pin current behaviour" hard filter. The extraction is itself the testability unlock, which makes it a strong candidate for a human; it is simply not implementable under a test-first unattended run. Recorded with its score so a future firing sees the filter instead of re-deriving the candidate and discovering the problem mid-implementation. **Reversible**: extracting any testable seam from `index.ts` first would clear it.
- **Evidence**: five single-session handlers character-for-character identical but for a verb and a function (`index.ts:522-530`, `:531-539`, `:540-548`, `:549-557`, `:562-570`); three batch handlers identical but for the swallow (`:571-582`, `:583-594`, `:595-606`). Policy stated in a comment at `:516-520`. `sessions:remove-worktree` at `:558-561` sits in the middle of the block and follows neither — no try, no log. `session-manager.ts:1317-1325` is a third copy of the batch shape.

## remote-session-context

- **Status**: dropped
- **Score**: not scored (hard-filtered)
- **Files**: ~3 estimated
- **Modules**: `src/main/session-manager.ts`, `src/main/remote-agent-spawn.ts`
- **Summary**: A remote session context bundling `withPreparedHost` + `agentPaths[tool]` + the "not installed on host" check.
- **First seen**: 2026-09-18
- **Reason**: Leverage 1 — `remote-agent-spawn.ts:52-56` documents the throw-vs-return-string split as deliberate and published, so the proposed seam would unify two things the code says should stay apart.
- **Residue worth a follow-up**: `host.label || host.alias` is open-coded at 8 sites (`session-manager.ts` ×5, `remote-host-runtime.ts:73`, `:137`, `github-items.ts:125`) while `host-connection.ts:79` has a `hostLabel()` helper with **different** semantics — `getHost(host.hostId)?.label ?? host.alias`, which re-reads the registry so a renamed host shows its new label, and uses `??` not `||`. Two label semantics, one helper, seven bypasses.

## local-agent-respawn

- **Status**: dropped
- **Score**: not scored (hard-filtered)
- **Files**: ~2 estimated
- **Modules**: `src/main/session-manager.ts`
- **Summary**: Collapse the near-identical bodies of `reviveSession` and `attachLocalSession`.
- **First seen**: 2026-09-18
- **Reason**: Leverage 1 — the one behavioural difference (swallow vs propagate a hook-install failure) is documented at `session-manager.ts:1290-1297`, and the remote half is already covered by the landed `spawn-remote-agent-pipeline`. Complexity would move, not concentrate.

## preload-subscribe

- **Status**: dropped
- **Score**: not scored (hard-filtered)
- **Files**: ~2 estimated
- **Modules**: `src/preload/index.ts`, `src/renderer/env.d.ts`
- **Summary**: One subscribe helper for the seven identical `on<X>` wrappers.
- **First seen**: 2026-09-18
- **Reason**: Leverage 2 — it does concentrate the `removeListener` contract (a leak if forgotten), but there is almost no behaviour behind the interface, so complexity mostly moves. It also touches the published `window.api` shape consumed by the renderer and typed in `env.d.ts`, which none of the ranked candidates do. No test file exists for preload.

## renderer-error-message

- **Status**: dropped
- **Score**: not scored (hard-filtered)
- **Files**: ~5 estimated
- **Modules**: `src/renderer/stores/projects.ts`, `src/renderer/stores/hosts.ts`
- **Summary**: A single `errorMessage(e)` owner for the verbatim copies plus three ad-hoc inlines.
- **First seen**: 2026-09-18
- **Reason**: Leverage 1 — four lines, duplicated at `projects.ts:32-36` and `hosts.ts:27-31` with inlines at `review.ts:204`, `ProjectTree.tsx:330`, `origin-base.ts:43`. Complexity just moves.

## project-tree-stale-tokens

- **Status**: dropped
- **Score**: not scored (hard-filtered)
- **Files**: ~1 estimated
- **Modules**: `src/renderer/components/ProjectTree.tsx`
- **Summary**: One owner for the four stale-reply guard sequences over two refs.
- **First seen**: 2026-09-18
- **Reason**: Leverage 2 — contained to a single file and mostly moves. Worth recording: there is a real semantic split at `ProjectTree.tsx:207-220`, `:398-406`, `:428-448`, `:499-519` — three sites claim latest via `(ref.current += 1)`, but `handleSubmitIssues:499` only *reads* `ref.current`. Adjacent to `create-broadcast-setting-store`; if that factory lands, re-check whether this becomes worth proposing.

## Run log

### Run 2026-09-18 — complete

- **Outcome**: complete
- **Stopped at**: step 6 — PR opened
- **Branch**: `sym/pewpew/routine/refactor-audit/01M2RSMHCX`, **adopted** (all four conditions held: non-default; 0 commits ahead of `origin/main`; no upstream; unpublished on origin). Not renamed — an adopted branch keeps the caller's name so the harness can find the PR. Slug for this run: `session-store`.
- **Committed**: report, reconciled backlog, `session-store.ts` + its test, `session-manager.ts` / `remote-reconnect.ts` delegation
- **Evidence**: PR #320; gate green as separate commands — tsc, eslint, vitest 912/912 (under `TMPDIR=/tmp`, up from 883), build. 3 files against a 5-file estimate; `session-manager.test.ts` needed zero edits, which was the agreed bail-out gate.
- **Next**: review/merge the `session-store` PR. Next firing's top surviving candidate is `pty-entry-registration` (22/25) — a different file from the last three firings' target, so it does not queue behind this one. `remote-hook-merge-executor` (21/25) carries a verified user-facing bug and has a red test available today; a human may want to schedule it ahead of the ranking.

### Standing observation — the pure-module cluster

Recorded 2026-09-18. Not a candidate; the friction most felt while reading. `session-manager.ts` imports **13** plan/derive modules (`worktree-plan.ts` is 15 lines; `branch-ref.ts` 21; `session-fields.ts` 54 lines with a 128-line test; `probe-transition.ts` 65/127). Reading `restoreSessions` alone means bouncing through five files. The deletion test says *just moves* for any individual one, so none is separately actionable — but the pattern is precisely "pure functions extracted for testability while the real bugs hide in how they are called": the **decisions** got extracted and tested; the **IO sequencing around the decisions** stayed in `session-manager.ts`, untested, and drifted. `session-store` is the first candidate to address the sequencing rather than the decisions; `pty-entry-registration`, `remote-hook-merge-executor` and `worktree-add-strategy` are the same shape.
