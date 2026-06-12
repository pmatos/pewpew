export type SessionStatus = 'running' | 'needs_input' | 'idle' | 'completed' | 'error' | 'dead'
export type ConnectionState =
  | 'connecting'
  | 'live'
  | 'offline'
  | 'pending'
  | 'auth-failed'
  | 'unreachable'

export interface LastKnownState {
  text: string
  timestamp: number
}

export interface Project {
  name: string
  path: string
  branches: string[]
  worktrees: Worktree[]
  setupState: 'unsetup' | 'ready'
  hostId: string | null
}

export interface Worktree {
  name: string
  path: string
  branch: string
  isMain: boolean
}

export type AgentTool = 'claude' | 'codex'

export type Theme = 'dark' | 'light'

export interface Session {
  id: string
  hostId: string | null
  projectPath: string
  projectName: string
  worktreeName: string
  worktreePath: string
  branch: string
  prNumber?: number
  // Set when the PR head lives in a different repository (a fork). The head
  // branch is then only reachable via GitHub's refs/pull/<n>/head, and pushes
  // from this worktree won't update the PR (origin has no such branch).
  prIsFork?: boolean
  // "owner/name" of the fork the PR head lives in, when known (display only).
  prHeadRepo?: string
  issueNumber?: number
  pid: number
  tmuxSession: string
  status: SessionStatus
  connectionState?: ConnectionState
  lastActivity: number
  hookEvents: HookEvent[]
  repoFingerprint?: string
  lastKnownState?: LastKnownState
  tool: AgentTool
  agentSessionId?: string
}

export interface OpenSessionsSummary {
  created: Session[]
  reused: Session[]
  skipped: number[]
  failed: { number: number; error: string }[]
}

export interface HookEvent {
  method: string
  sessionId: string
  timestamp: number
  originHostId?: string | null
  data: Record<string, unknown>
}

// --- Review / Diff types ---

export type LineType = 'addition' | 'deletion' | 'context'
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export interface DiffLine {
  content: string
  lineType: LineType
  oldLineNo: number | null
  newLineNo: number | null
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  oldPath: string | null
  hunks: DiffHunk[]
  status: FileStatus
}

export type DiffMode = 'uncommitted' | 'unpushed' | 'branch'

export type ReviewDecision = 'approved' | 'commented' | 'rejected'
export type RejectMode = 'propose_alternative' | 'request_possibilities'

export interface HunkAnnotation {
  id: string
  decision: ReviewDecision
  comment?: string
  rejectMode?: RejectMode
  selectedText?: string
  selectedLines?: { start: number; end: number }
}

// --- Host registry / SSH types ---

export type HostId = string

export interface Host {
  hostId: HostId
  alias: string
  label: string
  // Absolute paths to agent binaries on the remote host, populated lazily by
  // host bootstrap when first resolved. Persisting these avoids re-probing on
  // every session create AND lets us launch via absolute path so we don't
  // depend on the non-interactive ssh PATH (which excludes ~/.local/bin etc.).
  agentPaths?: Partial<Record<AgentTool, string>>
}

export type SshExitReason = 'auth-failed' | 'network' | 'dep-missing' | 'bind-unlink' | 'unknown'

export interface TestConnectionResult {
  ok: boolean
  reason?: SshExitReason
  message?: string
}

export interface RemoteProject {
  hostId: HostId
  path: string
  name: string
  repoFingerprint?: string
}

export type ValidateRemoteRepoReason =
  | 'not-a-git-repo'
  | 'auth-failed'
  | 'network'
  | 'dep-missing'
  | 'unknown'

export interface ValidateRemoteRepoResult {
  ok: boolean
  fingerprint?: string
  reason?: ValidateRemoteRepoReason
  message?: string
}

export type WorktreeBase = 'local' | 'origin-default'

export interface CreateSessionOptions {
  baseRef?: WorktreeBase
  tool?: AgentTool
}

export interface ReviewDiffResult {
  ok: boolean
  files?: DiffFile[]
  reason?: 'remote-unsupported'
}

export interface ReviewBranchesResult {
  ok: boolean
  branches?: string[]
  reason?: 'remote-unsupported'
}

export interface ReviewDefaultBranchResult {
  ok: boolean
  branch?: string
  reason?: 'remote-unsupported'
}

export type SshInvocationKind = 'control' | 'control-exit' | 'exec' | 'attach' | 'probe'

export interface SshLogEntry {
  ts: number
  hostId: HostId
  kind: SshInvocationKind
  argv: string[]
  exitCode: number | null
  stderrSnippet: string
  durationMs?: number
}

export type ToastSeverity = 'error' | 'warning' | 'info'

export interface ToastEvent {
  id: string
  severity: ToastSeverity
  title: string
  detail?: string
  hostLabel?: string
  ttlMs?: number
}
