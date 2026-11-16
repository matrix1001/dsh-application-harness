/**
 * The DeepSeek usage application: one gated SQLite document holding the
 * settings and the last good base reading, plus the four operations the page
 * and the agent share.
 *
 * The platform token never enters the business document. It lives in the
 * host secret store (`ctx.secrets`, field `platformToken`) and is read only at
 * the moment of a request; `settings` reports whether it is set, never its
 * value. A successful read replaces the snapshot; a failed read keeps the old
 * one, marks it `stale`, and reports the failure — it never writes an empty
 * reading or a zero.
 * @module @matrix1001/dsh-application-harness-usage
 */

import { createHash } from 'node:crypto'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { AppContext, AppDeclaration, OperationContext } from '@matrix1001/dsh-application-harness-runtime'
import { GatedStore } from '@matrix1001/dsh-application-harness-store'
import {
  MAX_TTL_MS,
  USAGE_DEFAULT_PERIOD,
  USAGE_DEFAULT_TTL_MS,
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
  type Period,
  type UsageData,
  type UsageFailureCode,
  type UsageSummary,
  type UsageWindow,
} from './logic.ts'

/** The document's durable schema version. */
export const USAGE_SCHEMA_VERSION = 1
/** The application id (also its unified namespace). */
export const USAGE_APP_ID = 'usage'
/** The one secret field the declaration manages. */
export const USAGE_SECRET_FIELD = 'platformToken'
/** The platform capabilities the application needs. */
export const USAGE_CAPABILITIES: readonly string[] = ['storage', 'network']

/** The document's user-editable settings. */
export interface UsageSettings {
  period: Period
  cacheTtlMs: number
}

/** The settings view the `settings`/`setSettings` operations return (never the token itself). */
export interface UsageSettingsView extends UsageSettings {
  tokenSet: boolean
}

/** The most recent successful account reading. */
export interface UsageSnapshotRecord {
  fetchedAt: number
  /** SHA-256 of the token that produced this reading; a changed token invalidates it. */
  tokenHash: string
  /** Present only after a failed read kept this snapshot. */
  stale?: boolean
  data: UsageData
}

/** The whole durable document. */
export interface UsageDocument {
  schemaVersion: 1
  settings: UsageSettings
  snapshot?: UsageSnapshotRecord
}

/** What the page reads: a measurement, a stale old measurement, or one of the two non-measurement states. */
export interface UsageResult {
  status: 'ready' | 'stale' | 'unconfigured' | 'failed'
  configured: boolean
  period: Period
  fetchedAt?: number
  stale?: boolean
  code?: UsageFailureCode
  message?: string
  window: UsageWindow
  summary: UsageSummary
  days: Array<{ date: string; cost?: number; tokens?: number; requests?: number }>
  rows: Array<{ model: string; keyId: string; keyName: string; tokens?: number; requests?: number; cost?: number }>
}

/** One CSV export result. */
export interface UsageExport {
  filename: string
  csv: string
  rows: number
}

/** Arguments of the `usage` operation. */
export interface UsageArgs {
  days?: number
  refresh?: boolean
}

/** Arguments of the `exportUsage` operation. */
export interface ExportUsageArgs {
  days?: number
  model?: string
  key?: string
}

/** Arguments of the `setSettings` operation. */
export interface SetUsageSettingsArgs {
  platformToken?: string
  period?: number
  cacheTtlMs?: number
}

/** The slice of the operation/start context the repository actually uses. */
export type UsageCallContext = Pick<OperationContext, 'capabilities' | 'secrets' | 'notifyChanged' | 'signal'>

/** The minimal response surface the injected fetch must provide. */
export interface UsageHttpResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

/** The fetch seam (injected by tests and by the plugin's own host wiring). */
export type UsageFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<UsageHttpResponse>

/** Options the plugin and the tests use to make the repository deterministic. */
export interface UsageRepositoryOptions {
  fetch?: UsageFetch
  now?: () => number
  /** Per-request deadline; defaults to 20 seconds. */
  timeoutMs?: number
}

/** The default application-level deadline for one platform request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

/** The stable error one platform request/parse reports. */
export class UsageRequestError extends Error {
  readonly code: UsageFailureCode

  constructor(code: UsageFailureCode, message: string) {
    super(message)
    this.name = 'UsageRequestError'
    this.code = code
  }
}

/** The first-run document. */
function emptyDocument(): UsageDocument {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    settings: { period: USAGE_DEFAULT_PERIOD, cacheTtlMs: USAGE_DEFAULT_TTL_MS },
  }
}

/** The projection of a stored snapshot as the operation's result. */
function resultOf(snapshot: UsageSnapshotRecord, days: Period, now: number): UsageResult {
  const projection = projectUsage(snapshot.data, days, now)
  return {
    status: snapshot.stale === true ? 'stale' : 'ready',
    configured: true,
    period: days,
    fetchedAt: snapshot.fetchedAt,
    ...(snapshot.stale === true ? { stale: true } : {}),
    window: projection.window,
    summary: projection.summary,
    days: projection.days,
    rows: projection.rows,
  }
}

/** One of the two non-measurement results. */
function emptyResult(status: 'unconfigured' | 'failed', days: Period, range: ReturnType<typeof rangeOf>, configured: boolean): UsageResult {
  return {
    status,
    configured,
    period: days,
    window: { start: range.start, end: range.end, days },
    summary: {},
    days: [],
    rows: [],
  }
}

/** The usage repository: one document, one serialized writer, capability-gated. */
export class UsageRepository {
  private readonly store: GatedStore
  private readonly fetch: UsageFetch
  private readonly now: () => number
  private readonly timeoutMs: number
  private document: UsageDocument = emptyDocument()
  private revision: number | undefined
  private loaded = false
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param store - the application's own gated namespace.
   * @param options - the injected fetch and clock (production defaults are the host's own).
   */
  constructor(store: GatedStore, options: UsageRepositoryOptions = {}) {
    this.store = store
    this.fetch = options.fetch ?? (globalThis.fetch as unknown as UsageFetch)
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  /** Attach the application's capability door (the start hook). */
  attach(access: AppContext['capabilities']): void {
    this.store.attach(access)
  }

  /** Load the durable document if this process has not done so yet. */
  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  /** Load the durable document; a missing document is an empty first run. */
  async load(): Promise<void> {
    const stored = await this.store.documents.get<UsageDocument>('document')
    if (stored === undefined) {
      this.document = emptyDocument()
      this.revision = undefined
      this.loaded = true
      return
    }
    if (stored.value.schemaVersion !== USAGE_SCHEMA_VERSION) {
      throw new AppError('storage-corrupt', 'usage: unsupported document schema version')
    }
    this.document = stored.value
    this.revision = stored.revision
    this.loaded = true
  }

  /**
   * Read the requested window. A fresh snapshot answers without a request; an
   * explicit `refresh` always reads the account again. A failed read keeps the
   * previous snapshot and marks it stale; with no previous snapshot it reports
   * a failure and writes nothing.
   * @param args - the window day count and the explicit refresh flag.
   * @param ctx - the operation context (secrets, network door, notification).
   * @returns the measurement or its explicit state.
   */
  async usage(args: UsageArgs, ctx: UsageCallContext): Promise<UsageResult> {
    await this.ensureLoaded()
    const days = this.periodOf(args.days)
    const now = this.now()
    const range = rangeOf(now, days)
    const token = (await ctx.secrets.get(USAGE_SECRET_FIELD))?.trim() ?? ''
    if (token === '') return emptyResult('unconfigured', days, range, false)
    const tokenHash = tokenFingerprint(token)
    const storedSnapshot = this.document.snapshot
    // A reading belongs to the token that produced it. A token changed from
    // the management page (not through setSettings) must not serve or export
    // the previous account's numbers.
    const snapshot = storedSnapshot?.tokenHash === tokenHash ? storedSnapshot : undefined
    if (args.refresh !== true && snapshot !== undefined && now - snapshot.fetchedAt < this.document.settings.cacheTtlMs) {
      return resultOf(snapshot, days, now)
    }
    let data: UsageData
    try {
      data = await this.fetchData(token, range, ctx)
    } catch (error) {
      if (error instanceof AppError) throw error
      const code: UsageFailureCode = error instanceof UsageRequestError ? error.code : 'network-failed'
      const message = reasonOf(error)
      if (snapshot === undefined) return { ...emptyResult('failed', days, range, true), code, message }
      const staleSnapshot: UsageSnapshotRecord = { ...snapshot, stale: true }
      await this.write({ ...this.document, snapshot: staleSnapshot })
      ctx.notifyChanged()
      return { ...resultOf(staleSnapshot, days, now), code, message }
    }
    const next: UsageSnapshotRecord = { fetchedAt: now, tokenHash, data }
    await this.write({ ...this.document, snapshot: next })
    ctx.notifyChanged()
    return resultOf(next, days, now)
  }

  /**
   * Export the window and filter the page shows, from the snapshot already on
   * screen (never a fresh request, so the file cannot cover a moment the screen
   * never showed).
   * @param args - the window and the optional model/API-key filter.
   * @param ctx - the operation context (secrets only).
   * @returns the CSV file.
   */
  async exportUsage(args: ExportUsageArgs, ctx: UsageCallContext): Promise<UsageExport> {
    await this.ensureLoaded()
    const days = this.periodOf(args.days)
    const token = (await ctx.secrets.get(USAGE_SECRET_FIELD))?.trim() ?? ''
    if (token === '') throw new AppError('unconfigured', 'configure a DeepSeek platform token first')
    const snapshot = this.document.snapshot
    const tokenHash = tokenFingerprint(token)
    if (snapshot === undefined || snapshot.tokenHash !== tokenHash) {
      throw new AppError('no-data', 'read usage again after changing the platform token')
    }
    const range = rangeOf(this.now(), days)
    return usageCsv({
      series: snapshot.data.series,
      window: { start: range.start, end: range.end, days },
      model: args.model ?? '',
      key: args.key ?? '',
      generatedAt: this.now(),
    })
  }

  /** Read the settings view (never the token value). */
  async settings(ctx: UsageCallContext): Promise<UsageSettingsView> {
    await this.ensureLoaded()
    return { ...this.document.settings, tokenSet: await ctx.secrets.has(USAGE_SECRET_FIELD) }
  }

  /**
   * Write the settings and/or the platform token. An empty token clears it; an
   * absent token leaves it unchanged. The document only ever holds the period
   * and cache lifetime.
   * @param args - the fields to change.
   * @param ctx - the operation context (secrets, notification).
   * @returns the post-write settings view.
   */
  async setSettings(args: SetUsageSettingsArgs, ctx: UsageCallContext): Promise<UsageSettingsView> {
    await this.ensureLoaded()
    if (args.period !== undefined && args.period !== 7 && args.period !== 30) {
      throw new AppError('invalid-args', 'period must be 7 or 30')
    }
    if (args.cacheTtlMs !== undefined && (!Number.isInteger(args.cacheTtlMs) || args.cacheTtlMs < 0 || args.cacheTtlMs > MAX_TTL_MS)) {
      throw new AppError('invalid-args', `cacheTtlMs must be an integer between 0 and ${String(MAX_TTL_MS)}`)
    }
    let changed = false
    let clearSnapshot = false
    if (args.platformToken !== undefined) {
      const token = args.platformToken.trim()
      if (token === '') await ctx.secrets.delete(USAGE_SECRET_FIELD)
      else await ctx.secrets.set(USAGE_SECRET_FIELD, token)
      // A credential change is an account change: the previous account's
      // reading must not be served (or exported) under the new token.
      clearSnapshot = true
      changed = true
    }
    const settings: UsageSettings = { ...this.document.settings }
    if (args.period !== undefined) { settings.period = args.period; changed = true }
    if (args.cacheTtlMs !== undefined) { settings.cacheTtlMs = args.cacheTtlMs; changed = true }
    if (changed) {
      const next: UsageDocument = clearSnapshot
        ? { schemaVersion: USAGE_SCHEMA_VERSION, settings }
        : { ...this.document, settings }
      await this.write(next)
      ctx.notifyChanged()
    }
    return { ...settings, tokenSet: await ctx.secrets.has(USAGE_SECRET_FIELD) }
  }

  /** The requested window, validated to the two sizes the application exposes. */
  private periodOf(days: number | undefined): Period {
    if (days === undefined) return this.document.settings.period
    if (days === 7 || days === 30) return days
    throw new AppError('invalid-args', 'days must be 7 or 30')
  }

  /** Read all three platform endpoints and fold them into one base reading. */
  private async fetchData(token: string, range: ReturnType<typeof rangeOf>, ctx: UsageCallContext): Promise<UsageData> {
    const headers = usageHeaders(token)
    const [cost, amount, summary] = await Promise.all([
      this.requestJson(platformUsageUrl('cost', range.baseStartSec, range.endSec), headers, ctx),
      this.requestJson(platformUsageUrl('amount', range.baseStartSec, range.endSec), headers, ctx),
      this.requestJson(platformUserSummaryUrl(), headers, ctx),
    ])
    try {
      return { ...parseUserSummary(summary), series: mergeSeries(parseCost(cost), parseAmount(amount)) }
    } catch (error) {
      throw new UsageRequestError('invalid-response', reasonOf(error))
    }
  }

  /** GET one JSON endpoint through the application's `network` capability. */
  private async requestJson(url: string, headers: Record<string, string>, ctx: UsageCallContext): Promise<unknown> {
    return await ctx.capabilities.use('network', async () => {
      const timeout = AbortSignal.timeout(this.timeoutMs)
      const signal = AbortSignal.any([ctx.signal, timeout])
      let response
      try {
        response = await this.fetch(url, { headers, signal })
      } catch (error) {
        if (timeout.aborted) throw new UsageRequestError('network-failed', `DeepSeek platform request timed out after ${String(this.timeoutMs)}ms`)
        throw error
      }
      if (!response.ok) {
        throw new UsageRequestError(failureCodeOf(response.status), `DeepSeek platform request failed (HTTP ${String(response.status)})`)
      }
      try {
        return await response.json()
      } catch (error) {
        if (timeout.aborted) throw new UsageRequestError('network-failed', `DeepSeek platform request timed out after ${String(this.timeoutMs)}ms`)
        throw new UsageRequestError('invalid-response', reasonOf(error))
      }
    })
  }

  /** Persist the whole document (one serialized writer). */
  private async write(document: UsageDocument): Promise<void> {
    const pending = this.queue.then(async () => {
      const stored = await this.store.documents.put('document', document, {
        schemaVersion: USAGE_SCHEMA_VERSION,
        ...(this.revision === undefined ? {} : { expectedRevision: this.revision }),
      })
      this.document = stored.value
      this.revision = stored.revision
    })
    // A failed write must not poison the queue: the next write still runs and
    // reports its own result. The current caller still sees the rejection.
    /* v8 ignore next -- queue recovery after a rejected write; the rejection is rethrown below */
    this.queue = pending.then(() => undefined, () => undefined)
    await pending
  }
}

/** A string parameter in the declaration's DSL. */
/** A stable fingerprint of a platform token for snapshot ownership, never the token itself. */
function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

const str = (description: string) => ({ type: 'string' as const, description })
/** An integer parameter in the declaration's DSL. */
const int = (description: string) => ({ type: 'integer' as const, description })
/** A boolean parameter in the declaration's DSL. */
const bool = (description: string) => ({ type: 'boolean' as const, description })

/**
 * Build the usage declaration.
 * @param repository - the durable repository.
 * @returns the declaration the runtime registers.
 */
export function UsageDeclaration(repository: UsageRepository): AppDeclaration {
  return {
    id: USAGE_APP_ID,
    name: 'DeepSeek 用量',
    description: 'DeepSeek 账户余额、消费、Tokens 与请求。',
    version: '0.2.0-rc.1',
    generation: 2,
    data: {
      kind: 'unified',
      namespace: USAGE_APP_ID,
      schemaVersion: USAGE_SCHEMA_VERSION,
      secretFields: [USAGE_SECRET_FIELD],
    },
    capabilities: USAGE_CAPABILITIES,
    start: async (ctx) => { repository.attach(ctx.capabilities) },
    reload: async () => { await repository.load() },
    ops: {
      usage: {
        description: 'Read DeepSeek account usage for 7 or 30 days: the six figures, the daily cost series and the model × API-key table. A fresh snapshot is reused; refresh reads the platform again. A failed read keeps the old snapshot and marks it stale.',
        params: {
          days: int('Window days: 7 or 30 (default: the saved preference)'),
          refresh: bool('Read the platform again, bypassing the cache'),
        },
        result: { type: 'json', description: 'Usage window projection, stale snapshot, or an explicit unconfigured/failed state' },
        effect: 'read',
        exposure: { ai: 'open', peers: 'open' },
        execute: async (args, ctx) => await repository.usage(args as UsageArgs, ctx) as never,
      },
      exportUsage: {
        description: 'Export the current 7/30-day window, optionally filtered by model and API key, as CSV. Reads the snapshot already on screen; never fetches.',
        params: {
          days: int('Window days: 7 or 30 (default: the saved preference)'),
          model: str('Model filter'),
          key: str('API-key id or name filter'),
        },
        result: { type: 'json', description: 'CSV filename and text' },
        effect: 'read',
        exposure: { ai: 'closed', peers: 'closed' },
        execute: async (args, ctx) => await repository.exportUsage(args as ExportUsageArgs, ctx) as never,
      },
      settings: {
        description: 'Read the usage settings: the window preference and cache lifetime, and whether a platform token is set (never the token).',
        params: {},
        result: { type: 'json', description: 'Settings view with tokenSet' },
        effect: 'read',
        exposure: { ai: 'closed', peers: 'closed' },
        execute: async (_args, ctx) => await repository.settings(ctx) as never,
      },
      setSettings: {
        description: 'Write the usage settings and/or the platform token. An empty token clears it; an absent token leaves it unchanged. The token is stored in the host secret store, never in the business document.',
        params: {
          platformToken: str('DeepSeek platform userToken; empty clears it'),
          period: int('Window preference: 7 or 30'),
          cacheTtlMs: int('Snapshot cache lifetime in milliseconds (0..86400000)'),
        },
        result: { type: 'json', description: 'Settings view with tokenSet' },
        effect: 'write',
        exposure: { ai: 'closed', peers: 'closed' },
        execute: async (args, ctx) => await repository.setSettings(args as SetUsageSettingsArgs, ctx) as never,
      },
    },
  }
}
