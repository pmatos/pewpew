# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

pewpew is a desktop GUI (Electron + TypeScript + React) for launching, monitoring, and visualizing Claude Code sessions with embedded terminals across git projects. See @PLAN.md for full architecture and implementation phases.

## Stack

- **Runtime:** Electron (main + renderer + preload)
- **Language:** TypeScript (strict)
- **Frontend:** React + Zustand for state management
- **Build:** electron-vite (Vite for renderer, tsc for main/preload)
- **Test:** Vitest
- **Lint:** ESLint
- **Format:** Prettier

## Commands

- `npm run dev` — start in development mode (hot-reload)
- `npm run dev:debug` — build + launch with CDP on port 9229 (for MCP testing)
- `npm run build` — production build
- `npx tsc --noEmit` — type-check without emitting
- `npx eslint .` — lint
- `npx prettier --write .` — format all files
- `npx vitest run` — run tests
- `npx vitest run <path>` — run a single test file

## Testing with Chrome DevTools Protocol

`npm run dev:debug` builds and launches the app with `--remote-debugging-port=9229`, exposing a CDP endpoint at `http://127.0.0.1:9229`.

A committed `.mcp.json` wires the [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) server to that endpoint, so Claude Code gets first-class browser tools (`take_screenshot`, `click`, `evaluate_script`, `list_pages`, …) instead of hand-rolled CDP scripts.

Workflow:

1. Start the debug build and leave it running: `npm run dev:debug`.
2. Drive the renderer through the `chrome-devtools` MCP tools — screenshot the canvas, query/inspect the DOM, click session cards — and verify visual changes yourself rather than asking the user to test manually.

The committed config targets port 9229. If that conflicts with pewpew's own tmux server, launch on another port and update the `--browserUrl` arg in `.mcp.json` to match:

```bash
npx electron-vite build && npx electron --remote-debugging-port=9333 .
```

When debugging visual issues, **always drive the running app yourself first**: build, launch with CDP, screenshot at key moments, and confirm the fix.

## Code Style

- Comments sparingly — only on complex logic
- Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`
- Prefer editing existing files over creating new ones

## Supported agents

- **Claude Code** (`claude`) — default. Uses `--continue` to resume. Hooks installed at `<worktree>/.claude/settings.local.json`.
- **OpenAI Codex** (`codex`) — opt-in per session. Resume uses `codex resume <session_id>` (the `agentSessionId` is captured from the `SessionStart` hook payload). Hooks installed at `<worktree>/.codex/hooks.json` and gated behind `[features].codex_hooks = true` in `~/.codex/config.toml`, which pewpew enables idempotently on first codex session install.

The default tool is configurable via `defaultTool` in `~/.config/pewpew/config.json`. Per-session selection is exposed in the "New session" dialog. Both `claude` and `codex` must be in `PATH` (locally and on every remote host where the corresponding tool is selected).

## Implementation

The project follows PLAN.md (v2). Terminals are embedded via xterm.js + node-pty + tmux (no external windows). Sessions persist across app restarts.

## Architecture (summary)

Three-process Electron structure:

- `src/main/` — Electron main process (pty-manager, session manager, hook server, project scanner)
- `src/preload/` — secure IPC bridge (contextBridge)
- `src/renderer/` — React frontend (sidebar, canvas with xterm.js thumbnails, detail pane, status bar)
- `src/shared/` — shared TypeScript types

Terminal stack: xterm.js (renderer) + node-pty (main) + tmux (persistence).

User data stored in `~/.config/pewpew/` (config, sessions, IPC socket, hooks).
