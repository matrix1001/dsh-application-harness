/**
 * The application persistence service (`ctx.applicationStore`). The durable
 * implementation is a per-application SQLite namespace (`dbPath`): documents
 * and keyed collections, one transaction per unit of work, no cross-app
 * access through the handle an application is given.
 *
 * This service is the host-side factory only: applications receive a
 * capability-gated {@link GatedStore}, never the database connection or another
 * application's namespace. No HTTP or AI exposure is attached to the service.
 * @module @matrix1001/dsh-application-harness-store
 */

import { SqliteDataStore, type DataStoreExport } from './sqlite-store.ts'
import { GatedStore } from './gated.ts'
export { GatedCollection, GatedStore, type StorageGate } from './gated.ts'
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  // Optional on purpose (dsh-conformance 2026-09-23, batch 4): a composition may
  // omit this row (the keyless examples do), and every reader already treats
  // the absence as a real case — declaring it required made the merge say
  // something the compositions do not honour.
  interface Context { applicationStore?: AppStore }
}

/** The `ctx.applicationStore` service row's config. */
export interface AppStoreConfig {
  /** The unified SQLite database path (absent = in-memory only). */
  dbPath?: string
}

/** The application persistence service. */
export class AppStore extends Service {
  /** The row config schema: validates the `app-store` row config before the plugin starts (fail loud). */
  static Config = Schema.object({
    dbPath: Schema.string(),
  })

  /** The unified SQLite core (also the in-memory namespace store when no file is configured). */
  private readonly core: SqliteDataStore

  /**
   * @param ctx - owning context (registers `applicationStore`).
   * @param config - the optional database path.
   */
  constructor(ctx: Context, config: AppStoreConfig = {}) {
    super(ctx, 'applicationStore')
    this.core = new SqliteDataStore(config.dbPath === undefined ? {} : { dbPath: config.dbPath })
  }

  /**
   * One capability-gated handle for an application row's declared namespace.
   *
   * This is the host-side factory `mountApplication` calls; an application
   * never receives the `AppStore` service as its data face. The runtime
   * validates that the requested namespace equals the declaration's unified
   * namespace and the application id before the handle can be attached, so a
   * row cannot open another application's partition through the documented
   * API.
   * @param namespace - the declared unified namespace (equal to the app id).
   * @returns the gated handle; the app attaches its capability door in start.
   */
  openForMount(namespace: string): GatedStore {
    return new GatedStore(this.core.namespace(namespace))
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


  /** Replace ONE application's namespace exactly (data restore). */
  replaceNamespace(namespace: string, app: DataStoreExport['apps'][string]): { documents: number; collections: number } {
    return this.core.replaceNamespace(namespace, app)
  }

  /** The database file size, when this store has a file. */
  byteSize(): number | undefined {
    return this.core.byteSize()
  }

  /** The unified SQLite database path (undefined for the in-memory/test mode). */
  get dbPath(): string | undefined {
    return this.core.path
  }
}

export default AppStore
