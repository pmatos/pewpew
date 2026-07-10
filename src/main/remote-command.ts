import type { Host } from '../shared/types'
import { getHost } from './host-registry'
import { exec as execRemote } from './host-connection'

// Resolve a registered host by id, or throw. Callers that already hold a hostId
// from a session/project use this to fail loudly on a stale or unknown host
// rather than silently no-op'ing.
export function getRequiredHost(hostId: string): Host {
  const host = getHost(hostId)
  if (!host) throw new Error('Unknown host')
  return host
}

// Run a command on a remote host and return its stdout, throwing a
// `${message}: <detail>` error on a timeout or non-zero exit so callers can
// surface the failure instead of misreading empty output as success.
export async function expectRemoteOk(host: Host, argv: string[], message: string): Promise<string> {
  const result = await execRemote(host, argv)
  if (result.timedOut || result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    throw new Error(`${message}: ${detail}`)
  }
  return result.stdout
}
