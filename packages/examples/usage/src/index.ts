/**
 * The usage Cordis plugin: one row, one application, one gated SQLite
 * namespace. The repository is constructed here, with an optional injected
 * fetch/clock for tests, and its capability door is attached in the
 * application's start hook.
 * @module @matrix1001/dsh-application-harness-usage
 */

import type { Context } from '@deepseek-ai/cordis'
import { mountApplication } from '@matrix1001/dsh-application-harness-runtime'
import type {} from '@matrix1001/dsh-application-harness-store'
import { UsageDeclaration, UsageRepository, type UsageFetch, type UsageRepositoryOptions } from './app.ts'

/** The plugin name. */
export const name = 'usage'

/** Required runtime and storage services. */
export const inject = ['applications', 'applicationStore']

/** The injection seam a test host (or a custom deployment) may pass. */
export interface UsagePluginConfig {
  /** The HTTP transport; absent uses the host's global fetch. */
  fetch?: UsageFetch
  /** The clock; absent uses `Date.now`. */
  now?: () => number
  /** Per-request deadline; absent uses the repository default. */
  timeoutMs?: number
}

/**
 * Mount the application.
 * @param ctx - the host context.
 * @param config - optional transport/clock injection.
 */
export async function apply(ctx: Context, config: UsagePluginConfig = {}): Promise<void> {
  const store = ctx.applicationStore
  if (store === undefined) throw new Error('usage requires the application store (ctx.applicationStore)')
  const options: UsageRepositoryOptions = {
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    ...(config.now === undefined ? {} : { now: config.now }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  }
  const repository = new UsageRepository(store.gatedNamespace('usage'), options)
  await mountApplication(ctx, UsageDeclaration(repository))
}

export { UsageDeclaration, UsageRepository, UsageRequestError } from './app.ts'
export type {
  ExportUsageArgs,
  SetUsageSettingsArgs,
  UsageArgs,
  UsageDocument,
  UsageExport,
  UsageResult,
  UsageSettings,
  UsageSettingsView,
  UsageSnapshotRecord,
} from './app.ts'
