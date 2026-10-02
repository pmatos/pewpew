import { describe, it, expect } from 'vitest'
import { parsePrSpec, parseIssueSpec, MAX_PR_SPEC_NUMBERS } from './pr-spec-parser'

describe('parsePrSpec', () => {
  describe('valid input', () => {
    it('parses a single PR number', () => {
      expect(parsePrSpec('42')).toEqual({ numbers: [42] })
    })

    it('parses a comma-separated list', () => {
      expect(parsePrSpec('1,2,3')).toEqual({ numbers: [1, 2, 3] })
    })

    it('parses an inclusive range', () => {
      expect(parsePrSpec('1-3')).toEqual({ numbers: [1, 2, 3] })
    })

    it('parses a mixed list of numbers and ranges', () => {
      expect(parsePrSpec('1,2,22-25')).toEqual({ numbers: [1, 2, 22, 23, 24, 25] })
    })

    it('matches the example from the feature spec', () => {
      expect(parsePrSpec('1,2,22-28')).toEqual({
        numbers: [1, 2, 22, 23, 24, 25, 26, 27, 28],
      })
    })

    it('tolerates whitespace inside and around tokens', () => {
      expect(parsePrSpec(' 1 ,  2 - 4 , 5 ')).toEqual({ numbers: [1, 2, 3, 4, 5] })
    })

    it('treats a single-element range as one number', () => {
      expect(parsePrSpec('5-5')).toEqual({ numbers: [5] })
    })

    it('dedupes overlapping numbers', () => {
      expect(parsePrSpec('1,1,2-3,3')).toEqual({ numbers: [1, 2, 3] })
    })

    it('returns numbers sorted ascending even when input is not', () => {
      expect(parsePrSpec('5,1,3')).toEqual({ numbers: [1, 3, 5] })
    })

    it('skips empty tokens between commas', () => {
      expect(parsePrSpec('1,,2,')).toEqual({ numbers: [1, 2] })
    })
  })

  describe('input errors', () => {
    it('rejects empty input', () => {
      expect(parsePrSpec('')).toEqual({ error: 'Enter at least one PR number.' })
    })

    it('rejects whitespace-only input', () => {
      expect(parsePrSpec('   ')).toEqual({ error: 'Enter at least one PR number.' })
    })

    it('rejects input that is only commas', () => {
      expect(parsePrSpec(',,,')).toEqual({ error: 'Enter at least one PR number.' })
    })

    it('rejects non-numeric tokens', () => {
      const r = parsePrSpec('abc')
      expect(r).toEqual({ error: 'Invalid PR spec: "abc".' })
    })

    it('rejects malformed range tokens', () => {
      expect(parsePrSpec('1-')).toEqual({ error: 'Invalid PR spec: "1-".' })
      expect(parsePrSpec('-3')).toEqual({ error: 'Invalid PR spec: "-3".' })
      expect(parsePrSpec('1--3')).toEqual({ error: 'Invalid PR spec: "1--3".' })
    })

    it('rejects floats', () => {
      expect(parsePrSpec('1.5')).toEqual({ error: 'Invalid PR spec: "1.5".' })
    })

    it('rejects whitespace inside numeric tokens', () => {
      expect(parsePrSpec('1 2')).toEqual({ error: 'Invalid PR spec: "1 2".' })
    })

    it('rejects zero', () => {
      expect(parsePrSpec('0')).toEqual({ error: 'PR numbers must be 1 or greater.' })
    })

    it('rejects ranges with start > end', () => {
      expect(parsePrSpec('5-3')).toEqual({ error: 'Invalid range "5-3": start > end.' })
    })

    it('rejects ranges that exceed the size cap', () => {
      const result = parsePrSpec(`1-${MAX_PR_SPEC_NUMBERS + 1}`)
      expect(result).toEqual({
        error: `Range "1-${MAX_PR_SPEC_NUMBERS + 1}" is too large (max ${MAX_PR_SPEC_NUMBERS}).`,
      })
    })

    it('rejects total numbers exceeding the cap across multiple tokens', () => {
      // Two tokens within their own cap but combined exceed it.
      const half = Math.floor(MAX_PR_SPEC_NUMBERS / 2)
      const a = `1-${half + 1}` // half+1 numbers
      const b = `1000-${1000 + half + 1}` // half+2 numbers
      const result = parsePrSpec(`${a},${b}`)
      expect(result).toEqual({
        error: `Too many PR numbers (max ${MAX_PR_SPEC_NUMBERS}).`,
      })
    })

    it('rejects values exceeding safe integer range', () => {
      expect(parsePrSpec('99999999999999999')).toEqual({
        error: 'PR numbers must be 1 or greater.',
      })
    })
  })
})

describe('parseIssueSpec', () => {
  it('parses mixed lists and ranges', () => {
    expect(parseIssueSpec('2-5, 7')).toEqual({ numbers: [2, 3, 4, 5, 7] })
    expect(parseIssueSpec('1, 2, 3')).toEqual({ numbers: [1, 2, 3] })
  })

  it('uses issue wording in errors', () => {
    expect(parseIssueSpec('')).toEqual({ error: 'Enter at least one issue number.' })
    expect(parseIssueSpec('abc')).toEqual({ error: 'Invalid issue spec: "abc".' })
    expect(parseIssueSpec('0')).toEqual({ error: 'Issue numbers must be 1 or greater.' })
    expect(parseIssueSpec(`1-${MAX_PR_SPEC_NUMBERS + 1}`)).toEqual({
      error: `Range "1-${MAX_PR_SPEC_NUMBERS + 1}" is too large (max ${MAX_PR_SPEC_NUMBERS}).`,
    })
  })
})
