/**
 * Per-application model usage aggregates. Only counters, duration, the selected
 * model and known token usage are stored — never prompts, answers or provider
 * credentials. Missing usage is counted separately, never as zero.
 * @module @matrix1001/dsh-application-harness-host-bridge/usage
 */
import { AppTableStore } from './app-table.ts'
import type { ModelUsageSummary } from './types.ts'

/** One completed model call as the port reports it. */
export interface ModelUsageRecord {
  readonly status: 'success' | 'failed' | 'cancelled'
  readonly durationMs: number
  readonly model?: { readonly provider: string; readonly model: string }
  readonly inputTokens?: number
  readonly outputTokens?: number
}

/** An empty aggregate. */
export function emptyUsage(): ModelUsageSummary {
  return { calls: 0, succeeded: 0, failed: 0, cancelled: 0, usageMissing: 0, totalDurationMs: 0 }
}

/** Validate one stored aggregate. */
function summaryOf(value: unknown): ModelUsageSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('a model usage entry must be an object')
  const record = value as Record<string, unknown>
  for (const key of ['calls', 'succeeded', 'failed', 'cancelled', 'usageMissing', 'totalDurationMs'] as const) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key]) || (record[key] as number) < 0) throw new Error(`a model usage entry needs a non-negative ${key}`)
  }
  return record as unknown as ModelUsageSummary
}

/**
 * The usage table: loaded once, updated serially, written atomically.
 */
export class ModelUsageStore {
  private readonly table: AppTableStore<ModelUsageSummary>

  constructor(path: string) {
    this.table = new AppTableStore(path, 'model-usage table', summaryOf)
  }

  /** Load the table; a corrupt file is reported by the host and treated as empty. */
  async load(): Promise<void> {
    await this.table.load()
  }

  /** One application's aggregate (or the empty one). */
  get(appId: string): ModelUsageSummary { return this.table.get(appId) ?? emptyUsage() }

  /** Record one completed call and persist. */
  async record(appId: string, record: ModelUsageRecord): Promise<void> {
    const now = new Date().toISOString()
    await this.table.update(appId, (previous) => {
      const current = previous ?? emptyUsage()
      return {
        calls: current.calls + 1,
        succeeded: current.succeeded + (record.status === 'success' ? 1 : 0),
        failed: current.failed + (record.status === 'failed' ? 1 : 0),
        cancelled: current.cancelled + (record.status === 'cancelled' ? 1 : 0),
        usageMissing: current.usageMissing + (record.inputTokens === undefined && record.outputTokens === undefined ? 1 : 0),
        totalDurationMs: current.totalDurationMs + Math.max(0, Math.round(record.durationMs)),
        ...(current.inputTokens === undefined && current.outputTokens === undefined && record.inputTokens === undefined && record.outputTokens === undefined ? {} : {
          inputTokens: (current.inputTokens ?? 0) + (record.inputTokens ?? 0),
          outputTokens: (current.outputTokens ?? 0) + (record.outputTokens ?? 0),
        }),
        lastAt: now,
        lastStatus: record.status,
        ...(record.model === undefined ? (current.lastModel === undefined ? {} : { lastModel: current.lastModel }) : { lastModel: record.model }),
      }
    })
  }
}
