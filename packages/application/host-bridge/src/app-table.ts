/**
 * One versioned `{ apps: Record<appId, T> }` table with serialized writes.
 * The model-selection, usage and limits tables differ only in their value
 * parser; keeping the load/update/rollback protocol here makes their failure
 * behavior one implementation.
 * @module
 */

import { readVersionedJson, writeVersionedJson } from './platform-files.ts'

/** One per-application table, loaded once and written serially. */
export class AppTableStore<T> {
  private readonly entries = new Map<string, T>()
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param path - the versioned JSON file.
   * @param noun - the human-readable table name used in parse errors.
   * @param parse - validates one stored application value.
   */
  constructor(
    private readonly path: string,
    private readonly noun: string,
    private readonly parse: (value: unknown) => T,
  ) {}

  /** Load the table; a missing file is empty, a malformed one throws. */
  async load(): Promise<void> {
    const record = await readVersionedJson(this.path, 1, this.noun, (document) => {
      const apps = document.apps
      if (typeof apps !== 'object' || apps === null || Array.isArray(apps)) throw new Error(`the ${this.noun} needs an apps object`)
      const parsed: Record<string, T> = {}
      for (const [appId, value] of Object.entries(apps)) parsed[appId] = this.parse(value)
      return parsed
    })
    for (const [appId, value] of Object.entries(record ?? {})) this.entries.set(appId, value)
  }

  /** One application's value, if the table holds one. */
  get(appId: string): T | undefined {
    return this.entries.get(appId)
  }

  /**
   * Replace one application's value (or delete it with `undefined`) and persist.
   * Writes are serialized; a failed write restores the previous value.
   * @param appId - the application to update.
   * @param change - derives the next value from the current one.
   */
  async update(appId: string, change: (current: T | undefined) => T | undefined): Promise<void> {
    const run = async (): Promise<void> => {
      const previous = this.entries.get(appId)
      const next = change(previous)
      if (next === undefined) this.entries.delete(appId)
      else this.entries.set(appId, next)
      try {
        await writeVersionedJson(this.path, 1, { apps: Object.fromEntries(this.entries) })
      } catch (error) {
        if (previous === undefined) this.entries.delete(appId)
        else this.entries.set(appId, previous)
        throw error
      }
    }
    this.queue = this.queue.then(run, run)
    await this.queue
  }
}
