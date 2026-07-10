import { open as openFile } from 'fs/promises'
import type { DiffFile, DiffMode } from '../shared/types'
import { parseDiff, synthesizeUntrackedFile } from './diff-parser'

// Runs `git <argv>` in a fixed working directory and yields its stdout. This is
// the seam the review module is tested through: real callers bind it to
// execFile in the session's worktree; tests inject a fake that returns canned
// stdout (or throws to simulate a failing git invocation).
export type GitRunner = (argv: string[]) => Promise<{ stdout: string }>

// Returns the text content of an untracked file identified by its
// repo-relative path, or null when the file cannot be included in the review
// (binary, too large, unreadable). Injected so diff collection stays free of
// filesystem access and remains unit-testable.
export type ReadUntrackedFile = (relativePath: string) => Promise<string | null>

const UNTRACKED_FILE_READ_CONCURRENCY = 16

export async function collectReviewDiff(
  git: GitRunner,
  mode: DiffMode,
  baseBranch: string | undefined,
  readUntrackedFile: ReadUntrackedFile
): Promise<DiffFile[]> {
  const { stdout: rawDiff } = await git(await diffArgsForMode(git, mode, baseBranch))
  const files = parseDiff(rawDiff)

  if (mode === 'uncommitted') {
    files.push(...(await collectUntrackedFiles(git, readUntrackedFile)))
  }
  return files
}

async function collectUntrackedFiles(
  git: GitRunner,
  readUntrackedFile: ReadUntrackedFile
): Promise<DiffFile[]> {
  const { stdout } = await git(['ls-files', '--others', '--exclude-standard'])
  const paths = stdout.split('\n').filter(Boolean)
  const synthesized = await mapWithConcurrency(
    paths,
    UNTRACKED_FILE_READ_CONCURRENCY,
    async (path) => {
      const content = await readUntrackedFile(path).catch(() => null)
      return content === null ? null : synthesizeUntrackedFile(path, content)
    }
  )
  return synthesized.filter((file): file is DiffFile => file !== null)
}

// Reads a file's text only when it is a regular file whose size stays within
// maxBytes (checked both from stat and after decoding, since multibyte content
// can exceed the byte budget the stat size suggested). Returns null otherwise —
// the review then skips it rather than pulling a huge or binary blob into the
// diff view. This is the filesystem seam behind ReadUntrackedFile.
export async function readTextFileUnderLimit(
  path: string,
  maxBytes: number
): Promise<string | null> {
  const file = await openFile(path, 'r')
  try {
    const fileStat = await file.stat()
    if (!fileStat.isFile() || fileStat.size > maxBytes) return null

    const content = await file.readFile('utf-8')
    return Buffer.byteLength(content, 'utf-8') > maxBytes ? null : content
  } finally {
    await file.close()
  }
}

async function mapWithConcurrency<T, Result>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<Result>
): Promise<Result[]> {
  const results = new Array<Result>(items.length)
  let nextIndex = 0
  const runNext = async (): Promise<void> => {
    const index = nextIndex
    nextIndex += 1
    if (index >= items.length) return
    results[index] = await mapper(items[index], index)
    return runNext()
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runNext()))
  return results
}

async function diffArgsForMode(
  git: GitRunner,
  mode: DiffMode,
  baseBranch: string | undefined
): Promise<string[]> {
  switch (mode) {
    case 'uncommitted':
      try {
        // New repos with no commits have no HEAD to diff against.
        await git(['rev-parse', 'HEAD'])
        return ['diff', 'HEAD']
      } catch {
        const { stdout: emptyTree } = await git(['hash-object', '-t', 'tree', '/dev/null'])
        return ['diff', emptyTree.trim()]
      }
    case 'unpushed':
      return ['diff', '@{upstream}']
    case 'branch':
      return ['diff', `${baseBranch ?? 'main'}...`]
  }
}

export async function listReviewBranches(git: GitRunner): Promise<string[]> {
  const { stdout } = await git(['branch', '-a', '--format=%(refname:short)'])
  return stdout.split('\n').filter(Boolean)
}

export async function resolveReviewDefaultBranch(git: GitRunner): Promise<string> {
  try {
    const { stdout } = await git(['symbolic-ref', 'refs/remotes/origin/HEAD'])
    return stdout.trim().replace('refs/remotes/origin/', '')
  } catch {
    return 'main'
  }
}
