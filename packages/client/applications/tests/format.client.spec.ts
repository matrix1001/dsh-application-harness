import { describe, expect, it } from 'vitest'
import { formatBytes } from '../src/client/format.ts'

describe('management formatting', () => {
  it('renders byte sizes in binary units and keeps small values exact', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.00 KiB')
    expect(formatBytes(1536)).toBe('1.50 KiB')
    expect(formatBytes(1024 * 1024 * 3.5)).toBe('3.50 MiB')
    expect(formatBytes(1024 * 1024 * 120)).toBe('120 MiB')
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
  })
})
