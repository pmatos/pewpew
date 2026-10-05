import { useEffect, useId, useRef, useState } from 'react'
import type { AgentTool, OpenSessionsSummary, RepoChoices, WorktreeBase } from '../../shared/types'
import { parseIssueSpec, parsePrSpec, type SpecNoun } from '../utils/pr-spec-parser'
import { SessionOptionsFields, useSessionOptions } from './SessionOptionsFields'

export type SessionDialogKind = 'session' | 'pr' | 'issue' | 'open-all-prs' | 'open-all-issues'

export interface SessionDialogDefaults {
  tool: AgentTool
  skipPermissions: boolean
  baseFromOrigin: boolean
}

const FALLBACK_TOOL: AgentTool = 'claude'

export async function resolveSessionDialogDefaults(
  api: {
    getDefaultTool: () => Promise<AgentTool>
    getDefaultSkipPermissions: () => Promise<boolean>
    getWorktreeBase: () => Promise<WorktreeBase>
  },
  kind: SessionDialogKind
): Promise<SessionDialogDefaults> {
  // Only the new-session dialog branches a worktree, so only it needs the base.
  const [tool, skipPermissions, worktreeBase] = await Promise.all([
    api.getDefaultTool().catch(() => FALLBACK_TOOL),
    api.getDefaultSkipPermissions().catch(() => false),
    kind === 'session' ? api.getWorktreeBase().catch(() => 'local' as const) : 'local',
  ])
  return { tool, skipPermissions, baseFromOrigin: worktreeBase === 'origin-default' }
}

interface SessionDialogProps {
  kind: SessionDialogKind
  path: string
  hostId: string | null
  defaults: SessionDialogDefaults
  confirmThreshold: number
  onClose: () => void
  onToast: (msg: string) => void
  onBusyChange: (busy: boolean) => void
}

type DialogProps = Omit<SessionDialogProps, 'kind'>

export function SessionDialog({ kind, ...props }: SessionDialogProps) {
  switch (kind) {
    case 'session':
      return <NewSessionDialog {...props} />
    case 'pr':
      return <NumberedSessionDialog {...props} noun="PR" />
    case 'issue':
      return <NumberedSessionDialog {...props} noun="issue" />
    case 'open-all-prs':
      return <OpenAllPrsDialog {...props} />
    case 'open-all-issues':
      return <OpenAllIssuesDialog {...props} />
  }
}

function describeCreateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('no-origin-remote')) return 'This project has no origin remote.'
  if (message.includes('no-origin-default-branch')) {
    return "Could not determine origin's default branch."
  }
  return message.replace(/^Error:\s*/, '') || 'Failed to create session.'
}

function formatSpecSummary(result: OpenSessionsSummary, noun: SpecNoun, empty?: string): string {
  const parts: string[] = []
  if (result.created.length > 0) {
    parts.push(
      `Opened ${result.created.length} ${noun} session${result.created.length === 1 ? '' : 's'}`
    )
  }
  if (result.reused.length > 0) parts.push(`linked ${result.reused.length} existing`)
  if (result.skipped.length > 0) parts.push(`skipped ${result.skipped.length}`)
  if (result.failed.length > 0) parts.push(`${result.failed.length} failed`)
  return parts.length > 0 ? parts.join(', ') : (empty ?? `No ${noun} sessions created`)
}

function formatSpecFailures(result: OpenSessionsSummary): string[] {
  return result.failed.map((f) => `#${f.number}: ${f.error}`)
}

function formatSpecErrors(result: OpenSessionsSummary, noun: SpecNoun): string {
  return [`No ${noun} sessions opened.`, ...formatSpecFailures(result)].join('\n')
}

function formatOpenAllSummary(result: OpenSessionsSummary, noun: SpecNoun): string {
  return formatSpecSummary(result, noun, `No open ${noun === 'PR' ? 'PRs' : 'issues'} to open`)
}

// A parent repo is only detected when origin is a fork. Until the lookup
// resolves (`ready`), submit stays disabled so a fast confirmation can't bypass
// the repository choice.
function useRepoChoices(path: string, hostId: string | null, enabled: boolean) {
  const [choices, setChoices] = useState<RepoChoices | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [ready, setReady] = useState(!enabled)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    window.api
      .getRepoChoices(path, hostId)
      .then((result) => {
        if (cancelled) return
        if (typeof result !== 'string') {
          setChoices(result)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [path, hostId, enabled])

  const selected = picked ?? choices?.current ?? ''
  // Only an explicit non-origin pick (the fork's upstream) is an override;
  // undefined means the default origin behavior.
  const override = choices && selected !== choices.current ? selected : undefined
  return { choices, selected, setSelected: setPicked, override, ready }
}

function RepoPicker({
  choices,
  value,
  disabled,
  onChange,
}: {
  choices: RepoChoices | null
  value: string
  disabled: boolean
  onChange: (repo: string) => void
}) {
  if (!choices?.parent) return null
  return (
    <>
      <div className="session-name-label">Repository:</div>
      <select
        className="create-input"
        aria-label="Repository"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value={choices.current}>{choices.current} (this repo)</option>
        <option value={choices.parent}>{choices.parent} (upstream)</option>
      </select>
    </>
  )
}

function DialogActions({
  primaryLabel,
  busy,
  blocked = false,
  onPrimary,
  onCancel,
}: {
  primaryLabel: string
  busy: boolean
  blocked?: boolean
  onPrimary: () => void
  onCancel: () => void
}) {
  return (
    <div className="create-actions">
      <button type="button" className="create-btn" onClick={onPrimary} disabled={busy || blocked}>
        {primaryLabel}
      </button>
      <button type="button" className="create-btn cancel" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </div>
  )
}

function useBusy(onBusyChange: (busy: boolean) => void) {
  const [busy, setBusy] = useState(false)
  const update = (next: boolean) => {
    setBusy(next)
    onBusyChange(next)
  }
  return [busy, update] as const
}

function NewSessionDialog({ path, hostId, defaults, onClose, onBusyChange }: DialogProps) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const options = useSessionOptions(defaults.tool, defaults.skipPermissions)
  const [name, setName] = useState('')
  const [baseFromOrigin, setBaseFromOrigin] = useState(defaults.baseFromOrigin)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useBusy(onBusyChange)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async () => {
    if (creating) return
    setCreating(true)
    setError(null)
    try {
      await window.api.createSession(path, name.trim() || undefined, hostId, {
        ...options.toCreateOptions(),
        baseRef: baseFromOrigin ? 'origin-default' : 'local',
      })
      onClose()
    } catch (err) {
      setError(describeCreateError(err))
      setCreating(false)
    }
  }

  return (
    <div className="session-name-dialog">
      <label className="session-name-label" htmlFor={inputId}>
        Session name (optional):
      </label>
      <input
        id={inputId}
        ref={inputRef}
        type="text"
        className="create-input"
        placeholder="Leave empty for auto-name…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape' && !creating) onClose()
        }}
      />
      <SessionOptionsFields options={options} />
      <label className="session-base-checkbox">
        <input
          type="checkbox"
          checked={baseFromOrigin}
          onChange={(e) => {
            setBaseFromOrigin(e.target.checked)
            setError(null)
          }}
        />
        <span>Branch from origin/&lt;default&gt;</span>
      </label>
      {error && <div className="pr-error">{error}</div>}
      <DialogActions
        primaryLabel={creating ? 'Creating…' : 'Create'}
        busy={creating}
        onPrimary={() => void submit()}
        onCancel={onClose}
      />
    </div>
  )
}

function NumberedSessionDialog({
  noun,
  path,
  hostId,
  defaults,
  confirmThreshold,
  onClose,
  onToast,
  onBusyChange,
}: DialogProps & { noun: SpecNoun }) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const options = useSessionOptions(defaults.tool, defaults.skipPermissions)
  const repo = useRepoChoices(path, hostId, noun === 'PR')
  const [spec, setSpec] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmCount, setConfirmCount] = useState<number | null>(null)
  const [creating, setCreating] = useBusy(onBusyChange)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async () => {
    if (creating || !repo.ready) return
    const parsed = noun === 'PR' ? parsePrSpec(spec) : parseIssueSpec(spec)
    if ('error' in parsed) {
      setError(parsed.error)
      setConfirmCount(null)
      return
    }
    if (confirmCount === null && parsed.numbers.length > confirmThreshold) {
      setConfirmCount(parsed.numbers.length)
      setError(null)
      return
    }
    setCreating(true)
    setError(null)
    setConfirmCount(null)
    try {
      const createOptions = { ...options.toCreateOptions(), repo: repo.override }
      const result =
        noun === 'PR'
          ? await window.api.createPrSessions(path, parsed.numbers, hostId, createOptions)
          : await window.api.createIssueSessions(path, parsed.numbers, hostId, createOptions)
      if (typeof result === 'string') {
        setError(result)
        return
      }
      const opened = result.created.length + result.reused.length
      if (parsed.numbers.length === 1) {
        if (result.failed.length === 1) {
          setError(result.failed[0].error)
          return
        }
        if (result.skipped.length === 1) {
          setError(`${noun} #${result.skipped[0]} already has a session.`)
          return
        }
      } else if (opened === 0) {
        setError(formatSpecErrors(result, noun))
        return
      } else if (result.failed.length > 0) {
        setSpec(result.failed.map((f) => f.number).join(', '))
        setError([formatSpecSummary(result, noun), ...formatSpecFailures(result)].join('\n'))
        return
      } else {
        onToast(formatSpecSummary(result, noun))
      }
      onClose()
    } catch (err) {
      setError(describeCreateError(err))
    } finally {
      setCreating(false)
    }
  }

  const submitLabel = creating
    ? 'Creating…'
    : confirmCount !== null
      ? `Open ${confirmCount}`
      : 'Create'

  return (
    <div className="session-name-dialog">
      <RepoPicker
        choices={repo.choices}
        value={repo.selected}
        disabled={creating}
        onChange={repo.setSelected}
      />
      <label className="session-name-label" htmlFor={inputId}>
        {noun} number(s):
      </label>
      <input
        id={inputId}
        ref={inputRef}
        type="text"
        className="create-input"
        placeholder="e.g. 42 or 1,2,22-28"
        value={spec}
        onChange={(e) => {
          setSpec(e.target.value)
          setConfirmCount(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape' && !creating) onClose()
        }}
      />
      <SessionOptionsFields options={options} />
      {error && <div className="pr-error">{error}</div>}
      {confirmCount !== null && (
        <div className="pr-error">
          This will open {confirmCount} {noun} sessions. Click again to confirm.
        </div>
      )}
      <DialogActions
        primaryLabel={submitLabel}
        busy={creating}
        blocked={!repo.ready}
        onPrimary={() => void submit()}
        onCancel={onClose}
      />
    </div>
  )
}

function OpenAllPrsDialog({ path, hostId, defaults, onClose, onToast, onBusyChange }: DialogProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const options = useSessionOptions(defaults.tool, defaults.skipPermissions)
  const repo = useRepoChoices(path, hostId, true)
  const [creating, setCreating] = useBusy(onBusyChange)

  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: 'nearest' })
  }, [])

  const submit = async () => {
    if (creating || !repo.ready) return
    setCreating(true)
    try {
      const result = await window.api.openSessionsForOpenPrs(path, hostId, {
        ...options.toCreateOptions(),
        repo: repo.override,
      })
      onToast(typeof result === 'string' ? result : formatOpenAllSummary(result, 'PR'))
    } catch (err) {
      onToast(`Failed to open PR sessions: ${String(err)}`)
    }
    onClose()
  }

  return (
    <div ref={rootRef} className="session-name-dialog">
      <RepoPicker
        choices={repo.choices}
        value={repo.selected}
        disabled={creating}
        onChange={repo.setSelected}
      />
      <SessionOptionsFields options={options} />
      <DialogActions
        primaryLabel={creating ? 'Opening…' : 'Open all open PRs'}
        busy={creating}
        blocked={!repo.ready}
        onPrimary={() => void submit()}
        onCancel={onClose}
      />
    </div>
  )
}

// Labels are keyed by the repo they were fetched for, so a pick of a different
// repo reads as "loading" until its own response lands.
function useIssueLabels(path: string, hostId: string | null, repoKey: string) {
  const [result, setResult] = useState<{
    repo: string
    labels: string[]
    error: string | null
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .listRepoLabels(path, hostId, repoKey || null)
      .then((labels) => {
        if (cancelled) return
        setResult(
          typeof labels === 'string'
            ? { repo: repoKey, labels: [], error: labels }
            : { repo: repoKey, labels, error: null }
        )
      })
      .catch((err) => {
        if (!cancelled) setResult({ repo: repoKey, labels: [], error: String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [path, hostId, repoKey])

  const current = result?.repo === repoKey ? result : null
  return { labels: current?.labels ?? null, error: current?.error ?? null }
}

function LabelFilter({
  labels,
  error,
  value,
  disabled,
  onChange,
}: {
  labels: string[] | null
  error: string | null
  value: string
  disabled: boolean
  onChange: (label: string) => void
}) {
  const selectId = useId()
  return (
    <>
      <label className="session-name-label" htmlFor={selectId}>
        Label filter:
      </label>
      {labels === null ? (
        <div className="session-name-label">Loading labels…</div>
      ) : (
        <select
          id={selectId}
          className="create-input"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">All open issues</option>
          {labels.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      )}
      {error && <div className="pr-error">Could not load labels: {error}</div>}
    </>
  )
}

function OpenAllIssuesDialog({
  path,
  hostId,
  defaults,
  confirmThreshold,
  onClose,
  onToast,
  onBusyChange,
}: DialogProps) {
  const options = useSessionOptions(defaults.tool, defaults.skipPermissions)
  const repo = useRepoChoices(path, hostId, true)
  const [label, setLabel] = useState('')
  const [confirmCount, setConfirmCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useBusy(onBusyChange)
  const { labels, error: labelsError } = useIssueLabels(path, hostId, repo.override ?? '')
  // Bumped on unmount so a count that resolves after the dialog was cancelled
  // is discarded instead of opening sessions for a dismissed dialog.
  const requestRef = useRef(0)

  useEffect(
    () => () => {
      requestRef.current += 1
    },
    []
  )

  const openAll = async () => {
    if (creating) return
    setCreating(true)
    setError(null)
    try {
      const result = await window.api.openSessionsForOpenIssues(path, hostId, label || null, {
        ...options.toCreateOptions(),
        repo: repo.override,
      })
      onToast(typeof result === 'string' ? result : formatOpenAllSummary(result, 'issue'))
      onClose()
    } catch (err) {
      setError(`Failed to open issue sessions: ${String(err)}`)
      setCreating(false)
    }
  }

  const submit = async () => {
    if (creating || !repo.ready) return
    const token = requestRef.current
    setCreating(true)
    setError(null)
    let count: number | string
    try {
      count = await window.api.countOpenIssues(path, hostId, label || null, repo.override ?? null)
    } catch (err) {
      if (requestRef.current === token) {
        setError(`Failed to count open issues: ${String(err)}`)
      }
      setCreating(false)
      return
    }
    setCreating(false)
    if (requestRef.current !== token) return
    if (typeof count === 'string') {
      setError(count)
      return
    }
    if (count === 0) {
      onToast(label ? `No open issues match "${label}"` : 'No open issues to open')
      onClose()
      return
    }
    if (count > confirmThreshold) {
      setConfirmCount(count)
      return
    }
    await openAll()
  }

  if (confirmCount !== null) {
    return (
      <div className="session-name-dialog">
        <div className="session-name-label">
          This will open up to {confirmCount} issue session{confirmCount === 1 ? '' : 's'}
          {label ? ` labelled "${label}"` : ''}. Continue?
        </div>
        {error && <div className="pr-error">{error}</div>}
        <DialogActions
          primaryLabel={creating ? 'Opening…' : `Open ${confirmCount}`}
          busy={creating}
          onPrimary={() => void openAll()}
          onCancel={onClose}
        />
      </div>
    )
  }

  return (
    <div className="session-name-dialog">
      <RepoPicker
        choices={repo.choices}
        value={repo.selected}
        disabled={creating}
        onChange={(value) => {
          repo.setSelected(value)
          setLabel('')
        }}
      />
      <LabelFilter
        labels={labels}
        error={labelsError}
        value={label}
        disabled={creating}
        onChange={setLabel}
      />
      <SessionOptionsFields options={options} />
      {error && <div className="pr-error">{error}</div>}
      <DialogActions
        primaryLabel={creating ? 'Working…' : 'Open sessions'}
        busy={creating}
        blocked={labels === null || !repo.ready}
        onPrimary={() => void submit()}
        onCancel={onClose}
      />
    </div>
  )
}
