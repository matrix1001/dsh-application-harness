/**
 * The usage application driven through the real {@link ApplicationRuntime}:
 * every case calls `runtime.call` exactly as the page and the agent do. The
 * transport and clock are injected (never the real network), so a refresh,
 * cache hit, failure and CSV export are deterministic.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ApplicationRuntime, type CallOutcome, type SecretStorePort } from '@matrix1001/dsh-application-harness-runtime'
import { AppStore } from '@matrix1001/dsh-application-harness-store'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import * as UsagePlugin from '../src/index.ts'
import {
  utc8Day,
  utc8DayStart,
  type DirectSeries,
  type UsageData,
} from '../src/logic.ts'
import type { UsageDocument, UsageExport, UsageFetch, UsageResult, UsageSettingsView } from '../src/app.ts'
import { USAGE_SCHEMA_VERSION } from '../src/app.ts'

/** 2026-11-05 12:00 in UTC+8 (the window's last day). */
const NOW = Date.UTC(2026, 10, 5, 4, 0, 0)
const NOW_SEC = Math.floor(NOW / 1000)
const TODAY = utc8Day(NOW_SEC)
const HUMAN = { kind: 'human' } as const
const AT = '2026-01-01T00:00:00.000Z'

/** The fake transport's state. */
interface FetchState {
  calls: Array<{ url: string; headers: Record<string, string> }>
  fail: 'none' | 'unauthorized' | 'rate-limited' | 'network' | 'string' | 'json' | 'malformed'
}

/** A mutable clock the case controls. */
interface Clock {
  now: () => number
  advance: (ms: number) => void
}

/** One mounted host. */
interface Host {
  ctx: Context
  runtime: ApplicationRuntime
  store: AppStore
  secrets: Map<string, string>
  clock: Clock
  fetch: FetchState
  call: (op: string, args?: Record<string, unknown>) => Promise<CallOutcome>
  dispose: () => Promise<void>
}

/** A secret store over one map (the runtime filters it through the declaration). */
function secretStore(initial?: string): { store: SecretStorePort; values: Map<string, string> } {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set('platformToken', initial)
  return {
    values,
    store: {
      names: async () => [...values.keys()],
      has: async (_appId, name) => values.has(name),
      get: async (_appId, name) => values.get(name),
      set: async (_appId, name, value) => { values.set(name, value) },
      delete: async (_appId, name) => values.delete(name),
    },
  }
}

/** The platform amount/cost/summary fixtures for the fixed clock. */
function payloads(): { cost: unknown; amount: unknown; summary: unknown } {
  const sec = utc8DayStart(NOW_SEC)
  const series = [
    {
      api_key: { tracking_id: 'k1', name: 'prod' },
      model: 'deepseek-chat',
      buckets: [
        { time: sec, cost: 1.5 },
        { time: sec - 10 * 86_400, cost: 2.5 },
      ],
    },
    {
      api_key: { tracking_id: 'k2', name: 'test' },
      model: 'deepseek-reasoner',
      buckets: [{ time: sec, cost: 3 }],
    },
  ]
  const amountSeries = [
    {
      api_key: { tracking_id: 'k1', name: 'prod' },
      model: 'deepseek-chat',
      buckets: [
        { time: sec, usage: { REQUEST: 2, RESPONSE_TOKEN: 100, PROMPT_CACHE_HIT_TOKEN: 20, PROMPT_CACHE_MISS_TOKEN: 30 } },
        { time: sec - 10 * 86_400, usage: { REQUEST: 1, RESPONSE_TOKEN: 50 } },
      ],
    },
    {
      api_key: { tracking_id: 'k2', name: 'test' },
      model: 'deepseek-reasoner',
      buckets: [{ time: sec, usage: { REQUEST: 5, RESPONSE_TOKEN: 400 } }],
    },
  ]
  return {
    cost: { code: '0', data: { biz_code: '0', biz_data: { data: [{ currency: 'CNY', series }] } } },
    amount: { code: '0', data: { biz_code: '0', biz_data: { series: amountSeries } } },
    summary: { code: '0', data: { biz_code: '0', biz_data: { normal_wallets: [{ balance: 42.8 }], total_costs: [{ amount: 1286.4 }] } } },
  }
}

/** The injected fetch: a URL switch over the fixtures, with a failure mode. */
function fakeFetch(state: FetchState): UsageFetch {
  return async (url, init) => {
    state.calls.push({ url, headers: init.headers })
    if (state.fail === 'network') throw new Error('offline')
    if (state.fail === 'string') throw 'offline-string'
    if (state.fail === 'unauthorized') return { ok: false, status: 401, json: async () => ({}) }
    if (state.fail === 'rate-limited') return { ok: false, status: 429, json: async () => ({}) }
    if (state.fail === 'malformed') return { ok: true, status: 200, json: async () => ({ code: '40002' }) }
    if (state.fail === 'json') return { ok: true, status: 200, json: async () => { throw new Error('bad json') } }
    const fixture = payloads()
    const body = url.includes('/cost') ? fixture.cost : url.includes('/amount') ? fixture.amount : fixture.summary
    return { ok: true, status: 200, json: async () => body }
  }
}

/** Mount the plugin on a real runtime and store. */
async function mount(options: {
  token?: string
  grants?: readonly string[]
  seed?: (store: AppStore) => Promise<void>
  plain?: boolean
  fetch?: UsageFetch
  timeoutMs?: number
} = {}): Promise<Host> {
  const ctx = new Context()
  const secret = secretStore(options.token)
  const runtime = new ApplicationRuntime({ secrets: secret.store })
  const store = new AppStore(ctx)
  ctx.reflect.provide('applications', runtime)
  let now = NOW
  const clock: Clock = { now: () => now, advance: (ms) => { now += ms } }
  const fetch: FetchState = { calls: [], fail: 'none' }
  for (const capability of options.grants ?? ['capability:storage', 'capability:network']) {
    await runtime.grant({ caller: { kind: 'app', appId: 'usage' }, capabilities: [capability], grantedAt: AT })
  }
  if (options.seed !== undefined) await options.seed(store)
  if (options.plain === true) await UsagePlugin.apply(ctx)
  else await UsagePlugin.apply(ctx, {
    fetch: options.fetch ?? fakeFetch(fetch),
    now: clock.now,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  for (let index = 0; index < 50; index += 1) {
    if (runtime.list().find(entry => entry.declaration.id === 'usage')?.status() === 'available') break
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  }
  return {
    ctx,
    runtime,
    store,
    secrets: secret.values,
    clock,
    fetch,
    call: async (op, args = {}) => await runtime.call(HUMAN, 'usage', op, args as JsonValue),
    dispose: async () => { store.close(); await ctx.fiber.dispose() },
  }
}

/** Assert an accepted call and return its value. */
function ok<T>(outcome: CallOutcome): T {
  if (outcome.status !== 'success') throw new Error(`expected an accepted call, got ${JSON.stringify(outcome)}`)
  return outcome.result as T
}

/** The stored document, when present. */
function documentOf(host: Host): UsageDocument | undefined {
  return host.store.exportAll().apps.usage?.documents.document?.value as UsageDocument | undefined
}

/** The stored series (for direct assertions about the parse result). */
function storedSeries(host: Host): DirectSeries[] {
  return (documentOf(host)?.snapshot?.data as UsageData).series
}

describe('usage application: settings and the missing token', () => {
  it('reports the defaults and stays offline without a token', async () => {
    const host = await mount({ plain: true })
    expect(ok<UsageSettingsView>(await host.call('settings'))).toEqual({ period: 7, cacheTtlMs: 300_000, tokenSet: false })
    const usage = ok<UsageResult>(await host.call('usage'))
    expect(usage).toMatchObject({ status: 'unconfigured', configured: false, period: 7, summary: {}, days: [], rows: [] })
    expect(host.fetch.calls).toHaveLength(0)
    expect(documentOf(host)).toBeUndefined()
    await host.dispose()
  })

  it('writes the period/cache settings and keeps the token out of the document', async () => {
    const host = await mount()
    const saved = ok<UsageSettingsView>(await host.call('setSettings', { platformToken: '  secret-token  ', period: 30, cacheTtlMs: 60_000 }))
    expect(saved).toEqual({ period: 30, cacheTtlMs: 60_000, tokenSet: true })
    const doc = documentOf(host)!
    expect(doc.settings).toEqual({ period: 30, cacheTtlMs: 60_000 })
    expect(JSON.stringify(doc)).not.toContain('secret-token')
    expect(host.secrets.get('platformToken')).toBe('secret-token')
    await host.runtime.reload('usage')

    const usage = ok<UsageResult>(await host.call('usage'))
    expect(usage.status).toBe('ready')
    expect(usage.period).toBe(30)
    expect(usage.configured).toBe(true)
    expect(usage.fetchedAt).toBe(NOW)
    expect(usage.summary).toEqual({ balance: 42.8, cumulativeCost: 1286.4, monthCost: 4.5, windowCost: 7, windowTokens: 600, windowRequests: 8 })
    expect(usage.days).toHaveLength(30)
    expect(usage.rows).toHaveLength(2)
    expect(host.fetch.calls).toHaveLength(3)
    expect(host.fetch.calls[0]!.url).toBe(`https://platform.deepseek.com/api/v0/usage/by_api_key/cost?start=${String(utc8DayStart(NOW_SEC) + 86_400 - 30 * 86_400)}&end=${String(utc8DayStart(NOW_SEC) + 86_400)}&tz=28800`)
    expect(host.fetch.calls.every(call => call.headers.authorization === 'Bearer secret-token')).toBe(true)
    expect(storedSeries(host)).toHaveLength(2)
    await host.dispose()
  })

  it('drops the previous reading when the token changes', async () => {
    const host = await mount({ token: 'token-123' })
    ok<UsageResult>(await host.call('usage'))
    expect(documentOf(host)?.snapshot).toBeDefined()
    ok<UsageSettingsView>(await host.call('setSettings', { platformToken: 'next-token' }))
    expect(documentOf(host)?.snapshot).toBeUndefined()
    ok<UsageResult>(await host.call('usage'))
    expect(host.fetch.calls.at(-1)?.headers.authorization).toBe('Bearer next-token')
    await host.dispose()
  })

  it('drops a snapshot when the token changes outside setSettings', async () => {
    const host = await mount({ token: 'token-123' })
    ok<UsageResult>(await host.call('usage'))
    host.secrets.set('platformToken', 'token-other')
    expect(await host.call('exportUsage')).toMatchObject({ status: 'failed', error: { code: 'app.no-data' } })
    ok<UsageResult>(await host.call('usage'))
    expect(host.fetch.calls.at(-1)?.headers.authorization).toBe('Bearer token-other')
    await host.dispose()
  })

  it('times out a hanging platform request', async () => {
    const hanging: UsageFetch = async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
    const host = await mount({ token: 'token-123', fetch: hanging, timeoutMs: 10 })
    expect(ok<UsageResult>(await host.call('usage'))).toMatchObject({ status: 'failed', code: 'network-failed' })
    await host.dispose()
  })

  it('applies the deadline while reading the response body', async () => {
    const bodyHangs: UsageFetch = async (_url, init) => ({
      ok: true,
      status: 200,
      json: async () => await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }),
    })
    const host = await mount({ token: 'token-123', fetch: bodyHangs, timeoutMs: 10 })
    expect(ok<UsageResult>(await host.call('usage'))).toMatchObject({ status: 'failed', code: 'network-failed' })
    await host.dispose()
  })

  it('clears the token and returns to the unconfigured state without a request', async () => {
    const host = await mount({ token: 'token-123' })
    expect(ok<UsageSettingsView>(await host.call('setSettings', { platformToken: '' }))).toMatchObject({ tokenSet: false })
    expect(host.secrets.has('platformToken')).toBe(false)
    const usage = ok<UsageResult>(await host.call('usage'))
    expect(usage.status).toBe('unconfigured')
    expect(host.fetch.calls).toHaveLength(0)
    await host.dispose()
  })

  it('rejects invalid settings and window arguments', async () => {
    const host = await mount()
    expect(await host.call('setSettings', { period: 31 })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await host.call('setSettings', { cacheTtlMs: -1 })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await host.call('setSettings', { cacheTtlMs: 86_400_001 })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await host.call('usage', { days: 10 })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await host.call('exportUsage', { days: 10 })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(ok<UsageSettingsView>(await host.call('setSettings', {}))).toEqual({ period: 7, cacheTtlMs: 300_000, tokenSet: false })
    await host.dispose()
  })
})

describe('usage application: cache and refresh', () => {
  it('serves a fresh snapshot, projects both windows and bypasses the cache only on refresh', async () => {
    const host = await mount({ token: 'token-123' })
    const first = ok<UsageResult>(await host.call('usage'))
    expect(first.period).toBe(7)
    expect(first.summary.windowCost).toBe(4.5)
    expect(host.fetch.calls).toHaveLength(3)

    const projected = ok<UsageResult>(await host.call('usage', { days: 30 }))
    expect(projected.summary.windowCost).toBe(7)
    expect(projected.days).toHaveLength(30)
    expect(host.fetch.calls).toHaveLength(3)

    const refreshed = ok<UsageResult>(await host.call('usage', { refresh: true }))
    expect(refreshed.fetchedAt).toBe(NOW)
    expect(host.fetch.calls).toHaveLength(6)

    host.clock.advance(300_000)
    ok<UsageResult>(await host.call('usage'))
    expect(host.fetch.calls).toHaveLength(9)

    host.clock.advance(1)
    ok<UsageResult>(await host.call('usage'))
    expect(host.fetch.calls).toHaveLength(9)

    host.clock.advance(300_000)
    ok<UsageResult>(await host.call('usage'))
    expect(host.fetch.calls).toHaveLength(12)
    await host.dispose()
  })
})

describe('usage application: failures', () => {
  it('keeps the last good snapshot, marks it stale and never writes zeros', async () => {
    const host = await mount({ token: 'token-123' })
    const first = ok<UsageResult>(await host.call('usage'))
    host.fetch.fail = 'unauthorized'
    const stale = ok<UsageResult>(await host.call('usage', { refresh: true }))
    expect(stale).toMatchObject({ status: 'stale', stale: true, configured: true, code: 'unauthorized', fetchedAt: first.fetchedAt })
    expect(stale.summary).toEqual(first.summary)
    expect(stale.days).toEqual(first.days)
    expect(stale.rows).toEqual(first.rows)
    expect(documentOf(host)?.snapshot?.stale).toBe(true)

    const calls = host.fetch.calls.length
    const cached = ok<UsageResult>(await host.call('usage'))
    expect(cached.status).toBe('stale')
    expect(cached.summary).toEqual(first.summary)
    expect(host.fetch.calls).toHaveLength(calls)

    host.fetch.fail = 'none'
    const recovered = ok<UsageResult>(await host.call('usage', { refresh: true }))
    expect(recovered.status).toBe('ready')
    expect(documentOf(host)?.snapshot?.stale).toBeUndefined()
    await host.dispose()
  })

  it('reports a failure without inventing a snapshot when there is none', async () => {
    const host = await mount({ token: 'token-123' })
    host.fetch.fail = 'network'
    expect(ok<UsageResult>(await host.call('usage'))).toMatchObject({ status: 'failed', code: 'network-failed', message: 'offline' })
    expect(documentOf(host)?.snapshot).toBeUndefined()
    host.fetch.fail = 'string'
    expect(ok<UsageResult>(await host.call('usage'))).toMatchObject({ status: 'failed', code: 'network-failed', message: 'offline-string' })
    host.fetch.fail = 'json'
    expect(ok<UsageResult>(await host.call('usage'))).toMatchObject({ status: 'failed', code: 'invalid-response' })
    host.fetch.fail = 'malformed'
    expect(ok<UsageResult>(await host.call('usage'))).toMatchObject({ status: 'failed', code: 'invalid-response' })
    host.fetch.fail = 'rate-limited'
    expect(ok<UsageResult>(await host.call('usage'))).toMatchObject({ status: 'failed', code: 'rate-limited' })
    await host.dispose()
  })

  it('propagates a capability refusal instead of marking the snapshot stale', async () => {
    const host = await mount({ token: 'token-123', grants: ['capability:storage'] })
    expect(await host.call('usage')).toMatchObject({ status: 'failed', error: { code: 'app.capability-not-approved' } })
    expect(documentOf(host)?.snapshot).toBeUndefined()
    await host.dispose()
  })

  it('refuses a corrupt stored document', async () => {
    const host = await mount({
      seed: async (store) => {
        const namespace = store.gatedNamespace('usage')
        namespace.attach({ use: async <T>(_name: 'storage', work: () => T | Promise<T>) => await work() })
        await namespace.documents.put('document', { schemaVersion: USAGE_SCHEMA_VERSION + 1 })
      },
    })
    expect(await host.call('settings')).toMatchObject({ status: 'failed', error: { code: 'app.storage-corrupt' } })
    await host.dispose()
  })
})

describe('usage application: CSV export', () => {
  it('exports the window and filter from the snapshot on screen', async () => {
    const host = await mount({ token: 'token-123' })
    ok<UsageResult>(await host.call('usage'))
    const result = ok<UsageExport>(await host.call('exportUsage', { days: 7, model: 'deepseek-chat', key: 'k1' }))
    expect(result.filename).toBe(`usage-2026-10-30-${TODAY}.csv`)
    expect(result.rows).toBe(1)
    expect(result.csv).toContain('# model,deepseek-chat')
    expect(result.csv).toContain('# apiKey,k1')
    expect(result.csv).toContain('deepseek-chat')
    expect(result.csv).not.toContain('deepseek-reasoner')
    expect(host.fetch.calls).toHaveLength(3)
    await host.dispose()
  })

  it('uses the saved period and requires a token and a snapshot', async () => {
    const noToken = await mount()
    expect(await noToken.call('exportUsage')).toMatchObject({ status: 'failed', error: { code: 'app.unconfigured' } })
    await noToken.dispose()

    const noData = await mount({ token: 'token-123' })
    expect(await noData.call('exportUsage')).toMatchObject({ status: 'failed', error: { code: 'app.no-data' } })
    await noData.dispose()

    const host = await mount({ token: 'token-123' })
    await host.call('setSettings', { period: 30 })
    ok<UsageResult>(await host.call('usage'))
    const result = ok<UsageExport>(await host.call('exportUsage'))
    expect(result.filename).toBe(`usage-2026-10-07-${TODAY}.csv`)
    await host.dispose()
  })
})

describe('usage application: declaration and plugin', () => {
  it('declares generation 2, the unified namespace, the secret field and both capabilities', async () => {
    const host = await mount()
    const entry = host.runtime.list().find(candidate => candidate.declaration.id === 'usage')!
    expect(entry.declaration).toMatchObject({
      generation: 2,
      data: { kind: 'unified', namespace: 'usage', schemaVersion: 1, secretFields: ['platformToken'] },
      capabilities: ['storage', 'network'],
    })
    expect(Object.keys(entry.declaration.ops)).toEqual(['usage', 'exportUsage', 'settings', 'setSettings'])
    await host.runtime.reload('usage')
    await host.dispose()
  })

  it('fails loudly without the application store', async () => {
    const ctx = new Context()
    const runtime = new ApplicationRuntime()
    ctx.reflect.provide('applications', runtime)
    await expect(UsagePlugin.apply(ctx)).rejects.toThrow('usage requires the application store')
  })
})
