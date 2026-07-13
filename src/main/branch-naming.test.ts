import { describe, expect, it } from 'vitest'
import {
  parseIssueNumber,
  parsePrNumber,
  sanitizeBranchPrefix,
  worktreeBranchName,
} from './branch-naming'

describe('parseIssueNumber', () => {
  it('parses every supported separator between "issue" and the number', () => {
    expect(parseIssueNumber('issue37')).toBe(37)
    expect(parseIssueNumber('issue-37')).toBe(37)
    expect(parseIssueNumber('issue_5')).toBe(5)
    expect(parseIssueNumber('issue/12')).toBe(12)
    expect(parseIssueNumber('issue#8')).toBe(8)
    expect(parseIssueNumber('issue 9')).toBe(9)
  })

  it('is case-insensitive', () => {
    expect(parseIssueNumber('ISSUE-42')).toBe(42)
    expect(parseIssueNumber('Issue3')).toBe(3)
  })

  it('matches an issue token embedded anywhere in the string', () => {
    expect(parseIssueNumber('fix/issue-100-add-widget')).toBe(100)
    expect(parseIssueNumber('myissue7')).toBe(7)
  })

  it('reads multi-digit numbers', () => {
    expect(parseIssueNumber('issue-1234')).toBe(1234)
  })

  it('returns the first source that contains a match, skipping undefined/empty', () => {
    expect(parseIssueNumber(undefined, '', 'issue-4')).toBe(4)
    expect(parseIssueNumber('issue-1', 'issue-2')).toBe(1)
    expect(parseIssueNumber('no-number-here', 'issue-2')).toBe(2)
  })

  it('returns undefined when no source names an issue number', () => {
    expect(parseIssueNumber('main')).toBeUndefined()
    expect(parseIssueNumber('release-42')).toBeUndefined()
    expect(parseIssueNumber('issue')).toBeUndefined()
    expect(parseIssueNumber('issues')).toBeUndefined()
    expect(parseIssueNumber()).toBeUndefined()
    expect(parseIssueNumber(undefined, undefined)).toBeUndefined()
  })
})

describe('worktreeBranchName', () => {
  it('joins the sanitized project prefix and the raw worktree name with a slash', () => {
    expect(worktreeBranchName('pewpew', 'issue-37')).toBe('pewpew/issue-37')
  })

  it('sanitizes the project prefix but passes the worktree name through verbatim', () => {
    expect(worktreeBranchName('My Repo', 'Feature_X')).toBe('My-Repo/Feature_X')
    expect(worktreeBranchName('repo:with~bad^chars', 'wt')).toBe('repo-with-bad-chars/wt')
  })

  it('falls back to the pewpew prefix when the project name has no valid characters', () => {
    expect(worktreeBranchName('   ', 'wt')).toBe('pewpew/wt')
  })
})

describe('parsePrNumber', () => {
  it('extracts the number from a canonical pr-<n> worktree name', () => {
    expect(parsePrNumber('pr-808')).toBe(808)
    expect(parsePrNumber('pr-1')).toBe(1)
  })

  it('returns undefined for names that are not exactly pr-<n>', () => {
    expect(parsePrNumber('issue-5')).toBeUndefined()
    expect(parsePrNumber('pr-')).toBeUndefined()
    expect(parsePrNumber('pr-808-extra')).toBeUndefined()
    expect(parsePrNumber('xpr-3')).toBeUndefined()
    expect(parsePrNumber('PR-9')).toBeUndefined()
  })
})

describe('sanitizeBranchPrefix', () => {
  it('preserves valid ref-component characters', () => {
    expect(sanitizeBranchPrefix('pewpew')).toBe('pewpew')
    expect(sanitizeBranchPrefix('my_repo.v2')).toBe('my_repo.v2')
  })

  it('replaces git-illegal characters with `-`', () => {
    expect(sanitizeBranchPrefix('My Repo')).toBe('My-Repo')
    expect(sanitizeBranchPrefix('repo:with~bad^chars?*[\\]')).toBe('repo-with-bad-chars')
  })

  it('strips consecutive dots rejected by git ref names', () => {
    expect(sanitizeBranchPrefix('my..repo')).toBe('my-repo')
    expect(sanitizeBranchPrefix('repo...v2')).toBe('repo-v2')
  })

  it('strips leading and trailing punctuation', () => {
    expect(sanitizeBranchPrefix('-leading')).toBe('leading')
    expect(sanitizeBranchPrefix('.dot.')).toBe('dot')
  })

  it('strips trailing `.lock` suffixes (illegal as ref-component suffixes)', () => {
    expect(sanitizeBranchPrefix('proj.lock')).toBe('proj')
    expect(sanitizeBranchPrefix('proj.lock.lock')).toBe('proj')
    expect(sanitizeBranchPrefix('proj-.lock')).toBe('proj')
  })

  it('falls back to `pewpew` when nothing valid remains', () => {
    expect(sanitizeBranchPrefix('   ')).toBe('pewpew')
    expect(sanitizeBranchPrefix(':::')).toBe('pewpew')
    expect(sanitizeBranchPrefix('')).toBe('pewpew')
  })
})
