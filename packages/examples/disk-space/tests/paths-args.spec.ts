/**
 * The path and argument guards: every externally supplied path is normalised
 * before it can reach the filesystem, and every optional operation argument
 * has exactly one accepted shape. These are the rules the scan, browse and
 * trash scenarios rely on.
 */
import { describe, expect, it } from 'vitest'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import {
  depthOf, isExcluded, isInsideTrash, joinRelative, normalizeRelativePath, parentPathOf, relativeToRoot,
  resolveInside, TRASH_DIR,
} from '../src/paths.ts'
import {
  objectArgs, optionalBoolean, optionalInteger, optionalString, optionalStringArray, optionalText, requiredString,
  requiredStringArray,
} from '../src/args.ts'

describe('root-relative paths', () => {
  it('normalises accepted paths and rejects every escape', () => {
    expect(normalizeRelativePath('')).toBe('')
    expect(normalizeRelativePath('a/b.txt')).toBe('a/b.txt')
    for (const bad of ['/etc/passwd', 'a\\b', `a\0b`, 'a//b', './a', 'a/./b', '../a', 'a/../b', 'a/']) {
      expect(() => normalizeRelativePath(bad)).toThrow(AppError)
    }
  })

  it('derives parents, joined children, depths and exclusion prefixes', () => {
    expect(parentPathOf('a/b/c')).toBe('a/b')
    expect(parentPathOf('top')).toBe('')
    expect(joinRelative('', 'top')).toBe('top')
    expect(joinRelative('a/b', 'c')).toBe('a/b/c')
    expect(depthOf('')).toBe(0)
    expect(depthOf('a/b/c')).toBe(3)
    expect(isExcluded('cache', ['cache'])).toBe(true)
    expect(isExcluded('cache/deep/file', ['cache'])).toBe(true)
    expect(isExcluded('cache-other', ['cache'])).toBe(false)
    expect(isExcluded('a', ['b'])).toBe(false)
    expect(isInsideTrash(TRASH_DIR)).toBe(true)
    expect(isInsideTrash(`${TRASH_DIR}/x`)).toBe(true)
    expect(isInsideTrash('normal')).toBe(false)
  })

  it('resolves inside the root and refuses traversal', () => {
    expect(resolveInside('/tmp/root', '')).toBe('/tmp/root')
    expect(resolveInside('/tmp/root', 'a/b')).toBe('/tmp/root/a/b')
    expect(resolveInside('/tmp/root/', 'a')).toBe('/tmp/root/a')
    expect(relativeToRoot('/tmp/root', '/tmp/root/a/b')).toBe('a/b')
    expect(relativeToRoot('/tmp/root/', '/tmp/root/a')).toBe('a')
    expect(relativeToRoot('/tmp/root', '/tmp/root')).toBe('')
    expect(() => resolveInside('/tmp/root', '../x')).toThrow(AppError)
    expect(() => resolveInside('relative-root', 'a')).toThrow(AppError)
    expect(() => relativeToRoot('/tmp/root', '/tmp/other')).toThrow(AppError)
    // A relative value is still normalised by the same rule set.
    expect(() => relativeToRoot('/tmp/root', '/tmp/root/../x')).toThrow(AppError)
  })
})

describe('operation argument readers', () => {
  it('reads the argument object', () => {
    expect(objectArgs({ a: 1 })).toEqual({ a: 1 })
    for (const bad of [null, 'x', 1, []]) expect(() => objectArgs(bad)).toThrow(/must be an object/)
  })

  it('reads required and optional strings', () => {
    expect(requiredString({ a: 'x' }, 'a')).toBe('x')
    expect(() => requiredString({}, 'a')).toThrow(/non-empty string/)
    expect(() => requiredString({ a: '' }, 'a')).toThrow(/non-empty string/)
    expect(() => requiredString({ a: 2 }, 'a')).toThrow(/non-empty string/)
    expect(optionalString({}, 'a')).toBeUndefined()
    expect(optionalString({ a: null }, 'a')).toBeUndefined()
    expect(optionalString({ a: 'x' }, 'a')).toBe('x')
    expect(() => optionalString({ a: '' }, 'a')).toThrow(/when given/)
    expect(() => optionalString({ a: 2 }, 'a')).toThrow(/when given/)
    expect(optionalText({}, 'a')).toBeUndefined()
    expect(optionalText({ a: null }, 'a')).toBeUndefined()
    expect(optionalText({ a: '' }, 'a')).toBe('')
    expect(optionalText({ a: 'x' }, 'a')).toBe('x')
    expect(() => optionalText({ a: 2 }, 'a')).toThrow(/string when given/)
  })

  it('reads bounded integers with a fallback', () => {
    expect(optionalInteger({}, 'n', 7, { min: 1, max: 9 })).toBe(7)
    expect(optionalInteger({ n: null }, 'n', 7, { min: 1, max: 9 })).toBe(7)
    expect(optionalInteger({ n: 3 }, 'n', 7, { min: 1, max: 9 })).toBe(3)
    expect(() => optionalInteger({ n: 0 }, 'n', 7, { min: 1, max: 9 })).toThrow(/integer between/)
    expect(() => optionalInteger({ n: 10 }, 'n', 7, { min: 1, max: 9 })).toThrow(/integer between/)
    expect(() => optionalInteger({ n: 1.5 }, 'n', 7, { min: 1, max: 9 })).toThrow(/integer between/)
    expect(() => optionalInteger({ n: '3' }, 'n', 7, { min: 1, max: 9 })).toThrow(/integer between/)
  })

  it('reads optional booleans', () => {
    expect(optionalBoolean({}, 'b', true)).toBe(true)
    expect(optionalBoolean({ b: null }, 'b', true)).toBe(true)
    expect(optionalBoolean({ b: false }, 'b', true)).toBe(false)
    expect(() => optionalBoolean({ b: 'yes' }, 'b', true)).toThrow(/boolean/)
  })

  it('reads optional string arrays and required bounded deduplicated arrays', () => {
    expect(optionalStringArray({}, 'a')).toEqual([])
    expect(optionalStringArray({ a: null }, 'a')).toEqual([])
    expect(optionalStringArray({ a: ['x', 'y'] }, 'a')).toEqual(['x', 'y'])
    expect(() => optionalStringArray({ a: 'x' }, 'a')).toThrow(/array of non-empty strings/)
    expect(() => optionalStringArray({ a: ['x', ''] }, 'a')).toThrow(/array of non-empty strings/)
    expect(requiredStringArray({ a: ['x', 'x', 'y'] }, 'a', 3)).toEqual(['x', 'y'])
    for (const bad of [{}, { a: [] }, { a: ['x', 'y', 'z'] }, { a: ['x', ''] }, { a: [1] }]) {
      expect(() => requiredStringArray(bad, 'a', 2)).toThrow(/non-empty array/)
    }
  })
})
