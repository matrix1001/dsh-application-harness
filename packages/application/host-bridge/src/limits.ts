/**
 * Per-application model limits: whether background calls are allowed and the
 * simple concurrency / per-minute call caps. Limits are enforced only at the
 * unified model entrance; they are not budgets, queues or retries.
 * @module @matrix1001/dsh-application-harness-host-bridge/limits
 */
import { AppTableStore } from './app-table.ts'
import type { ModelLimits } from './types.ts'

/** The stable error the model port surfaces when a limit refuses a call. */
export class ModelLimitError extends Error {
  readonly code = 'platform.model-limit-exceeded' as const
  constructor(message: string) {
    super(message)
    this.name = 'ModelLimitError'
  }
}

/** The default: background allowed, no caps. */
export function defaultLimits(): ModelLimits { return { background: true } }

/** Validate one stored limit row. */
function limitsOf(value: unknown): ModelLimits {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('a model limit entry must be an object')
  const record = value as Record<string, unknown>
  if (typeof record.background !== 'boolean') throw new Error('a model limit entry needs a background boolean')
  for (const key of ['maxConcurrent', 'maxCallsPerMinute'] as const) {
    const number = record[key]
    if (number !== undefined && (typeof number !== 'number' || !Number.isInteger(number) || number < 1)) throw new Error(`a model limit ${key} must be a positive integer`)
  }
  return record as unknown as ModelLimits
}

/** Persist one application's limits. */
export class ModelLimitStore {
  private readonly table: AppTableStore<ModelLimits>

  constructor(path: string) {
    this.table = new AppTableStore(path, 'model-limit table', limitsOf)
  }

  async load(): Promise<void> {
    await this.table.load()
  }

  get(appId: string): ModelLimits { return this.table.get(appId) ?? defaultLimits() }

  async set(appId: string, limits: ModelLimits): Promise<void> {
    const next = limitsOf(limits)
    await this.table.update(appId, () => next)
  }
}

/** The runtime counters one limit service keeps. */
export class ModelLimitGate {
  private readonly active = new Map<string, number>()
  private readonly starts = new Map<string, number[]>()

  /**
   * Acquire one call slot.
   * @param appId - the application.
   * @param background - whether the app marked the call as background work.
   * @param limits - the current limits.
   * @param now - clock injection for tests.
   * @returns the release function.
   */
  begin(appId: string, background: boolean, limits: ModelLimits, now = Date.now()): () => void {
    if (background && !limits.background) throw new ModelLimitError('background model calls are disabled for this application')
    const active = this.active.get(appId) ?? 0
    if (limits.maxConcurrent !== undefined && active >= limits.maxConcurrent) throw new ModelLimitError(`the application already has ${String(limits.maxConcurrent)} model calls in flight`)
    if (limits.maxCallsPerMinute !== undefined) {
      const window = (this.starts.get(appId) ?? []).filter(at => now - at < 60_000)
      if (window.length >= limits.maxCallsPerMinute) {
        this.starts.set(appId, window)
        throw new ModelLimitError(`the application already started ${String(limits.maxCallsPerMinute)} model calls this minute`)
      }
      window.push(now)
      this.starts.set(appId, window)
    }
    this.active.set(appId, active + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.active.set(appId, Math.max(0, this.active.get(appId)! - 1))
    }
  }
}
