/**
 * The application persistence service (`ctx.applicationStore`). The durable
 * implementation is a per-application SQLite namespace (`dbPath`): documents
 * and keyed collections, one transaction per unit of work, no cross-app
 * access through the handle an application is given. A legacy JSON
 * `storePath` remains only for the scope-keyed KV migration window; new code
 * uses {@link AppStore.namespace}.
 *
 * The old scope-keyed `get`/`set` methods are the shared, unscoped KV face.
 * They are deliberately not the business-data path: their scopes are global to
 * the process, while a namespace is owned by one application. No HTTP or AI
 * exposure is attached to this service; applications read it through their own
 * capability-checked rows.
 * @module @matrix1001/dsh-application-harness-store
 */

import { readFile } from 'node:fs/promises'
import { SqliteDataStore, type DataStoreExport } from './sqlite-store.ts'
import { GatedStore } from './gated.ts'
export { GatedCollection, GatedStore, type StorageGate } from './gated.ts'
import { Service, type Context } from '@deepseek-ai/cordis'
import { isMissingFile, reasonOf, writeFileAtomic } from './atomic.ts'
import Schema from '@deepseek-ai/schemastery'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

declare module '@deepseek-ai/cordis' {
  // Optional on purpose (dsh-conformance 2026-09-23, batch 4): a composition may
  // omit this row (the keyless examples do), and every reader already treats
  // the absence as a real case — declaring it required made the merge say
  // something the compositions do not honour.
  interface Context { applicationStore?: AppStore }
}

/** The `ctx.applicationStore` service row's config. */
export interface AppStoreConfig {
  /** The legacy JSON file (deprecated; kept for the migration/fallback path). */
  storePath?: string
  /** The unified SQLite database path (absent = in-memory only). */
  dbPath?: string
  /** The old JSON blob to read during a migration window (never written). */
  legacyStorePath?: string
}

/** Why the persisted blob could not be used (a missing file is not a failure). */
export interface AppStoreFailure {
  /** `storage-corrupt` (unparseable/wrong shape) or `storage-unavailable` (read failed). */
  readonly code: 'storage-corrupt' | 'storage-unavailable'
  /** The readable reason. */
  readonly message: string
}

/**
 * A scope-keyed JSON KV: durable when `storePath` is configured, process memory
 * without one. `get(scope)` reads one key; `get()` reads the whole blob — a
 * **snapshot** of it, not the store's own object (see {@link AppStore.get}).
 * Writes are serialized so overlapping mutations never interleave a
 * partially-written file. Each write is an **atomic rewrite** through the shared
 * `writeFileAtomic` primitive: the blob goes to a unique sibling temp file
 * (`<path>.<pid>.<seq>.tmp`), is fsynced, then renamed over the path, so a crash
 * leaves the complete previous blob or the complete new one — never a torn
 * JSON file (readers of the path always see a consistent snapshot). A failed
 * write removes its own temp file and REJECTS the write that asked for it, so
 * no caller can report a save the disk did not take; the serialized queue still
 * moves on, so a later write is not lost with it. A missing file
 * loads empty; an unparseable/wrong-shape or unreadable file sets
 * {@link AppStore.loadFailure} and makes every read/write fail closed, so the
 * next save cannot replace bytes this process never understood. Two processes
 * pointed at one path are not serialized (last writer wins — the deployment
 * boundary in THREAT-MODEL).
 */
export class AppStore extends Service {
  /** The row config schema: validates the `app-store` row config before the plugin starts (fail loud). */
  static Config = Schema.object({
    storePath: Schema.string(),
    dbPath: Schema.string(),
    legacyStorePath: Schema.string(),
  })

  /** The persisted JSON file path (`undefined` = no persistence). */
  private readonly storePath: string | undefined
  /** The in-memory scope-keyed blob (the loaded/persisted value). */
  private data: Record<string, JsonValue> = {}
  /** Serializes complete mutations; only a successful write publishes its state. */
  private persistChain: Promise<void> = Promise.resolve()
  /** Every mutation waits for the initial persisted state. */
  private readonly loadPromise: Promise<void>
  /** Set when the legacy file exists but cannot be read/parsed; reads and writes then fail closed. */
  private failure: AppStoreFailure | undefined
  /** The unified SQLite core (also the in-memory namespace store when no file is configured). */
  private readonly core: SqliteDataStore
  /** Whether the deprecated JSON `storePath` is the backing store. */
  private readonly jsonMode: boolean
  /** The legacy JSON blob path, exposed to applications for a one-way import. */
  private readonly legacyStorePathValue: string | undefined

  /**
   * @param ctx - owning context (registers `store`).
   * @param config - the optional persistence file path.
   */
  constructor(ctx: Context, config: AppStoreConfig = {}) {
    super(ctx, 'applicationStore')
    this.storePath = config.storePath
    this.legacyStorePathValue = config.legacyStorePath
    this.jsonMode = config.dbPath === undefined && config.storePath !== undefined
    this.core = new SqliteDataStore(config.dbPath === undefined ? {} : { dbPath: config.dbPath })
    this.loadPromise = this.jsonMode ? this.load() : Promise.resolve()
  }

  /**
   * Resolves when the initial file load has settled. `load()` runs
   * fire-and-forget in the constructor, so a consumer that reads the store
   * synchronously (e.g. an application reading its persisted settings in its
   * own start) may observe the blob before it was loaded and silently fall
   * back to defaults — a boot race that drops persisted settings (see the
   * info-hub platform-token save/load loop). Await `ready` before reading.
   */
  get ready(): Promise<void> {
    return this.loadPromise
  }

  /**
   * Why the persisted blob is unusable, when it is. A missing file is not a
   * failure (first run); an unparseable/wrong-shape or unreadable file is.
   * Consumers that await {@link ready} can inspect this before reading.
   */
  get loadFailure(): AppStoreFailure | undefined {
    return this.failure
  }

  /** Where the old JSON blob lives, for an application's one-way import. */
  get legacyStorePath(): string | undefined {
    return this.legacyStorePathValue
  }

  /** The unified SQLite database path (undefined for the in-memory/test mode). */
  get dbPath(): string | undefined {
    return this.core.path
  }

  /**
   * One application's capability-gated scoped handle. The handle is the only
   * storage face an application receives; every query inside it is bound to
   * `appId` and checked against the application's `storage` capability before
   * it touches the namespace. The raw namespace is never re-exposed.
   * @param appId - the application id (the registry key).
   * @returns the gated handle; call `attach` in the application's start hook.
   */
  gatedNamespace(appId: string): GatedStore {
    return new GatedStore(this.core.namespace(appId))
  }

  /** Close the SQLite connection (row teardown and tests). */
  close(): void {
    this.core.close()
  }

  /** Snapshot the unified store for backup/export. */
  exportAll(): DataStoreExport {
    return this.core.exportAll()
  }

  /** Replace or merge an exported snapshot. */
  importAll(data: unknown, options: { mode?: 'replace' | 'merge' } = {}): { apps: number; documents: number; collections: number } {
    return this.core.importAll(data, options)
  }

  /** Copy a consistent SQLite snapshot to a new path. */
  backupTo(path: string): string {
    return this.core.backupTo(path)
  }

  /**
   * Read a stored scope (or the whole blob when no scope is given) as a
   * **snapshot**: a structured clone of the stored value, never the store's own
   * object. Editing the result in place changes the caller's copy and nothing
   * else; a consumer that means to change a scope writes it back through
   * `set`/`update`.
   * @param scope - the key to read; absent = the whole blob.
   * @returns a deep copy of the stored value, or `undefined` when absent/missing.
   */
  get<T = JsonValue>(scope?: string): T | undefined {
    if (!this.jsonMode) {
      const shared = this.core.namespace('__shared__')
      if (scope === undefined) {
        return Object.fromEntries(shared.documents.list().map(doc => [doc.scope, doc.value])) as T
      }
      return shared.documents.get<T>(scope)?.value
    }
    this.assertUsable()
    // Cloning on READ closes the aliasing hole this used to have: `get()`
    // handed back `this.data` itself, and `get(scope)` the very object `set`
    // was given, so a consumer's in-place edit silently rewrote the store —
    // kept by whatever write persisted next, or lost with the process, but
    // never intended. `structuredClone` rather than a JSON round-trip: the
    // stored value is a `JsonValue`, the JSON vocabulary, which is exactly
    // what the structured-clone algorithm is defined over, and it preserves an
    // `undefined` property that stringify/parse would drop. (`undefined` — a
    // missing scope — clones to `undefined`, so the absent case passes through.)
    const value = scope === undefined ? this.data : this.data[scope]
    return structuredClone(value) as T | undefined
  }

  /**
   * Write one scope then persist.
   * @param scope - the key to write.
   * @param value - the value to store.
   */
  async set(scope: string, value: JsonValue): Promise<void> {
    if (!this.jsonMode) {
      this.core.namespace('__shared__').documents.put(scope, structuredClone(value))
      return
    }
    const snapshot = structuredClone(value)
    return this.change(data => { data[scope] = snapshot })
  }

  /**
   * Read-modify-write one scope, then persist (atomic with respect to the blob).
   * @param scope - the key to update.
   * @param fn - the reducer over the current value (or `undefined`).
   */
  async update<T>(scope: string, fn: (current: T | undefined) => JsonValue): Promise<void> {
    if (!this.jsonMode) {
      const shared = this.core.namespace('__shared__')
      shared.transaction(() => {
        shared.documents.put(scope, structuredClone(fn(shared.documents.get<T>(scope)?.value)))
      })
      return
    }
    return this.change(data => { data[scope] = structuredClone(fn(data[scope] as T | undefined)) })
  }

  /**
   * Delete one scope (or clear the whole blob), then persist.
   * Like every mutation, it waits for the initial load and earlier writes.
   * @param scope - the key to delete; absent = clear everything.
   */
  async clear(scope?: string): Promise<void> {
    if (!this.jsonMode) {
      const shared = this.core.namespace('__shared__')
      if (scope === undefined) {
        for (const doc of shared.documents.list()) shared.documents.delete(doc.scope)
      } else {
        shared.documents.delete(scope)
      }
      return
    }
    return this.change(data => {
      if (scope === undefined) {
        for (const key of Object.keys(data)) delete data[key]
      } else {
        delete data[scope]
      }
    })
  }

  /**
   * Load the persisted blob before any queued mutation can run.
   */
  private async load(): Promise<void> {
    // Only `jsonMode` calls this, and that mode exists only when storePath is defined.
    const path = this.storePath!
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      // A missing file is the first run; every other read failure is not an
      // empty store. Keeping the failure (rather than loading {}) is what stops
      // the next write from replacing a file this process could not read.
      if (isMissingFile(error)) {
        this.data = {}
        return
      }
      this.failure = { code: 'storage-unavailable', message: reasonOf(error) }
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.failure = { code: 'storage-corrupt', message: reasonOf(error) }
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.failure = { code: 'storage-corrupt', message: 'the stored value is not a JSON object' }
      return
    }
    this.data = parsed as Record<string, JsonValue>
  }

  /** Refuse reads/writes when the persisted blob could not be loaded. */
  private assertUsable(): void {
    if (this.failure === undefined) return
    const error = new Error(`application store ${this.failure.code}: ${this.failure.message}`) as Error & { code: string }
    error.code = this.failure.code
    throw error
  }

  /**
   * Serialize a write. The returned promise is the CALLER's answer: it rejects
   * when this write did not reach the disk, so a caller that reports success has
   * a write behind it (the previous behaviour swallowed the failure after
   * logging it, and every caller above reported a save that never happened).
   * The queue itself survives a failure — the next write runs after this one
   * regardless, instead of being lost with it.
   */
  private change(mutate: (data: Record<string, JsonValue>) => void): Promise<void> {
    const write = this.persistChain.then(async () => {
      await this.loadPromise
      this.assertUsable()
      const next = structuredClone(this.data)
      mutate(next)
      if (this.storePath !== undefined) await writeFileAtomic(this.storePath, JSON.stringify(next))
      this.data = next
    })
    this.persistChain = write.then(() => undefined, () => undefined)
    return write
  }
}

export default AppStore
