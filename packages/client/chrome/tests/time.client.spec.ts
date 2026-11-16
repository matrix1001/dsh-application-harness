// @vitest-environment jsdom
/**
 * The shared timestamp formatters (frontend review F14): the compact line is
 * the LOCAL time in the locale's own ordering, and the tooltip carries the
 * absolute instant. The explicit locale/zone options are what make the
 * assertions deterministic across machines.
 */
import { describe, expect, it } from 'vitest'
import { formatFullTimestamp, formatLocalDateTime } from '../src/time.ts'

/** 2025-08-30T16:00:00Z */
const TS = 1756569600000

describe('formatLocalDateTime', () => {
  it('renders the instant in the requested zone, not as a UTC readout', () => {
    // The same instant, three zones: the local wall clock differs, the instant does not.
    expect(formatLocalDateTime(TS, { locale: 'en-GB', timeZone: 'UTC' })).toContain('30/08/2025')
    expect(formatLocalDateTime(TS, { locale: 'en-GB', timeZone: 'Asia/Shanghai' })).toContain('31/08/2025')
    expect(formatLocalDateTime(TS, { locale: 'en-GB', timeZone: 'America/New_York' })).toContain('30/08/2025')
    expect(formatLocalDateTime(TS, { locale: 'en-GB', timeZone: 'Asia/Shanghai' })).toContain('00:00')
  })

  it('follows the locale\'s own ordering and a 24-hour clock', () => {
    const zh = formatLocalDateTime(TS, { locale: 'zh-CN', timeZone: 'Asia/Shanghai' })
    const en = formatLocalDateTime(TS, { locale: 'en-US', timeZone: 'Asia/Shanghai' })
    expect(zh).toContain('2025')
    expect(en).toContain('2025')
    // 24-hour: never an AM/PM marker, whatever the locale's habit.
    expect(zh).not.toMatch(/[AP]M/)
    expect(en).not.toMatch(/[AP]M/)
  })

  it('uses the runtime defaults when no options are given', () => {
    const own = new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(TS)
    expect(formatLocalDateTime(TS)).toBe(own)
  })
})

describe('formatFullTimestamp', () => {
  it('renders date AND time (to the second) AND the zone name for a tooltip', () => {
    const full = formatFullTimestamp(TS, { locale: 'en-GB', timeZone: 'Asia/Shanghai' })
    expect(full).toContain('2025')
    expect(full).toMatch(/\d{2}:\d{2}:\d{2}/)
    // 时区名/偏移必须在场（F14 的 tooltip 契约；timeStyle 时代的实现从没渲染过它）。
    expect(full).toMatch(/GMT|UTC|[A-Z]{2,5}/)
  })

  it('uses the runtime defaults when no options are given', () => {
    const own = new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    }).format(TS)
    expect(formatFullTimestamp(TS)).toBe(own)
  })
})
