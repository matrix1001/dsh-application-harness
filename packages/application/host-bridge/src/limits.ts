/**
 * Per-application model limits: whether background calls are allowed and the
 * simple concurrency / per-minute call caps. Limits are enforced only at the
 * unified model entrance; they are not budgets, queues or retries.
 * @module @matrix1001/dsh-application-harness-host-bridge/limits
 */
import { existsSync } from 'node:fs'
import { readVersionedJson, writeVersionedJson } from './platform-files.ts'
import type { ModelLimits } from './types.ts'

/** The stable error the model port surfaces when a limit refuses a call. */
export class ModelLimitError extends Error {
  readonly code = 'model-limit-exceeded' as const
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
  private readonly entries = new Map<string, ModelLimits>()
  private queue: Promise<void> = Promise.resolve()
  private readonly path: string
  constructor(path: string) { this.path = path }

  async load(): Promise<void> {
    if (!existsSync(this.path)) return
    const record = await readVersionedJson(this.path, 1, 'model-limit table', (document) => {
      const apps = document.apps
      if (typeof apps !== 'object' || apps === null || Array.isArray(apps)) throw new Error('the model-limit table needs an apps object')
      const parsed: Record<string, ModelLimits> = {}
      for (const [appId, value] of Object.entries(apps)) parsed[appId] = limitsOf(value)
      return parsed
    })
    /* v8 ignore next -- a disappearing file is treated as empty */
    for (const [appId, limits] of Object.entries(record ?? {})) this.entries.set(appId, limits)
  }

  get(appId: string): ModelLimits { return this.entries.get(appId) ?? defaultLimits() }

  async set(appId: string, limits: ModelLimits): Promise<void> {
    const next = limitsOf(limits)
    this.queue = this.queue.then(async () => {
      const previous = this.entries.get(appId)
      this.entries.set(appId, next)
      try {
        await writeVersionedJson(this.path, 1, { apps: Object.fromEntries(this.entries) })
      } catch (error) {
        if (previous === undefined) this.entries.delete(appId)
        else this.entries.set(appId, previous)
        throw error
      }
    })
    await this.queue
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
