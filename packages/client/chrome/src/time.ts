/**
 * The shared timestamp formatting used by every surface that shows a run's
 * "who · when": the panel's page status line and the schema-ui default view's
 * per-op meta line both rendered a bare UTC stamp with no zone marker, so a
 * Shanghai user read 16:03 as 08:03 (frontend review F14).
 *
 * One implementation in chrome because both callers need exactly this, and a
 * second copy would drift. The functions are pure and take their locale/time
 * zone explicitly, so tests are deterministic while the live call passes
 * nothing and follows the runtime's own locale and zone.
 * @module
 */

/** The clock formatting options a caller may pin (tests) or leave to the runtime. */
export interface TimeFormatOptions {
  /** A BCP-47 locale tag; the runtime default when omitted. */
  locale?: string
  /** An IANA time zone; the runtime zone when omitted. */
  timeZone?: string
}

/**
 * One formatter per (style, locale, zone): constructing an `Intl.DateTimeFormat`
 * is the expensive part of formatting, and these run once per rendered row on
 * list surfaces — building one per call made a long list re-compile the locale
 * data on every cell (arch-review 2026-09-20, `intl-formatter-per-call-in-list-render`).
 * The cache is bounded by the callers' actual shapes (the runtime default plus
 * whatever a test pins), and `Intl.DateTimeFormat` is stateful only in its own
 * mutable-options quirk, which nothing here touches.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>()

/** The cached formatter for one style under the given locale/zone. */
function formatterFor(style: 'local' | 'full', options: TimeFormatOptions): Intl.DateTimeFormat {
  const key = `${style}\u0000${options.locale ?? ''}\u0000${options.timeZone ?? ''}`
  const cached = FORMATTERS.get(key)
  if (cached !== undefined) return cached
  const created = new Intl.DateTimeFormat(options.locale, {
    // 显式分量而不是 dateStyle/timeStyle：`timeStyle` 与 `timeZoneName` 不能
    // 并用，而 `formatFullTimestamp` 的契约（文档与调用方）是「绝对时刻 + 时区名」
    // ——此前用 timeStyle 的实现从没渲染过时区名，与文档不符（doc-code 一致性
    // direction=code）。两种样式共用这一份构造，只有分量表不同。
    year: 'numeric',
    ...(style === 'local'
      ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }),
    hourCycle: 'h23',
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  })
  FORMATTERS.set(key, created)
  return created
}

/** The compact `YYYY-MM-DD HH:mm`-shaped stamp in the LOCAL zone (locale-ordered, 24h). */
export function formatLocalDateTime(ts: number, options: TimeFormatOptions = {}): string {
  return formatterFor('local', options).format(ts)
}

/**
 * The full stamp for a tooltip: date, time to the second, and the zone NAME —
 * so a user who needs the absolute instant can read it without guessing which
 * zone the compact line used.
 */
export function formatFullTimestamp(ts: number, options: TimeFormatOptions = {}): string {
  return formatterFor('full', options).format(ts)
}
