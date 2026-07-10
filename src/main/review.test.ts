import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { GitRunner } from './review'
import {
  collectReviewDiff,
  listReviewBranches,
  readTextFileUnderLimit,
  resolveReviewDefaultBranch,
} from './review'

// A minimal but valid unified diff for a single modified file, so parseDiff
// produces exactly one DiffFile with path 'foo.ts'.
const MODIFIED_FOO_DIFF = [
  'diff --git a/foo.ts b/foo.ts',
  'index abc1234..def5678 100644',
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -1 +1 @@',
  '-old line',
  '+new line',
  '',
].join('\n')

// Builds a fake GitRunner that dispatches on the git subcommand. Each entry maps
// the joined argv to either a stdout string or an Error to throw.
function fakeGit(responses: Record<string, string | Error>): GitRunner {
  return async (argv) => {
    const key = argv.join(' ')
    const match = responses[key]
    if (match === undefined) throw new Error(`unexpected git invocation: ${key}`)
    if (match instanceof Error) throw match
    return { stdout: match }
  }
}

const noUntracked = async (): Promise<string | null> => null

describe('collectReviewDiff', () => {
  it('diffs against HEAD when the repo has commits (uncommitted mode)', async () => {
    const git = fakeGit({
      'rev-parse HEAD': 'abc123\n',
      'diff HEAD': MODIFIED_FOO_DIFF,
      'ls-files --others --exclude-standard': '',
    })
    const files = await collectReviewDiff(git, 'uncommitted', undefined, noUntracked)
    expect(files.map((f) => f.path)).toEqual(['foo.ts'])
  })

  it('diffs against the empty tree when the repo has no HEAD yet', async () => {
    const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
    const git = fakeGit({
      'rev-parse HEAD': new Error('fatal: ambiguous argument HEAD: unknown revision'),
      'hash-object -t tree /dev/null': `${emptyTree}\n`,
      [`diff ${emptyTree}`]: MODIFIED_FOO_DIFF,
      'ls-files --others --exclude-standard': '',
    })
    const files = await collectReviewDiff(git, 'uncommitted', undefined, noUntracked)
    expect(files.map((f) => f.path)).toEqual(['foo.ts'])
  })

  it('appends readable untracked files in ls-files order and skips unreadable ones', async () => {
    const git = fakeGit({
      'rev-parse HEAD': 'abc123\n',
      'diff HEAD': '',
      'ls-files --others --exclude-standard': 'a.txt\nbig.bin\nb.txt\n',
    })
    const contents: Record<string, string | null> = {
      'a.txt': 'hello\n',
      'big.bin': null, // too large / binary -> skipped
      'b.txt': 'world\n',
    }
    const files = await collectReviewDiff(
      git,
      'uncommitted',
      undefined,
      async (p) => contents[p] ?? null
    )
    expect(files.map((f) => f.path)).toEqual(['a.txt', 'b.txt'])
    expect(files.every((f) => f.status === 'added')).toBe(true)
    const aFile = files.find((f) => f.path === 'a.txt')!
    expect(aFile.hunks[0].lines[0].content).toBe('hello')
  })

  it('diffs against the upstream in unpushed mode without collecting untracked files', async () => {
    // ls-files is intentionally absent: if collectReviewDiff tried to gather
    // untracked files here, fakeGit would throw on the unexpected invocation.
    const git = fakeGit({ 'diff @{upstream}': MODIFIED_FOO_DIFF })
    const files = await collectReviewDiff(git, 'unpushed', undefined, noUntracked)
    expect(files.map((f) => f.path)).toEqual(['foo.ts'])
  })

  it('diffs against the given base ref in branch mode', async () => {
    const git = fakeGit({ 'diff develop...': MODIFIED_FOO_DIFF })
    const files = await collectReviewDiff(git, 'branch', 'develop', noUntracked)
    expect(files.map((f) => f.path)).toEqual(['foo.ts'])
  })

  it('defaults the branch base ref to main when none is given', async () => {
    const git = fakeGit({ 'diff main...': MODIFIED_FOO_DIFF })
    const files = await collectReviewDiff(git, 'branch', undefined, noUntracked)
    expect(files.map((f) => f.path)).toEqual(['foo.ts'])
  })
})

describe('listReviewBranches', () => {
  it('splits the ref list into branch names and drops blank lines', async () => {
    const git = fakeGit({
      'branch -a --format=%(refname:short)': 'main\nfeature/login\norigin/main\n\n',
    })
    expect(await listReviewBranches(git)).toEqual(['main', 'feature/login', 'origin/main'])
  })

  it('returns an empty list when there are no branches', async () => {
    const git = fakeGit({ 'branch -a --format=%(refname:short)': '' })
    expect(await listReviewBranches(git)).toEqual([])
  })
})

describe('resolveReviewDefaultBranch', () => {
  it('strips the origin prefix from the symbolic ref', async () => {
    const git = fakeGit({
      'symbolic-ref refs/remotes/origin/HEAD': 'refs/remotes/origin/develop\n',
    })
    expect(await resolveReviewDefaultBranch(git)).toBe('develop')
  })

  it('falls back to main when origin/HEAD is not set', async () => {
    const git = fakeGit({
      'symbolic-ref refs/remotes/origin/HEAD': new Error(
        'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref'
      ),
    })
    expect(await resolveReviewDefaultBranch(git)).toBe('main')
  })
})

describe('readTextFileUnderLimit', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'review-test-'))
    writeFileSync(join(dir, 'small.txt'), 'hello world')
    writeFileSync(join(dir, 'large.txt'), 'x'.repeat(200))
    mkdirSync(join(dir, 'a-directory'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the content of a regular file under the byte limit', async () => {
    expect(await readTextFileUnderLimit(join(dir, 'small.txt'), 1000)).toBe('hello world')
  })

  it('returns null when the file exceeds the byte limit', async () => {
    expect(await readTextFileUnderLimit(join(dir, 'large.txt'), 100)).toBeNull()
  })

  it('returns null when the path is not a regular file', async () => {
    expect(await readTextFileUnderLimit(join(dir, 'a-directory'), 1000)).toBeNull()
  })
})
