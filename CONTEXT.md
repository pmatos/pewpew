# CONTEXT

Domain vocabulary for pewpew. Use these words in code, comments, commits and
reviews; where a term is defined here, prefer it over a synonym.

**This glossary is seeded, not complete.** It was started by the architecture
deepening routine when the terms below became load-bearing in `pty-manager.ts`,
and it grows a term at a time as work needs one. An absent term means nobody has
needed to pin it down yet, not that the concept does not exist.

## Terminal hosting

**Session** — one agent run against one worktree, persisted across app restarts.
Carries its own `tmuxSession` name (see below) and, when remote, a `hostId`.

**tmux session name** — the durable name of the tmux session backing a Session,
spelled `pewpew-<session id>`. Produced by `tmuxSessionName` in
`src/main/pty-manager.ts`, persisted into `Session.tmuxSession`
(`src/main/session-record.ts`), and matched by `discoverTmuxSessions` when
adopting sessions left behind by a previous run. Its spelling is a compatibility
commitment: changing it orphans every live session.

**tmux socket** — which tmux _server_ a local session lives on. `pewpew` is the
dedicated server; `default` is the user's own, where sessions created before the
dedicated server existed still live. Only local sessions have one — remote hosts
always use their default server.

**Placement** — where a session's terminal lives: `local` (on a tmux socket) or
`remote` (on a `Host`, reached over SSH). Placement is the single fact a
registration site states; everything that differs between a local and a remote
pty is derived from it rather than decided again per site. Expressed as
`PtyPlacement` in `src/main/pty-manager.ts`.

**Lease** — a remote session's claim on its host's shared SSH connection, taken
by `retainHostConnection` when the pty is registered and handed back by
`releaseHostConnection` when it goes away. Exactly one per remote pty, released
exactly once, by whichever of the exit handler or a teardown path runs first. A
local session holds no lease. A lease that is never handed back keeps the host's
ControlMaster alive forever, with no error anywhere — which is why placement,
not a remembered line of code, decides whether one is taken.
