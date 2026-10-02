export const MAX_SPEC_NUMBERS = 200

export type NumberSpecResult = { numbers: number[] } | { error: string }
export type SpecNoun = 'PR' | 'issue'

const TOKEN_RE = /^(\d+)(?:\s*-\s*(\d+))?$/

export function parsePrSpec(input: string): NumberSpecResult {
  return parseNumberSpec(input, 'PR')
}

export function parseIssueSpec(input: string): NumberSpecResult {
  return parseNumberSpec(input, 'issue')
}

function parseNumberSpec(input: string, noun: SpecNoun): NumberSpecResult {
  const capNoun = noun.charAt(0).toUpperCase() + noun.slice(1)
  const trimmed = input.trim()
  if (trimmed.length === 0) return { error: `Enter at least one ${noun} number.` }

  const tokens: string[] = []
  for (const part of trimmed.split(',')) {
    const token = part.trim()
    if (token.length > 0) tokens.push(token)
  }
  if (tokens.length === 0) return { error: `Enter at least one ${noun} number.` }

  const result = new Set<number>()
  for (const token of tokens) {
    const match = TOKEN_RE.exec(token)
    if (!match) return { error: `Invalid ${noun} spec: "${token}".` }

    const lo = Number.parseInt(match[1], 10)
    const hi = match[2] === undefined ? lo : Number.parseInt(match[2], 10)

    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < 1 || hi < 1) {
      return { error: `${capNoun} numbers must be 1 or greater.` }
    }
    if (hi < lo) return { error: `Invalid range "${token}": start > end.` }
    if (hi - lo + 1 > MAX_SPEC_NUMBERS) {
      return { error: `Range "${token}" is too large (max ${MAX_SPEC_NUMBERS}).` }
    }

    for (let n = lo; n <= hi; n++) {
      result.add(n)
      if (result.size > MAX_SPEC_NUMBERS) {
        return { error: `Too many ${noun} numbers (max ${MAX_SPEC_NUMBERS}).` }
      }
    }
  }

  return { numbers: Array.from(result).sort((a, b) => a - b) }
}
