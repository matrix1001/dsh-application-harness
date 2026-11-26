/**
 * Per-application model selection. The file stores only the user's fixed route
 * (provider + model); apps without an entry follow the platform's current
 * default. Values are validated on read and write and never grant model access.
 * @module @matrix1001/dsh-application-harness-host-bridge/models
 */
import { AppTableStore } from './app-table.ts'

/** One fixed model route. */
export interface AppModelSelection {
  readonly provider: string
  readonly model: string
}

/** Validate one stored selection. */
function selectionOf(value: unknown): AppModelSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('a model selection must be an object')
  const provider = (value as Record<string, unknown>).provider
  const model = (value as Record<string, unknown>).model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
    throw new Error('a model selection needs provider and model')
  }
  return { provider, model }
}

/**
 * The model-selection table.
 */
export class ModelSelectionStore {
  private readonly table: AppTableStore<AppModelSelection>

  constructor(path: string) {
    this.table = new AppTableStore(path, 'model-selection table', selectionOf)
  }

  /** Load the table, ignoring a missing file but never misreading a bad one. */
  async load(): Promise<void> {
    await this.table.load()
  }

  /** One application's fixed route, if any. */
  get(appId: string): AppModelSelection | undefined { return this.table.get(appId) }

  /** Replace or clear one application's route, then persist atomically. */
  async set(appId: string, selection: AppModelSelection | null): Promise<void> {
    const next = selection === null ? undefined : selectionOf(selection)
    await this.table.update(appId, () => next)
  }
}
