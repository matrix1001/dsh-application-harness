/**
 * The page's formatting/narrowing helpers: byte and share rendering, local
 * timestamps and the `{ scan }` result narrowing that turns a host/view skew
 * into a readable error instead of a crash.
 */
import { describe, expect, it } from 'vitest'
import { formatBytes, formatPercent, formatTime, scanOf } from '../src/client/DiskSpaceView.tsx'

describe('view formatting', () => {
  it('formats byte counts across units and clamps non-positive values', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(100 * 1024)).toBe('100 KB')
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB')
    expect(formatBytes(1024 ** 5)).toBe('1024 TB')
  })

  it('formats shares and timestamps', () => {
    expect(formatPercent(1, 4)).toBe('25.0%')
    expect(formatPercent(1, 0)).toBe('—')
    expect(formatTime(0)).toBeTypeOf('string')
  })

  it('narrows only a well-formed scan row', () => {
    const scan = { scanId: 's_1', root: '/srv', state: 'completed' }
    expect(scanOf({ scan })).toBe(scan)
    expect(scanOf(null)).toBeNull()
    expect(scanOf({})).toBeNull()
    expect(scanOf({ scan: null })).toBeNull()
    expect(scanOf({ scan: {} })).toBeNull()
    expect(scanOf({ scan: { scanId: 1, root: '/', state: 'completed' } })).toBeNull()
  })
})
