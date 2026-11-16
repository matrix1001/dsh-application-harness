/**
 * Per-application model selection. The file stores only the user's fixed route
 * (provider + model); apps without an entry follow the platform's current
 * default. Values are validated on read and write and never grant model access.
 * @module @matrix1001/dsh-application-harness-host-bridge/models
 */
import { existsSync } from 'node:fs'
import { readVersionedJson, writeVersionedJson } from './platform-files.ts'

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
  private readonly entries = new Map<string, AppModelSelection>()
  private queue: Promise<void> = Promise.resolve()
  private readonly path: string

  constructor(path: string) { this.path = path }

  /** Load the table, ignoring a missing file but never misreading a bad one. */
  async load(): Promise<void> {
    if (!existsSync(this.path)) return
    const record = await readVersionedJson(this.path, 1, 'model-selection table', (document) => {
      const apps = document.apps
      if (typeof apps !== 'object' || apps === null || Array.isArray(apps)) throw new Error('the model-selection table needs an apps object')
      const parsed: Record<string, AppModelSelection> = {}
      for (const [appId, value] of Object.entries(apps)) parsed[appId] = selectionOf(value)
      return parsed
    })
    /* v8 ignore next -- a file that disappears between the existence check and the read is treated as empty */
    for (const [appId, selection] of Object.entries(record ?? {})) this.entries.set(appId, selection)
  }

  /** One application's fixed route, if any. */
  get(appId: string): AppModelSelection | undefined { return this.entries.get(appId) }

  /** All fixed routes, for management display. */
  list(): Readonly<Record<string, AppModelSelection>> { return Object.fromEntries(this.entries) }

  /** Replace or clear one application's route, then persist atomically. */
  async set(appId: string, selection: AppModelSelection | null): Promise<void> {
    const next = selection === null ? undefined : selectionOf(selection)
    this.queue = this.queue.then(async () => {
      const previous = this.entries.get(appId)
      if (next === undefined) this.entries.delete(appId)
      else this.entries.set(appId, next)
      try {
        await writeVersionedJson(this.path, 1, { apps: this.list() })
      } catch (error) {
        if (previous === undefined) this.entries.delete(appId)
        else this.entries.set(appId, previous)
        throw error
      }
    })
    await this.queue
  }
}
