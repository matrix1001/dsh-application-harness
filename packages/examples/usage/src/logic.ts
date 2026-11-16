/**
 * Pure logic for the DeepSeek usage application: the platform endpoints and
 * headers, the UTC+8 day arithmetic, the response parsers, the window
 * projection and the CSV writer. Nothing here performs I/O or reads a clock —
 * `now` is always an argument — so every rule the page and the tests state is
 * a pure function of its inputs.
 * @module @matrix1001/dsh-application-harness-usage/logic
 */

/** The platform dashboard origin (its private usage API lives under it). */
export const PLATFORM_BASE = 'https://platform.deepseek.com'
/** The dashboard's accounting timezone offset (UTC+8), in seconds. */
export const PLATFORM_TZ = 28800
/** The widest base reading the application keeps: every 7/30-day window is cut from it. */
export const BASE_DAYS = 30
/** The default window preference. */
export const USAGE_DEFAULT_PERIOD = 7
/** The default cache lifetime of one base reading (five minutes). */
export const USAGE_DEFAULT_TTL_MS = 300_000
/** The largest cache lifetime the settings accept (one day). */
export const MAX_TTL_MS = 86_400_000

/** The only window sizes the application exposes. */
export type Period = 7 | 30

/** A stable network/parsing failure code. */
export type UsageFailureCode = 'network-failed' | 'unauthorized' | 'rate-limited' | 'invalid-response'

/** One measurement family a platform bucket can carry. Absent means unmeasured. */
export interface UsageMeasurement {
  cost?: number
  tokens?: number
  requests?: number
}

/** One API-key × model series, keyed by `YYYY-MM-DD` (UTC+8) buckets. */
export interface DirectSeries {
  apiKeyId: string
  apiKeyName: string
  model: string
  daily: Record<string, UsageMeasurement>
}

/** The durable base reading (all measurements one fetch produced). */
export interface UsageData {
  balance?: number
  cumulativeCost?: number
  series: DirectSeries[]
}

/** One day in the requested window. */
export interface UsageDay {
  date: string
  cost?: number
  tokens?: number
  requests?: number
}

/** One model × API-key aggregate over the requested window. */
export interface UsageRow {
  model: string
  keyId: string
  keyName: string
  tokens?: number
  requests?: number
  cost?: number
}

/** One requested window, in both string and epoch form. */
export interface UsageWindow {
  start: string
  end: string
  days: number
}

/** A requested window plus the arithmetic the fetch/projection share. */
export interface UsageRange extends UsageWindow {
  /** Inclusive start (epoch seconds). */
  startSec: number
  /** Exclusive end (epoch seconds): tomorrow's UTC+8 midnight. */
  endSec: number
  /** The base reading's inclusive start: the widest of 30 days and the current month. */
  baseStartSec: number
  /** The current UTC+8 month's first midnight (epoch seconds). */
  monthStartSec: number
}

/** The six headline figures of one window. Absent means unmeasured. */
export interface UsageSummary {
  balance?: number
  cumulativeCost?: number
  monthCost?: number
  windowCost?: number
  windowTokens?: number
  windowRequests?: number
}

/** One window projection, computed from the stored base reading. */
export interface UsageProjection {
  window: UsageWindow
  summary: UsageSummary
  days: UsageDay[]
  rows: UsageRow[]
}

/** The CSV export input. */
export interface UsageCsvInput {
  series: readonly DirectSeries[]
  window: UsageWindow
  model?: string
  key?: string
  generatedAt: number
}

/** The CSV export result. */
export interface UsageCsv {
  filename: string
  csv: string
  rows: number
}

/** Whether `value` is a plain record (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Coerce a numeric-ish field to a finite number (or `0`). */
function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/** Coerce a field to a string (or `''`). */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** A readable reason for a thrown value. */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The epoch-second start of the UTC+8 calendar day containing `sec`. */
export function utc8DayStart(sec: number): number {
  return Math.floor((sec + PLATFORM_TZ) / 86_400) * 86_400 - PLATFORM_TZ
}

/** The `YYYY-MM-DD` label of the UTC+8 calendar day containing `sec`. */
export function utc8Day(sec: number): string {
  return new Date((sec + PLATFORM_TZ) * 1000).toISOString().slice(0, 10)
}

/** The epoch-second start of the UTC+8 calendar month containing `sec`. */
export function utc8MonthStart(sec: number): number {
  const shifted = new Date((sec + PLATFORM_TZ) * 1000)
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) / 1000 - PLATFORM_TZ
}

/** The requested window and the base-reading union it is cut from. */
export function rangeOf(nowMs: number, days: number): UsageRange {
  const nowSec = Math.floor(nowMs / 1000)
  const endSec = utc8DayStart(nowSec) + 86_400
  const startSec = endSec - days * 86_400
  const monthStartSec = utc8MonthStart(endSec - 1)
  return {
    days,
    start: utc8Day(startSec),
    end: utc8Day(endSec - 1),
    startSec,
    endSec,
    baseStartSec: Math.min(endSec - BASE_DAYS * 86_400, monthStartSec),
    monthStartSec,
  }
}

/** Every `YYYY-MM-DD` date from `start` through `end`, inclusive. */
export function dateRange(start: string, end: string): string[] {
  const dates: string[] = []
  const startMs = Date.parse(`${start}T00:00:00.000Z`)
  const endMs = Date.parse(`${end}T00:00:00.000Z`)
  for (let ms = startMs; ms <= endMs; ms += 86_400_000) dates.push(new Date(ms).toISOString().slice(0, 10))
  return dates
}

/** Whether one date falls inside an inclusive range. */
function within(date: string, start: string, end: string): boolean {
  return date >= start && date <= end
}

/** The DeepSeek platform usage endpoint for one series and range. */
export function platformUsageUrl(kind: 'amount' | 'cost', start: number, end: number): string {
  return `${PLATFORM_BASE}/api/v0/usage/by_api_key/${kind}?start=${String(start)}&end=${String(end)}&tz=${String(PLATFORM_TZ)}`
}

/** The platform endpoint carrying the balance + cumulative spend. */
export function platformUserSummaryUrl(): string {
  return `${PLATFORM_BASE}/api/v0/users/get_user_summary`
}

/** The dashboard headers a usage request carries (the bearer token is added by the caller). */
export function usageHeaders(token: string): { accept: string; referer: string; 'user-agent': string; authorization: string } {
  return {
    accept: 'application/json',
    referer: `${PLATFORM_BASE}/usage`,
    'user-agent': 'application-harness-usage',
    authorization: `Bearer ${token}`,
  }
}

/** The platform `biz_data` object, throwing on a non-zero platform/biz code. */
function platformBizData(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('invalid DeepSeek platform usage response')
  const data = isRecord(value.data) ? value.data : {}
  const code = String(value.code ?? '')
  const bizCode = String(data.biz_code ?? '')
  if ((code !== '' && code !== '0') || (bizCode !== '' && bizCode !== '0')) {
    throw new Error('DeepSeek platform usage error')
  }
  return isRecord(data.biz_data) ? data.biz_data : {}
}

/** One endpoint's `series` array folded into per (api-key × model) daily series. */
function seriesOf(rawSeries: readonly unknown[], measureOf: (bucket: Record<string, unknown>) => UsageMeasurement): DirectSeries[] {
  const out: DirectSeries[] = []
  for (const candidate of rawSeries) {
    if (!isRecord(candidate)) continue
    const apiKey = isRecord(candidate.api_key) ? candidate.api_key : {}
    const daily: Record<string, UsageMeasurement> = {}
    for (const bucket of Array.isArray(candidate.buckets) ? candidate.buckets : []) {
      if (!isRecord(bucket)) continue
      const sec = num(bucket.time)
      if (sec <= 0) continue
      daily[utc8Day(sec)] = measureOf(bucket)
    }
    if (Object.keys(daily).length === 0) continue
    out.push({ apiKeyId: str(apiKey.tracking_id), apiKeyName: str(apiKey.name), model: str(candidate.model), daily })
  }
  return out
}

/**
 * Read a successful platform `cost` payload. The currencies only group the
 * series, so they are flattened; every bucket's `cost` is in CNY.
 * @param value - the JSON response body.
 * @returns the cost series (may be empty for an unexpected shape).
 */
export function parseCost(value: unknown): DirectSeries[] {
  const bizData = platformBizData(value)
  const currencies = Array.isArray(bizData.data) ? bizData.data : []
  const rawSeries = currencies
    .filter(isRecord)
    .flatMap(currency => (Array.isArray(currency.series) ? currency.series : []))
  return seriesOf(rawSeries, bucket => ({ cost: num(bucket.cost) }))
}

/**
 * Read a successful platform `amount` payload. The platform's token figure
 * excludes its `REQUEST` field (that field is the request count).
 * @param value - the JSON response body.
 * @returns the amount series (may be empty for an unexpected shape).
 */
export function parseAmount(value: unknown): DirectSeries[] {
  const bizData = platformBizData(value)
  const rawSeries = Array.isArray(bizData.series) ? bizData.series : []
  return seriesOf(rawSeries, (bucket) => {
    const usage = isRecord(bucket.usage) ? bucket.usage : {}
    return {
      requests: num(usage.REQUEST),
      tokens: num(usage.RESPONSE_TOKEN) + num(usage.PROMPT_CACHE_HIT_TOKEN) + num(usage.PROMPT_CACHE_MISS_TOKEN),
    }
  })
}

/**
 * Read the platform `get_user_summary` payload. Each figure is present only
 * when the payload actually carried it: a missing wallet is an unknown balance,
 * not a zero one.
 * @param value - the JSON response body.
 * @returns the balance and the all-time spend, each optional.
 */
export function parseUserSummary(value: unknown): { balance?: number; cumulativeCost?: number } {
  if (!isRecord(value)) return {}
  const data = isRecord(value.data) ? value.data : {}
  const bizData = isRecord(data.biz_data) ? data.biz_data : {}
  const wallet = Array.isArray(bizData.normal_wallets) ? bizData.normal_wallets[0] : undefined
  const totalCost = Array.isArray(bizData.total_costs) ? bizData.total_costs[0] : undefined
  return {
    ...(isRecord(wallet) && wallet.balance !== undefined && wallet.balance !== null ? { balance: num(wallet.balance) } : {}),
    ...(isRecord(totalCost) && totalCost.amount !== undefined && totalCost.amount !== null ? { cumulativeCost: num(totalCost.amount) } : {}),
  }
}

/**
 * Merge the amount + cost series into one per (api-key × model) series set.
 * A bucket both sides measured carries both measurements; a one-sided bucket
 * keeps only the side that reported it, never an invented zero.
 * @param cost - the parsed cost series.
 * @param amount - the parsed amount series.
 * @returns the merged, deduplicated series.
 */
export function mergeSeries(cost: readonly DirectSeries[], amount: readonly DirectSeries[]): DirectSeries[] {
  const by = new Map<string, DirectSeries>()
  const add = (series: DirectSeries): void => {
    const key = `${series.apiKeyId}\u0000${series.model}`
    let target = by.get(key)
    if (target === undefined) {
      target = { apiKeyId: series.apiKeyId, apiKeyName: series.apiKeyName, model: series.model, daily: {} }
      by.set(key, target)
    }
    for (const [date, measure] of Object.entries(series.daily)) {
      const current = target.daily[date] ?? (target.daily[date] = {})
      if (measure.cost !== undefined) current.cost = (current.cost ?? 0) + measure.cost
      if (measure.tokens !== undefined) current.tokens = (current.tokens ?? 0) + measure.tokens
      if (measure.requests !== undefined) current.requests = (current.requests ?? 0) + measure.requests
    }
  }
  for (const series of cost) add(series)
  for (const series of amount) add(series)
  return [...by.values()]
}

/** One series' measurements inside one inclusive range, or `undefined` when it has none. */
export function aggregateRange(daily: Record<string, UsageMeasurement>, start: string, end: string): UsageMeasurement | undefined {
  let seen = false
  const total: UsageMeasurement = {}
  for (const [date, measure] of Object.entries(daily)) {
    if (!within(date, start, end)) continue
    seen = true
    if (measure.cost !== undefined) total.cost = (total.cost ?? 0) + measure.cost
    if (measure.tokens !== undefined) total.tokens = (total.tokens ?? 0) + measure.tokens
    if (measure.requests !== undefined) total.requests = (total.requests ?? 0) + measure.requests
  }
  return seen ? total : undefined
}

/** The sum of one measurement across rows, or `undefined` when none measured it. */
function totalOf(rows: readonly UsageRow[], field: 'cost' | 'tokens' | 'requests'): number | undefined {
  let total: number | undefined
  for (const row of rows) {
    const value = row[field]
    if (value !== undefined) total = (total ?? 0) + value
  }
  return total
}

/** The cost sum over every series inside an inclusive date range. */
function costWithin(series: readonly DirectSeries[], start: string, end: string): number | undefined {
  let total: number | undefined
  for (const entry of series) {
    const measured = aggregateRange(entry.daily, start, end)
    if (measured?.cost !== undefined) total = (total ?? 0) + measured.cost
  }
  return total
}

/**
 * Cut one stored base reading into the requested window. The chart days, the
 * table rows, the six figures and the CSV all read this one projection, so the
 * 7/30 switch can never make two surfaces disagree.
 * @param data - the stored base reading.
 * @param days - the requested window (7 or 30).
 * @param nowMs - the clock the window is anchored to.
 * @returns the window's projection.
 */
export function projectUsage(data: UsageData, days: number, nowMs: number): UsageProjection {
  const range = rangeOf(nowMs, days)
  const dayTotals = new Map<string, UsageMeasurement>()
  const rows: UsageRow[] = []
  for (const series of data.series) {
    const total = aggregateRange(series.daily, range.start, range.end)
    if (total !== undefined) {
      rows.push({ model: series.model, keyId: series.apiKeyId, keyName: series.apiKeyName, ...total })
    }
    for (const [date, measure] of Object.entries(series.daily)) {
      if (!within(date, range.start, range.end)) continue
      const current = dayTotals.get(date) ?? {}
      if (measure.cost !== undefined) current.cost = (current.cost ?? 0) + measure.cost
      if (measure.tokens !== undefined) current.tokens = (current.tokens ?? 0) + measure.tokens
      if (measure.requests !== undefined) current.requests = (current.requests ?? 0) + measure.requests
      dayTotals.set(date, current)
    }
  }
  rows.sort((a, b) => a.model.localeCompare(b.model) || (a.keyName || a.keyId).localeCompare(b.keyName || b.keyId))
  const windowCost = totalOf(rows, 'cost')
  const windowTokens = totalOf(rows, 'tokens')
  const windowRequests = totalOf(rows, 'requests')
  const monthCost = costWithin(data.series, utc8Day(range.monthStartSec), range.end)
  return {
    window: { start: range.start, end: range.end, days },
    summary: {
      ...(data.balance === undefined ? {} : { balance: data.balance }),
      ...(data.cumulativeCost === undefined ? {} : { cumulativeCost: data.cumulativeCost }),
      ...(monthCost === undefined ? {} : { monthCost }),
      ...(windowCost === undefined ? {} : { windowCost }),
      ...(windowTokens === undefined ? {} : { windowTokens }),
      ...(windowRequests === undefined ? {} : { windowRequests }),
    },
    days: dateRange(range.start, range.end).map((date) => {
      const measure = dayTotals.get(date)
      return measure === undefined ? { date } : { date, ...measure }
    }),
    rows,
  }
}

/** Quote one CSV field when it carries a delimiter, quote or newline. */
function csvField(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value
}

/**
 * Serialize one window + filter as CSV. The file carries its own scope (window,
 * model, key, currency, generation time) so a saved file is self-describing;
 * untrusted model/key text is quoted, and total lines keep unmeasured
 * measurements empty instead of writing a zero nobody measured.
 * @param input - the stored series and the exact window/filter to export.
 * @returns the filename, the CSV text and the data-row count.
 */
export function usageCsv(input: UsageCsvInput): UsageCsv {
  const model = input.model ?? ''
  const key = input.key ?? ''
  const rows: string[][] = []
  let costKnown = false
  let tokensKnown = false
  let requestsKnown = false
  let totalCost = 0
  let totalTokens = 0
  let totalRequests = 0
  for (const series of input.series) {
    if (model !== '' && series.model !== model) continue
    if (key !== '' && series.apiKeyId !== key && series.apiKeyName !== key) continue
    for (const [date, measure] of Object.entries(series.daily)) {
      if (!within(date, input.window.start, input.window.end)) continue
      rows.push([
        date,
        series.model,
        series.apiKeyId,
        series.apiKeyName,
        measure.tokens === undefined ? '' : String(measure.tokens),
        measure.requests === undefined ? '' : String(measure.requests),
        measure.cost === undefined ? '' : measure.cost.toFixed(6),
      ])
      if (measure.cost !== undefined) { costKnown = true; totalCost += measure.cost }
      if (measure.tokens !== undefined) { tokensKnown = true; totalTokens += measure.tokens }
      if (measure.requests !== undefined) { requestsKnown = true; totalRequests += measure.requests }
    }
  }
  const sortKeyOf = (row: string[]): string => `${row[0]!}\u0000${row[1]!}\u0000${row[2]!}`
  rows.sort((a, b) => sortKeyOf(a).localeCompare(sortKeyOf(b)))
  const lines = [
    '# usage export',
    `# window,${csvField(input.window.start)},${csvField(input.window.end)}`,
    `# days,${String(input.window.days)}`,
    '# currency,CNY',
    `# model,${csvField(model === '' ? 'all' : model)}`,
    `# apiKey,${csvField(key === '' ? 'all' : key)}`,
    `# generated,${new Date(input.generatedAt).toISOString()}`,
    ['date', 'model', 'apiKeyId', 'apiKeyName', 'tokens', 'requests', 'costCNY'].join(','),
    ...rows.map(row => row.map(csvField).join(',')),
    [
      '# total', '', '', '',
      tokensKnown ? String(totalTokens) : '',
      requestsKnown ? String(totalRequests) : '',
      costKnown ? totalCost.toFixed(6) : '',
    ].map(csvField).join(','),
  ]
  return {
    filename: `usage-${input.window.start}-${input.window.end}.csv`,
    csv: `${lines.join('\r\n')}\r\n`,
    rows: rows.length,
  }
}

/** Map an HTTP status to one stable failure code. */
export function failureCodeOf(status: number): UsageFailureCode {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate-limited'
  return 'network-failed'
}
