/**
 * The shared narrowing primitives: the shape tests every view reads a raw
 * projection value with. Each used to be a per-package copy (identical bodies,
 * drifted names), so the gates here are the exact behaviours the copies had.
 */
import { describe, expect, it } from 'vitest'
import { finiteOr, isRecord, stringList, stringOr } from '../src/narrow.ts'

describe('isRecord', () => {
  it('accepts a plain object and rejects null, arrays and primitives', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord([1, 2])).toBe(false)
    expect(isRecord('x')).toBe(false)
    expect(isRecord(3)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
  })
})

describe('finiteOr', () => {
  it('keeps a finite number and falls back for everything else', () => {
    expect(finiteOr(7, 0)).toBe(7)
    expect(finiteOr(-1.5, 0)).toBe(-1.5)
    expect(finiteOr(Number.NaN, 3)).toBe(3)
    expect(finiteOr(Number.POSITIVE_INFINITY, 3)).toBe(3)
    expect(finiteOr('7', 3)).toBe(3)
    expect(finiteOr(undefined, 3)).toBe(3)
  })
})

describe('stringOr', () => {
  it('keeps a string and falls back otherwise (empty string by default)', () => {
    expect(stringOr('a', 'x')).toBe('a')
    expect(stringOr('', 'x')).toBe('')
    expect(stringOr(3, 'x')).toBe('x')
    expect(stringOr(undefined)).toBe('')
    expect(stringOr(null, 'x')).toBe('x')
  })
})

describe('stringList', () => {
  it('keeps the string members and reads a non-list as empty', () => {
    expect(stringList(['a', 'b'])).toEqual(['a', 'b'])
    expect(stringList(['a', 2, null, 'b'])).toEqual(['a', 'b'])
    expect(stringList([])).toEqual([])
    expect(stringList('a')).toEqual([])
    expect(stringList(undefined)).toEqual([])
  })
})
