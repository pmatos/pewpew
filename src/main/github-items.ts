import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Host } from '../shared/types'
import { classifySshExit } from './ssh-exit-parser'
import { exec as execRemote } from './host-connection'
import { getRequiredHost, expectRemoteOk } from './remote-command'

// Owns the "query GitHub for open PRs, open issues, and repo labels" concern via
// the `gh` CLI, whether the project lives locally or on a remote host reached over
// SSH. Callers pass a projectPath and a hostId (null = local); the module hides the
// local-vs-remote split, the two-step `gh repo view` → `gh api` dance, the remote
// shell script, error classification, and output parsing behind a narrow interface.

const execFileAsync = promisify(execFile)

export type NumberedGhItem = { number: number }
export type ListNumberedItems = (
  projectPath: string,
  hostId: string | null
) => Promise<NumberedGhItem[] | string>

type RemoteGhProbe = { ok: true } | { ok: false; error: string }

export function describeGhError(err: unknown): string {
  const detail =
    typeof err === 'object' && err !== null && 'stderr' in err
      ? String((err as { stderr?: unknown }).stderr ?? '').trim()
      : ''
  if (detail) return detail
  if (err instanceof Error) return err.message.replace(/^Error:\s*/, '')
  return String(err)
}

export function ghApiOpenItemsArgs(kind: 'pr' | 'issue', repo: string, label?: string): string[] {
  const labelQuery = kind === 'issue' && label ? `&labels=${encodeURIComponent(label)}` : ''
  const endpoint =
    kind === 'pr'
      ? `repos/${repo}/pulls?state=open&per_page=100`
      : `repos/${repo}/issues?state=open&per_page=100${labelQuery}`
  const jq = kind === 'pr' ? '.[].number' : '.[] | select(.pull_request | not) | .number'
  return ['api', '--paginate', endpoint, '--jq', jq]
}

function parseNumberedGhLines(stdout: string, label: string): NumberedGhItem[] {
  const items: NumberedGhItem[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const number = Number(line)
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`Expected ${label} number, got ${JSON.stringify(line)}.`)
    }
    items.push({ number })
  }
  return items
}

export function parseLabelLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function describeRemoteGhProbeFailure(
  host: Host,
  result: { code: number; stderr: string; timedOut: boolean }
): string {
  const label = host.label || host.alias
  if (result.timedOut) return `Cannot reach ${label}: ssh timed out while checking for gh.`

  const { reason, message } = classifySshExit({ exitCode: result.code, stderr: result.stderr })
  if (reason === 'auth-failed') return `SSH authentication failed on ${label}: ${message}`
  if (reason === 'network') return `Cannot reach ${label}: ${message}`
  if (reason === 'bind-unlink') {
    return `${label}: remote sshd needs StreamLocalBindUnlink yes: ${message}`
  }
  if (reason === 'dep-missing') return `${label}: remote shell dependency missing: ${message}`

  return `gh CLI is not installed on host ${label}.`
}

export async function probeRemoteGh(host: Host): Promise<RemoteGhProbe> {
  const result = await execRemote(host, ['sh', '-c', 'command -v gh >/dev/null 2>&1'])
  if (result.code === 0 && !result.timedOut) return { ok: true }
  return { ok: false, error: describeRemoteGhProbeFailure(host, result) }
}

async function listLocalOpenGhItems(
  projectPath: string,
  kind: 'pr' | 'issue',
  label?: string
): Promise<NumberedGhItem[] | string> {
  try {
    const { stdout: repoStdout } = await execFileAsync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      { cwd: projectPath, timeout: 30000 }
    )
    const repo = String(repoStdout).trim()
    const { stdout } = await execFileAsync('gh', ghApiOpenItemsArgs(kind, repo, label), {
      cwd: projectPath,
      timeout: 30000,
    })
    return parseNumberedGhLines(String(stdout), kind === 'pr' ? 'PR' : 'issue')
  } catch (err) {
    return `Failed to list open ${kind === 'pr' ? 'PRs' : 'issues'}: ${describeGhError(err)}`
  }
}

async function listRemoteOpenGhItems(
  projectPath: string,
  hostId: string,
  kind: 'pr' | 'issue',
  label?: string
): Promise<NumberedGhItem[] | string> {
  const host = getRequiredHost(hostId)
  const ghProbe = await probeRemoteGh(host)
  if (!ghProbe.ok) return ghProbe.error

  const labelQuery = kind === 'issue' && label ? `&labels=${encodeURIComponent(label)}` : ''
  try {
    const stdout = await expectRemoteOk(
      host,
      [
        'sh',
        '-c',
        [
          'set -e',
          'cd "$1"',
          'repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)',
          'if [ "$2" = pr ]; then',
          '  gh api --paginate "repos/$repo/pulls?state=open&per_page=100" --jq ".[].number"',
          'else',
          '  gh api --paginate "repos/$repo/issues?state=open&per_page=100$3" --jq ".[] | select(.pull_request | not) | .number"',
          'fi',
        ].join('\n'),
        '_',
        projectPath,
        kind,
        labelQuery,
      ],
      'gh failed'
    )
    return parseNumberedGhLines(stdout, kind === 'pr' ? 'PR' : 'issue')
  } catch (err) {
    return `Failed to list open ${kind === 'pr' ? 'PRs' : 'issues'}: ${describeGhError(err)}`
  }
}

export async function listOpenPrs(
  projectPath: string,
  hostId: string | null
): Promise<NumberedGhItem[] | string> {
  return hostId === null
    ? listLocalOpenGhItems(projectPath, 'pr')
    : listRemoteOpenGhItems(projectPath, hostId, 'pr')
}

export async function listOpenIssues(
  projectPath: string,
  hostId: string | null,
  label?: string
): Promise<NumberedGhItem[] | string> {
  return hostId === null
    ? listLocalOpenGhItems(projectPath, 'issue', label)
    : listRemoteOpenGhItems(projectPath, hostId, 'issue', label)
}

export async function countOpenIssues(
  projectPath: string,
  hostId: string | null = null,
  label?: string,
  deps: { listIssues?: ListNumberedItems } = {}
): Promise<number | string> {
  const list = deps.listIssues ?? ((p: string, h: string | null) => listOpenIssues(p, h, label))
  try {
    const items = await list(projectPath, hostId)
    if (typeof items === 'string') return items
    return items.length
  } catch (err) {
    return describeGhError(err)
  }
}

export async function listRepoLabels(
  projectPath: string,
  hostId: string | null = null
): Promise<string[] | string> {
  if (hostId === null) {
    try {
      const { stdout: repoStdout } = await execFileAsync(
        'gh',
        ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
        { cwd: projectPath, timeout: 30000 }
      )
      const repo = String(repoStdout).trim()
      const { stdout } = await execFileAsync(
        'gh',
        ['api', '--paginate', `repos/${repo}/labels?per_page=100`, '--jq', '.[].name'],
        { cwd: projectPath, timeout: 30000 }
      )
      return parseLabelLines(String(stdout))
    } catch (err) {
      return `Failed to list labels: ${describeGhError(err)}`
    }
  }

  const host = getRequiredHost(hostId)
  const ghProbe = await probeRemoteGh(host)
  if (!ghProbe.ok) return ghProbe.error

  try {
    const stdout = await expectRemoteOk(
      host,
      [
        'sh',
        '-c',
        [
          'set -e',
          'cd "$1"',
          'repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)',
          'gh api --paginate "repos/$repo/labels?per_page=100" --jq ".[].name"',
        ].join('\n'),
        '_',
        projectPath,
      ],
      'gh failed'
    )
    return parseLabelLines(stdout)
  } catch (err) {
    return `Failed to list labels: ${describeGhError(err)}`
  }
}
