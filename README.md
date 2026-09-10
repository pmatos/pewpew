# pewpew

[![CI](https://github.com/pmatos/pewpew/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/pmatos/pewpew/actions/workflows/ci.yml)
[![CodeQL](https://github.com/pmatos/pewpew/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/pmatos/pewpew/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/pmatos/pewpew/branch/main/graph/badge.svg)](https://codecov.io/gh/pmatos/pewpew)

A desktop GUI for launching, monitoring, and visualizing Claude Code sessions with embedded terminals across your git projects.

## What it does

- Scans your `~/dev` directory (configurable) for git repositories
- Right-click a project to set up Claude Code hooks, then launch sessions
- Each session runs Claude Code in its own git worktree + tmux session
- Embedded terminals via xterm.js — no external windows, no screen-sharing dialogs
- Zoomable canvas with session cards grouped by project in color-coded clusters
- Live terminal thumbnails, pulsing indicators for sessions needing input
- Sessions persist across app restarts (tmux keeps them alive)
- System tray icon with desktop notifications

## Requirements

- [Node.js](https://nodejs.org/) (v22.12+)
- [tmux](https://github.com/tmux/tmux)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` CLI)
- Linux (X11 or Wayland)

## Getting started

```bash
git clone https://github.com/pmatos/pewpew.git
cd pewpew
npm install
npm run rebuild-pty   # rebuild node-pty for Electron
npm run dev           # start in development mode
```

## Usage

1. Projects from `~/dev` appear in the sidebar
2. Right-click a project → **Setup for pewpew** (installs Claude Code hooks)
3. Right-click again → **New session...** (optionally name it)
4. A session card appears on the canvas with a live terminal preview
5. Click the card to open the full interactive terminal
6. Press **Escape** to return to the canvas overview
7. Sessions survive closing and reopening the app

## Configuration

Edit `~/.config/pewpew/config.json`:

```json
{
  "scanDirs": ["~/dev"],
  "uiScale": 1.2,
  "sidebarWidth": 250
}
```

- `scanDirs` — directories to scan for git repos
- `uiScale` — UI zoom factor (try `1.3` for HiDPI displays)
- `sidebarWidth` — sidebar width in pixels

## Keyboard shortcuts

| Key             | Action                  |
| --------------- | ----------------------- |
| Ctrl+N          | New project dialog      |
| Ctrl+R          | Rescan projects         |
| Ctrl+0          | Reset canvas zoom       |
| Ctrl+= / Ctrl+- | Zoom in / out           |
| Escape          | Close terminal / dialog |

## Stack

- **Electron** + **TypeScript** + **React** + **Zustand**
- **xterm.js** + **node-pty** + **tmux** for embedded persistent terminals
- **electron-vite** for build tooling

## Releasing

Linux builds are produced by the `Release` workflow. From the GitHub UI:

1. Go to **Actions → Release → Run workflow**.
2. Pick a semver bump (`patch`/`minor`/`major`) or pass an explicit `version` (e.g. `1.2.3`).
3. Optionally toggle `draft` or `prerelease`.

The job bumps `package.json`, commits + tags on `main`, builds the AppImage and
`.deb`, uploads `SHA256SUMS.txt` alongside them, and creates a GitHub Release
with auto-generated notes. Requires the workflow to be run against `main`.

## License

MIT
