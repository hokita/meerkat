import { describe, expect, it } from 'vitest'
import { formatElapsed } from './elapsed'

describe('formatElapsed', () => {
  it.each([
    [5_000, false, '5s'],
    [125_000, false, '2m'],
    [3_900_000, false, '1h 05m'],
    [90_000_000, false, '25h 00m'],
    [60_000, true, '≥ 1m'],
    [-5_000, false, '0s'],
  ])('formats %i ms (lowerBound %s) as %s', (ms, lowerBound, expected) => {
    expect(formatElapsed(ms, lowerBound)).toBe(expected)
  })
})
