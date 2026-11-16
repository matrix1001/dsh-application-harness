import { describe, expect, it } from 'vitest'
import {
  MAX_TTL_MS,
  USAGE_DEFAULT_PERIOD,
  USAGE_DEFAULT_TTL_MS,
  aggregateRange,
  dateRange,
  failureCodeOf,
  mergeSeries,
  parseAmount,
  parseCost,
  parseUserSummary,
  platformUsageUrl,
  platformUserSummaryUrl,
  projectUsage,
  rangeOf,
  reasonOf,
  usageCsv,
  usageHeaders,
  utc8Day,
  utc8DayStart,
  utc8MonthStart,
  type DirectSeries,
  type UsageData,
} from '../src/logic.ts'

/** 2026-11-05 12:00 in UTC+8. */
const NOW = Date.UTC(2026, 10, 5, 4, 0, 0)
const NOW_SEC = Math.floor(NOW / 1000)
const TODAY = utc8Day(NOW_SEC)
const YESTERDAY = utc8Day(NOW_SEC - 86_400)
const TEN_DAYS_AGO = utc8Day(NOW_SEC - 10 * 86_400)

function costPayload(series: unknown[]): unknown {
  return { code: '0', data: { biz_code: '0', biz_data: { data: [{ currency: 'CNY', series }] } } }
}

function amountPayload(series: unknown[]): unknown {
  return { code: '0', data: { biz_code: '0', biz_data: { series } } }
}

function series(overrides: Partial<DirectSeries> = {}): DirectSeries {
  return { apiKeyId: 'k1', apiKeyName: 'prod', model: 'deepseek-chat', daily: {}, ...overrides }
}

describe('time and window arithmetic', () => {
  it('maps instants to UTC+8 days, day starts and month starts', () => {
    expect(utc8Day(NOW_SEC)).toBe(TODAY)
    expect(utc8DayStart(NOW_SEC)).toBe(Date.UTC(2026, 10, 4, 16, 0, 0) / 1000)
    expect(utc8Day(utc8MonthStart(NOW_SEC))).toBe('2026-11-01')
  })

  it('builds the requested window and the wider base reading', () => {
    const seven = rangeOf(NOW, 7)
    const thirty = rangeOf(NOW, 30)
    expect(seven).toMatchObject({ start: '2026-10-30', end: TODAY, days: 7 })
    expect(thirty.start).toBe('2026-10-07')
    expect(seven.baseStartSec).toBe(thirty.startSec)
    expect(utc8Day(seven.monthStartSec)).toBe('2026-11-01')
    expect(seven.endSec - seven.startSec).toBe(7 * 86_400)
  })

  it('lists an inclusive date range', () => {
    expect(dateRange('2026-10-30', '2026-11-05')).toHaveLength(7)
    expect(dateRange('2026-11-05', '2026-11-05')).toEqual([TODAY])
  })

  it('builds the platform URLs and headers', () => {
    expect(platformUsageUrl('cost', 10, 20)).toBe('https://platform.deepseek.com/api/v0/usage/by_api_key/cost?start=10&end=20&tz=28800')
    expect(platformUserSummaryUrl()).toBe('https://platform.deepseek.com/api/v0/users/get_user_summary')
    expect(usageHeaders('token')).toEqual({
      accept: 'application/json',
      referer: 'https://platform.deepseek.com/usage',
      'user-agent': 'application-harness-usage',
      authorization: 'Bearer token',
    })
  })
})

describe('platform parsers', () => {
  it('parses the cost series and skips malformed members', () => {
    const payload = costPayload([
      'not-a-series',
      { model: 'no-key', buckets: [{ time: NOW_SEC, cost: 1 }] },
      { api_key: { tracking_id: 'x' }, model: 'no-buckets' },
      {
        api_key: { tracking_id: 'k1', name: 'prod' },
        model: 'deepseek-chat',
        buckets: [
          { time: NOW_SEC, cost: 1.5 },
          { time: NOW_SEC - 86_400, cost: '2.25' },
          { time: NOW_SEC - 2 * 86_400, cost: 'not-a-number' },
          { time: 0, cost: 99 },
          'not-a-bucket',
        ],
      },
      { api_key: { tracking_id: 'k2' }, model: 7, buckets: [] },
    ])
    const parsed = parseCost(payload)
    expect(parsed).toHaveLength(2)
    const chat = parsed.find(entry => entry.apiKeyId === 'k1')!
    expect(chat).toMatchObject({ apiKeyName: 'prod', model: 'deepseek-chat' })
    expect(chat.daily[TODAY]).toEqual({ cost: 1.5 })
    expect(chat.daily[YESTERDAY]).toEqual({ cost: 2.25 })
    expect(chat.daily[utc8Day(NOW_SEC - 2 * 86_400)]).toEqual({ cost: 0 })
    expect(parsed.find(entry => entry.apiKeyId === '')).toMatchObject({ apiKeyName: '', model: 'no-key' })
  })

  it('flattens currencies and tolerates a missing data array', () => {
    expect(parseCost({ code: '0', data: { biz_code: '0', biz_data: { data: [null, {}, { series: [] }] } } })).toEqual([])
    expect(parseCost({ code: '0', data: { biz_code: '0', biz_data: {} } })).toEqual([])
    expect(parseCost({ code: 0, data: { biz_code: 0, biz_data: {} } })).toEqual([])
    expect(parseCost({ data: { biz_code: '0', biz_data: {} } })).toEqual([])
    expect(parseCost({ code: '0', data: { biz_code: '0' } })).toEqual([])
  })

  it('rejects malformed roots and non-zero platform codes', () => {
    expect(() => parseCost(null)).toThrow('invalid DeepSeek platform usage response')
    expect(() => parseCost({ code: '40002' })).toThrow('DeepSeek platform usage error')
    expect(() => parseCost({ code: '0', data: { biz_code: '40003' } })).toThrow('DeepSeek platform usage error')
  })

  it('parses the amount series (tokens exclude REQUEST)', () => {
    const payload = amountPayload([
      {
        api_key: { tracking_id: 'k1', name: 'prod' },
        model: 'deepseek-chat',
        buckets: [{
          time: NOW_SEC,
          usage: { REQUEST: 2, RESPONSE_TOKEN: 100, PROMPT_CACHE_HIT_TOKEN: 20, PROMPT_CACHE_MISS_TOKEN: 30 },
        }],
      },
      { model: 'no-usage', buckets: [{ time: NOW_SEC }] },
      { model: 'empty', buckets: [] },
    ])
    const parsed = parseAmount(payload)
    expect(parsed[0]!.daily[TODAY]).toEqual({ requests: 2, tokens: 150 })
    expect(parsed[1]!.daily[TODAY]).toEqual({ requests: 0, tokens: 0 })
    expect(parseAmount({ code: '0', data: { biz_code: '0', biz_data: {} } })).toEqual([])
  })

  it('reads the balance and cumulative spend only when present', () => {
    expect(parseUserSummary({
      data: { biz_data: { normal_wallets: [{ balance: '42.80' }], total_costs: [{ amount: 1286.4 }] } },
    })).toEqual({ balance: 42.8, cumulativeCost: 1286.4 })
    expect(parseUserSummary({ data: { biz_data: { normal_wallets: [], total_costs: [] } } })).toEqual({})
    expect(parseUserSummary({ data: { biz_data: { normal_wallets: [{ balance: null }], total_costs: [{ amount: null }] } } })).toEqual({})
    expect(parseUserSummary({ data: { biz_data: { normal_wallets: [null], total_costs: [null] } } })).toEqual({})
    expect(parseUserSummary({ data: {} })).toEqual({})
    expect(parseUserSummary(null)).toEqual({})
  })

  it('merges amount and cost series without inventing a measurement', () => {
    const cost: DirectSeries[] = [
      series({ daily: { [TODAY]: { cost: 1.5 } } }),
      series({ daily: { [YESTERDAY]: { cost: 2 } } }),
    ]
    const amount: DirectSeries[] = [
      series({ daily: { [TODAY]: { tokens: 150, requests: 2 }, [YESTERDAY]: { tokens: 10 } } }),
      series({ apiKeyId: 'k2', apiKeyName: 'test', daily: { [TODAY]: { tokens: 300, requests: 4 } } }),
    ]
    const merged = mergeSeries(cost, amount)
    expect(merged).toHaveLength(2)
    expect(merged[0]!.daily[TODAY]).toEqual({ cost: 1.5, tokens: 150, requests: 2 })
    expect(merged[0]!.daily[YESTERDAY]).toEqual({ cost: 2, tokens: 10 })
    expect(merged[1]).toMatchObject({ apiKeyId: 'k2', daily: { [TODAY]: { tokens: 300, requests: 4 } } })
  })

  it('aggregates only the requested range', () => {
    const daily = { [TODAY]: { cost: 1, tokens: 2, requests: 3 }, [YESTERDAY]: { cost: 4 } }
    expect(aggregateRange(daily, TODAY, TODAY)).toEqual({ cost: 1, tokens: 2, requests: 3 })
    expect(aggregateRange(daily, YESTERDAY, TODAY)).toEqual({ cost: 5, tokens: 2, requests: 3 })
    expect(aggregateRange(daily, '2026-01-01', '2026-01-02')).toBeUndefined()
  })
})

describe('window projection', () => {
  const data: UsageData = {
    series: [
      series({ daily: { [TODAY]: { cost: 1.5, tokens: 150, requests: 2 }, [TEN_DAYS_AGO]: { cost: 2.5, tokens: 50, requests: 1 } } }),
      series({ apiKeyId: 'k2', apiKeyName: 'test', model: 'deepseek-reasoner', daily: { [TODAY]: { cost: 3, tokens: 400, requests: 5 } } }),
      series({ apiKeyId: 'k3', apiKeyName: 'old', model: 'deepseek-chat', daily: { '2026-01-01': { cost: 99 } } }),
    ],
  }

  it('cuts the six figures, days and rows for a window', () => {
    const seven = projectUsage(data, 7, NOW)
    expect(seven.window).toEqual({ start: '2026-10-30', end: TODAY, days: 7 })
    expect(seven.summary).toEqual({ monthCost: 4.5, windowCost: 4.5, windowTokens: 550, windowRequests: 7 })
    expect(seven.days).toHaveLength(7)
    expect(seven.days.at(-1)).toEqual({ date: TODAY, cost: 4.5, tokens: 550, requests: 7 })
    expect(seven.rows).toEqual([
      { model: 'deepseek-chat', keyId: 'k1', keyName: 'prod', cost: 1.5, tokens: 150, requests: 2 },
      { model: 'deepseek-reasoner', keyId: 'k2', keyName: 'test', cost: 3, tokens: 400, requests: 5 },
    ])
  })

  it('projects the wider window and carries an unmeasured summary through as absent', () => {
    const thirty = projectUsage({ ...data, balance: 42.8, cumulativeCost: 1286.4 }, 30, NOW)
    expect(thirty.summary).toEqual({
      balance: 42.8,
      cumulativeCost: 1286.4,
      monthCost: 4.5,
      windowCost: 7,
      windowTokens: 600,
      windowRequests: 8,
    })
    expect(thirty.days.find(day => day.date === TEN_DAYS_AGO)).toEqual({ date: TEN_DAYS_AGO, cost: 2.5, tokens: 50, requests: 1 })
  })

  it('returns absent totals for an empty reading', () => {
    const empty = projectUsage({ series: [] }, 7, NOW)
    expect(empty.summary).toEqual({})
    expect(empty.rows).toEqual([])
    expect(empty.days.every(day => Object.keys(day).length === 1)).toBe(true)
  })

  it('keeps a one-measurement bucket partial and sorts the same model by key', () => {
    const partial = projectUsage({
      series: [
        series({ apiKeyId: 'b', apiKeyName: '', daily: { [TODAY]: { cost: 1 } } }),
        series({ apiKeyId: 'a', apiKeyName: '', daily: { [TODAY]: { tokens: 2 } } }),
      ],
    }, 7, NOW)
    expect(partial.summary).toEqual({ monthCost: 1, windowCost: 1, windowTokens: 2 })
    expect(partial.days.at(-1)).toEqual({ date: TODAY, cost: 1, tokens: 2 })
    expect(partial.rows.map(row => row.keyId)).toEqual(['a', 'b'])
  })
})

describe('CSV export', () => {
  const seriesList: DirectSeries[] = [
    series({
      model: 'deepseek,chat',
      daily: {
        [TODAY]: { cost: 1.5, tokens: 150, requests: 2 },
        [YESTERDAY]: { cost: 2, tokens: 60 },
      },
    }),
    series({ apiKeyId: 'k2', apiKeyName: 'test', model: 'deepseek-reasoner', daily: { [YESTERDAY]: { tokens: 400, requests: 5 } } }),
    series({ apiKeyId: 'k3', apiKeyName: 'old', model: 'deepseek-chat', daily: { '2026-01-01': { cost: 99 } } }),
  ]

  it('exports the current window and filter with a self-describing header', () => {
    const result = usageCsv({ series: seriesList, window: { start: '2026-10-30', end: TODAY, days: 7 }, generatedAt: NOW })
    expect(result.filename).toBe('usage-2026-10-30-2026-11-05.csv')
    expect(result.rows).toBe(3)
    expect(result.csv).toContain('# window,2026-10-30,2026-11-05')
    expect(result.csv).toContain('# days,7')
    expect(result.csv).toContain('# model,all')
    expect(result.csv).toContain('"deepseek,chat"')
    expect(result.csv).toContain(`${TODAY},"deepseek,chat",k1,prod,150,2,1.500000`)
    expect(result.csv).toContain('# total,,,,' + '610,7,3.500000')
  })

  it('filters by model/key and keeps unmeasured cells empty', () => {
    const byModel = usageCsv({ series: seriesList, window: { start: '2026-10-30', end: TODAY, days: 7 }, model: 'deepseek,chat', key: 'prod', generatedAt: NOW })
    expect(byModel.rows).toBe(2)
    expect(byModel.csv).not.toContain('deepseek-reasoner')

    const byKeyName = usageCsv({ series: seriesList, window: { start: '2026-10-30', end: TODAY, days: 7 }, key: 'test', generatedAt: NOW })
    expect(byKeyName.rows).toBe(1)
    expect(byKeyName.csv).toContain('deepseek-reasoner')

    const sparse = usageCsv({
      series: [series({ daily: { [TODAY]: {} } })],
      window: { start: '2026-10-30', end: TODAY, days: 7 },
      generatedAt: NOW,
    })
    expect(sparse.csv).toContain('# total,,,,,,')
  })
})

describe('failure helpers', () => {
  it('maps HTTP statuses to stable codes', () => {
    expect(failureCodeOf(401)).toBe('unauthorized')
    expect(failureCodeOf(403)).toBe('unauthorized')
    expect(failureCodeOf(429)).toBe('rate-limited')
    expect(failureCodeOf(500)).toBe('network-failed')
  })

  it('reads a reason from errors and primitives', () => {
    expect(reasonOf(new Error('boom'))).toBe('boom')
    expect(reasonOf('plain')).toBe('plain')
  })

  it('exposes the stable defaults', () => {
    expect(USAGE_DEFAULT_PERIOD).toBe(7)
    expect(USAGE_DEFAULT_TTL_MS).toBe(300_000)
    expect(MAX_TTL_MS).toBe(86_400_000)
  })
})
