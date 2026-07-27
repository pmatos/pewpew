import {
  ensureHostConnection,
  exec as execRemote,
  releaseHostConnection,
  retainHostConnection,
  runtimeStateFor,
  startBootstrapWindow,
  stopHostConnection,
  type ExecResult,
  type HostConnectionState,
} from './host-connection'
import { listenHookServerForHost } from './hook-server'
import { bootstrapHost, HostBootstrapError, type AgentResolution } from './host-bootstrap'
import { setHostAgentPaths } from './host-registry'
import { emitToast } from './notifications'
import type { Host, ToastEvent } from '../shared/types'

export interface PreparedRemoteHost {
  notifyScriptPath: string
  guardScriptPath: string
  agentPaths: AgentResolution
}

export interface PreparedRemoteHostLease extends PreparedRemoteHost {
  release(): Promise<void>
}

export interface RemoteHostRuntimeDeps {
  listenHookServerForHost(hostId: string): string
  ensureHostConnection(
    host: Host,
    localSocketPath: string
  ): Promise<{ remoteSocketPath: string; controlPath: string }>
  retainHostConnection(hostId: string): void
  releaseHostConnection(hostId: string): Promise<void>
  stopHostConnection(hostId: string): Promise<void>
  runtimeStateFor(hostId: string): HostConnectionState | undefined
  startBootstrapWindow(hostId: string): () => void
  bootstrapHost(
    hostId: string,
    connection: { exec(argv: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> },
    remoteSocketPath: string,
    cachedAgentPaths: AgentResolution
  ): Promise<PreparedRemoteHost & { remoteSocketPath: string }>
  execRemote(host: Host, argv: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>
  setHostAgentPaths(hostId: string, paths: AgentResolution): void
  emitToast(event: Omit<ToastEvent, 'id'> & { id?: string }): void
}

export interface RemoteHostRuntime {
  acquirePreparedHost(host: Host): Promise<PreparedRemoteHostLease>
  withPreparedHost<T>(host: Host, fn: (prepared: PreparedRemoteHost) => Promise<T>): Promise<T>
}

function toastBootstrapError(
  host: Host,
  err: HostBootstrapError,
  emit: (event: Omit<ToastEvent, 'id'> & { id?: string }) => void
) {
  const label = host.label || host.alias
  if (err.kind === 'missing-deps' && err.missingDeps.length > 0) {
    emit({
      severity: 'error',
      title: `${label}: missing required tools`,
      detail: err.missingDeps.join(', '),
      hostLabel: label,
    })
  } else if (err.kind === 'missing-deps') {
    emit({
      severity: 'error',
      title: `${label}: bootstrap probe failed`,
      detail: err.message,
      hostLabel: label,
    })
  } else if (err.kind === 'stream-local-bind') {
    emit({
      severity: 'error',
      title: `${label}: hook socket missing`,
      detail: err.message,
      hostLabel: label,
    })
  } else {
    emit({
      severity: 'error',
      title: `${label}: failed to install hook script`,
      detail: err.message,
      hostLabel: label,
    })
  }
}

export function createRemoteHostRuntime(deps: RemoteHostRuntimeDeps): RemoteHostRuntime {
  async function prepareHost(host: Host): Promise<PreparedRemoteHost> {
    const localSocketPath = deps.listenHookServerForHost(host.hostId)
    let remoteSocketPath: string
    try {
      ;({ remoteSocketPath } = await deps.ensureHostConnection(host, localSocketPath))
    } catch (err) {
      const capturedState = deps.runtimeStateFor(host.hostId)
      await deps.stopHostConnection(host.hostId).catch(() => undefined)
      if (capturedState === 'auth-failed' || capturedState === 'unreachable') {
        const wrapped = err instanceof Error ? err : new Error(String(err))
        ;(wrapped as Error & { hostConnectionState?: HostConnectionState }).hostConnectionState =
          capturedState
        throw wrapped
      }
      throw err
    }

    deps.retainHostConnection(host.hostId)
    const endBootstrapWindow = deps.startBootstrapWindow(host.hostId)
    try {
      const bootstrap = await deps.bootstrapHost(
        host.hostId,
        {
          exec: (argv, opts) => deps.execRemote(host, argv, opts),
        },
        remoteSocketPath,
        host.agentPaths ?? {}
      )
      deps.setHostAgentPaths(host.hostId, bootstrap.agentPaths)
      return {
        notifyScriptPath: bootstrap.notifyScriptPath,
        guardScriptPath: bootstrap.guardScriptPath,
        agentPaths: bootstrap.agentPaths,
      }
    } catch (err) {
      await deps.releaseHostConnection(host.hostId).catch(() => undefined)
      if (err instanceof HostBootstrapError) {
        toastBootstrapError(host, err, deps.emitToast)
      }
      throw err
    } finally {
      endBootstrapWindow()
    }
  }

  return {
    async acquirePreparedHost(host) {
      const prepared = await prepareHost(host)
      let released = false
      return {
        ...prepared,
        async release() {
          if (released) return
          released = true
          await deps.releaseHostConnection(host.hostId).catch(() => undefined)
        },
      }
    },
    async withPreparedHost(host, fn) {
      const prepared = await this.acquirePreparedHost(host)
      try {
        return await fn(prepared)
      } finally {
        await prepared.release()
      }
    },
  }
}

export const remoteHostRuntime = createRemoteHostRuntime({
  listenHookServerForHost,
  ensureHostConnection,
  retainHostConnection,
  releaseHostConnection,
  stopHostConnection,
  runtimeStateFor,
  startBootstrapWindow,
  bootstrapHost,
  execRemote,
  setHostAgentPaths,
  emitToast,
})
