import { useEffect, useReducer, useRef, useState } from 'react'
import { useHostsStore } from '../stores/hosts'
import type { Host, HostId, TestConnectionResult } from '../../shared/types'

function reasonToLabel(reason: TestConnectionResult['reason']): string {
  switch (reason) {
    case 'auth-failed':
      return 'Auth failed'
    case 'network':
      return 'Network error'
    case 'dep-missing':
      return 'Missing dep'
    default:
      return 'Failed'
  }
}

function HostTestResult({ result }: { result: TestConnectionResult }) {
  if (!result.ok) {
    return (
      <div className="host-test-result err">
        {reasonToLabel(result.reason)}
        {result.message ? `: ${result.message}` : ''}
      </div>
    )
  }

  const missing = (result.requiredDeps ?? []).filter((d) => !d.installed).map((d) => d.name)
  const headlineClass = missing.length > 0 ? 'warn' : 'ok'

  return (
    <div className={`host-test-result ${headlineClass}`}>
      <div className="host-test-headline">
        {missing.length > 0 ? `Connected — missing: ${missing.join(', ')}` : 'Connected'}
      </div>
      {result.requiredDeps && (
        <div className="host-test-deps">
          {result.requiredDeps.map((d) => (
            <span key={d.name} className={`host-dep ${d.installed ? 'ok' : 'err'}`}>
              {d.installed ? '✓' : '✗'} {d.name}
            </span>
          ))}
        </div>
      )}
      {result.agentTools && result.agentTools.length > 0 && (
        <div className="host-test-deps agents">
          <span className="host-dep-label">Agents:</span>
          {result.agentTools.map((d) => (
            <span key={d.name} className={`host-dep ${d.installed ? 'ok' : 'muted'}`}>
              {d.installed ? '✓' : '–'} {d.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

interface HostFormProps {
  initialAlias?: string
  initialLabel?: string
  submitLabel: string
  onSubmit: (alias: string, label: string) => Promise<void>
  onCancel: () => void
}

interface HostFormState {
  alias: string
  label: string
  submitting: boolean
}

type HostFormAction =
  | { type: 'alias'; value: string }
  | { type: 'label'; value: string }
  | { type: 'submitting'; value: boolean }

function hostFormReducer(state: HostFormState, action: HostFormAction): HostFormState {
  switch (action.type) {
    case 'alias':
      return { ...state, alias: action.value }
    case 'label':
      return { ...state, label: action.value }
    case 'submitting':
      return { ...state, submitting: action.value }
  }
}

function HostForm({
  initialAlias = '',
  initialLabel = '',
  submitLabel,
  onSubmit,
  onCancel,
}: HostFormProps) {
  const [form, dispatch] = useReducer(hostFormReducer, {
    alias: initialAlias,
    label: initialLabel,
    submitting: false,
  })
  const aliasInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    aliasInputRef.current?.focus()
  }, [])

  const canSubmit = form.alias.trim().length > 0 && form.label.trim().length > 0 && !form.submitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    dispatch({ type: 'submitting', value: true })
    try {
      await onSubmit(form.alias.trim(), form.label.trim())
    } catch {
      // Error shown via store.error; keep the form open so the user can retry.
    } finally {
      dispatch({ type: 'submitting', value: false })
    }
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleSubmit()
    } else if (e.key === 'Escape') {
      onCancel()
    }
  }

  return (
    <div className="hosts-form">
      <input
        ref={aliasInputRef}
        type="text"
        className="create-input"
        placeholder="Host from ~/.ssh/config (e.g. devbox)"
        value={form.alias}
        onChange={(e) => dispatch({ type: 'alias', value: e.target.value })}
        onKeyDown={handleKey}
      />
      <input
        type="text"
        className="create-input"
        placeholder="Short label (e.g. Dev box)"
        value={form.label}
        onChange={(e) => dispatch({ type: 'label', value: e.target.value })}
        onKeyDown={handleKey}
      />
      <div className="create-actions">
        <button className="create-btn" disabled={!canSubmit} onClick={handleSubmit}>
          {submitLabel}
        </button>
        <button className="create-btn cancel" onClick={onCancel} disabled={form.submitting}>
          Cancel
        </button>
      </div>
    </div>
  )
}

interface HostDeleteConfirmProps {
  host: Host
  onConfirm: () => Promise<void> | void
  onCancel: () => void
}

function HostDeleteConfirm({ host, onConfirm, onCancel }: HostDeleteConfirmProps) {
  const [submitting, setSubmitting] = useState(false)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirmButtonRef.current?.focus()
  }, [])

  // `submitting` only meaningfully blocks a re-click while we await the async
  // delete; without `await onConfirm()` the lock would clear synchronously,
  // letting a fast double-click fire two IPC deletes (the second would surface
  // a spurious "Unknown host" after the first succeeded).
  const handleConfirm = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      await onConfirm()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="hosts-form hosts-delete-confirm"
      role="group"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
    >
      <div className="hosts-delete-confirm-body">
        Forget <strong>{host.label}</strong> ({host.alias})? pewpew will mark its sessions dead,
        close its SSH connection, and remove it from your registry.{' '}
        <strong>
          Remote tmux sessions, worktrees, and ~/.config/pewpew/ on the host are not touched.
        </strong>
      </div>
      <div className="create-actions">
        <button
          ref={confirmButtonRef}
          className="create-btn cancel"
          disabled={submitting}
          onClick={handleConfirm}
        >
          Forget host
        </button>
        <button className="create-btn" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </div>
  )
}

interface HostRowProps {
  host: Host
  testing: boolean
  result?: TestConnectionResult
  onTest: () => void
  onEdit: () => void
  onDelete: () => void
}

function HostRow({ host, testing, result, onTest, onEdit, onDelete }: HostRowProps) {
  return (
    <div className="hosts-row">
      <div className="hosts-row-main">
        <div className="host-label">{host.label}</div>
        <div className="host-alias">{host.alias}</div>
        {result && <HostTestResult result={result} />}
      </div>
      <div className="host-actions">
        <button className="create-btn" onClick={onTest} disabled={testing}>
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button className="create-btn" onClick={onEdit}>
          Edit
        </button>
        <button className="create-btn cancel" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  )
}

export default function ManageHostsDialog() {
  const dialogOpen = useHostsStore((s) => s.dialogOpen)
  const hosts = useHostsStore((s) => s.hosts)
  const editingHostId = useHostsStore((s) => s.editingHostId)
  const addingNew = useHostsStore((s) => s.addingNew)
  const testing = useHostsStore((s) => s.testing)
  const testResults = useHostsStore((s) => s.testResults)
  const error = useHostsStore((s) => s.error)
  const closeDialog = useHostsStore((s) => s.closeDialog)
  const startEdit = useHostsStore((s) => s.startEdit)
  const startAdd = useHostsStore((s) => s.startAdd)
  const cancelEdit = useHostsStore((s) => s.cancelEdit)
  const addHost = useHostsStore((s) => s.addHost)
  const updateHost = useHostsStore((s) => s.updateHost)
  const deleteHost = useHostsStore((s) => s.deleteHost)
  const testHost = useHostsStore((s) => s.testHost)
  const [confirmingDeleteHostId, setConfirmingDeleteHostId] = useState<HostId | null>(null)

  useEffect(() => {
    if (!dialogOpen) return
    // App.tsx's global Escape handler respects useHostsStore.dialogOpen and
    // returns early while this modal is open, so a plain bubble-phase listener
    // is enough.
    //
    // We guard on the DOM event target rather than store state: the form's
    // React onKeyDown handler fires before this native listener and calls
    // cancelEdit synchronously, so by the time we'd check store state it
    // would already be cleared. `target.closest('.hosts-form')` is stable
    // across that race — if Escape originated inside a form, the form owns
    // it; otherwise we close the dialog.
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const target = e.target as HTMLElement | null
      if (target && target.closest('.hosts-form')) return
      closeDialog()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [dialogOpen, closeDialog])

  if (!dialogOpen) return null

  const editingHost = editingHostId ? hosts.find((h) => h.hostId === editingHostId) : undefined

  const handleConfirmDelete = async (hostId: HostId) => {
    await deleteHost(hostId)
    setConfirmingDeleteHostId(null)
  }

  return (
    <div
      className="hosts-dialog-overlay"
      role="presentation"
      onClick={closeDialog}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="hosts-dialog" role="presentation" onClick={(e) => e.stopPropagation()}>
        <div className="hosts-dialog-header">
          <div className="session-name-label">Manage hosts</div>
          <button className="create-btn cancel" onClick={closeDialog}>
            Close
          </button>
        </div>

        {error && <div className="hosts-error">{error}</div>}

        <div className="hosts-list">
          {hosts.length === 0 && !addingNew && (
            <div className="hosts-empty">No hosts yet. Add one to get started.</div>
          )}
          {hosts.map((host) =>
            editingHostId === host.hostId ? (
              <HostForm
                key={host.hostId}
                initialAlias={host.alias}
                initialLabel={host.label}
                submitLabel="Save"
                onSubmit={(alias, label) => updateHost(host.hostId, alias, label)}
                onCancel={cancelEdit}
              />
            ) : confirmingDeleteHostId === host.hostId ? (
              <HostDeleteConfirm
                key={host.hostId}
                host={host}
                onConfirm={() => handleConfirmDelete(host.hostId)}
                onCancel={() => setConfirmingDeleteHostId(null)}
              />
            ) : (
              <HostRow
                key={host.hostId}
                host={host}
                testing={Boolean(testing[host.hostId])}
                result={testResults[host.hostId]}
                onTest={() => void testHost(host.hostId)}
                onEdit={() => startEdit(host.hostId)}
                onDelete={() => setConfirmingDeleteHostId(host.hostId)}
              />
            )
          )}
        </div>

        {addingNew ? (
          <HostForm
            submitLabel="Add"
            onSubmit={(alias, label) => addHost(alias, label)}
            onCancel={cancelEdit}
          />
        ) : (
          !editingHost && (
            <div className="hosts-dialog-footer">
              <button className="create-btn" onClick={startAdd}>
                + Add host
              </button>
            </div>
          )
        )}
      </div>
    </div>
  )
}
