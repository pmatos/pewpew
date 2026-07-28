# Bulk-open PR agent selection

## Goal

Let the user select Claude, Codex, or oh-my-pi before opening sessions for all
open pull requests. The selected agent applies to every newly created session in
that bulk operation.

This change is limited to the “Open sessions for all open PRs” action. Bulk issue
opening is out of scope.

## User experience

Choosing “Open sessions for all open PRs” always opens the existing compact
sidebar dialog instead of immediately starting work for non-fork repositories.
The dialog:

- preselects the configured `defaultTool`;
- presents the same Claude, Codex, and oh-my-pi radio controls used by the New
  session and New PR session dialogs;
- shows the existing repository picker when the project is a fork; and
- starts the bulk operation only after the user confirms.

Canceling the dialog creates no sessions. Existing PR sessions remain untouched
and are reported as skipped even when they use a different agent.

## Data flow

The renderer stores the pending bulk-open agent alongside the pending project
and host. Confirmation sends a `CreateSessionOptions` object through the preload
bridge and `sessions:open-all-prs` IPC handler.

`openSessionsForOpenPrs` accepts that options object, uses `options.repo` while
listing pull requests, and passes the full object to each new PR session. This
keeps repository and agent selection in one existing options type and lets the
batch scheduler use the selected agent when deciding whether creation must be
serialized.

The existing summary and error paths remain unchanged.

## TDD seams

Automated tests will cover the exported `openSessionsForOpenPrs` main-process
function, the public orchestration boundary that turns a GitHub PR list into
session-creation calls:

1. A selected agent and repository are passed to each newly created PR session.
2. Existing PR sessions are still skipped rather than replaced.

The renderer has no component-test harness. Its public Electron behavior will be
validated through the running application: open the bulk dialog for a normal
repository, verify the configured default is selected, switch among all three
agents, cancel without creating work, and confirm that the selected value
reaches the bulk-open operation. A fork repository, when available, will also be
checked for coexistence of the repository and agent pickers.

Tests will not target reducer internals, private helpers, or duplicated JSX
structure.

## Validation

Run formatting, lint, type-checking, the focused session-manager test, the full
Vitest suite, and the production build. Launch the debug build with Chrome
DevTools Protocol enabled and visually exercise the dialog before publishing.
