/**
 * The unified application data store: one SQLite database holding every
 * application's JSON documents and keyed collections.
 *
 * The store is deliberately small and synchronous. `node:sqlite` is synchronous
 * by design, and the host's callers are either short application operations or
 * queue workers; keeping the transactional core synchronous makes a
 * read-modify-write a real transaction instead of a sequence of interleavable
 * promises. The public `AppStore` service is the async face over it.
 *
 * **Isolation is by namespace.** A namespace is the only handle an application
 * receives: every query is scoped by `app_id` in SQL, and there is no method
 * that can name another application's rows. That is a first-party trust
 * boundary, not a sandbox (the harness design says so); it prevents accidental
 * cross-app collisions and makes "which app owns this document" explicit.
 *
 * **Failure is closed.** A corrupt/unreadable database is preserved under a
 * `.corrupt-<timestamp>` sibling and the store refuses to open; it never
 * creates an empty database over bytes it did not understand.
 * @module @matrix1001/dsh-application-harness-store/sqlite-store
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

/** The database schema version this build writes (SQLite `user_version`). */
export const DATA_STORE_SCHEMA_VERSION = 1

/** Why a store operation failed, in the vocabulary the applications already use. */
export type StoreErrorCode = 'storage-corrupt' | 'storage-unavailable' | 'storage-conflict' | 'invalid-argument'

/** One store refusal with a stable code. */
export class StoreError extends Error {
  readonly code: StoreErrorCode

  constructor(code: StoreErrorCode, message: string) {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }
}

/** One stored document together with its concurrency/version facts. */
export interface StoredDocument<T = unknown> {
  value: T
  revision: number
  schemaVersion: number
  updatedAt: number
}

/** One collection row in insertion order. */
export interface CollectionItem<T = unknown> {
  key: string
  value: T
  seq: number
  updatedAt: number
}

/** One collection page; `next` is the cursor for the following page. */
export interface CollectionPage<T = unknown> {
  items: CollectionItem<T>[]
  next: string | undefined
  hasMore: boolean
}

/** Options for writing one document. */
export interface DocumentWriteOptions {
  /** Compare-and-swap against the current revision; a mismatch is `storage-conflict`. */
  expectedRevision?: number
  /** The document's own schema version (defaults to the existing value, else 1). */
  schemaVersion?: number
}

/** One document as the whole-namespace listing returns it (the scope is part of the row). */
export interface StoredDocumentEntry<T = unknown> extends StoredDocument<T> {
  scope: string
}

/** A document namespace: one value per scope. */
export interface AppDocumentStore {
  get<T = unknown>(scope: string): StoredDocument<T> | undefined
  put<T>(scope: string, value: T, options?: DocumentWriteOptions): StoredDocument<T>
  delete(scope: string, options?: { expectedRevision?: number }): boolean
  list(): StoredDocumentEntry[]
}

/** A keyed collection namespace: insertion-ordered, pageable rows. */
export interface AppCollectionStore {
  get<T = unknown>(key: string): CollectionItem<T> | undefined
  put<T>(key: string, value: T): CollectionItem<T>
  putMany(entries: readonly { key: string; value: unknown }[]): number
  delete(key: string): boolean
  clear(): number
  count(): number
  list<T = unknown>(query?: { limit?: number; after?: string; direction?: 'asc' | 'desc' }): CollectionPage<T>
}

/** One application's scoped handle. The only way application code reaches data. */
export interface AppNamespace {
  readonly appId: string
  readonly documents: AppDocumentStore
  readonly collections: {
    /** Open (or create) one named collection. */
    open(name: string): AppCollectionStore
  }
  readonly meta: {
    get(key: string): string | undefined
    set(key: string, value: string): void
    delete(key: string): boolean
  }
  /** Run a synchronous unit of work in one SQLite transaction. */
  transaction<T>(work: (tx: AppNamespace) => T): T
}

/** The shape `exportAll()` returns and `importAll()` accepts. */
export interface DataStoreExport {
  version: 1
  exportedAt: number
  apps: Record<string, {
    documents: Record<string, { schemaVersion: number; revision: number; value: unknown; updatedAt: number }>
    collections: Record<string, Array<{ key: string; seq: number; value: unknown; updatedAt: number }>>
    meta: Record<string, string>
  }>
}

/** The app-id/scope/collection vocabulary: no separators, no SQL surprises. */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._:-]*$/u

/** One database row. */
type Row = Record<string, unknown>

const textOf = (value: unknown): string => String(value)
const integer = (value: unknown): number => Number(value)

/** Names that would collide with Object.prototype when a map is a plain object. */
const RESERVED_NAMES = new Set(['__proto__', 'prototype', 'constructor'])

/** Validate a caller-supplied name before it reaches a bound parameter. */
function nameOf(value: string, what: string): string {
  if (!NAME.test(value)) throw new StoreError('invalid-argument', `${what} is not a valid store name: ${value}`)
  if (RESERVED_NAMES.has(value)) throw new StoreError('invalid-argument', `${what} uses a reserved name: ${value}`)
  return value
}

/** A collection key is arbitrary caller data (an entry identity), never SQL; bound parameters make that safe. */
function keyOf(value: string, what = 'collection key'): string {
  if (value === '') throw new StoreError('invalid-argument', `${what} is empty`)
  return value
}

/** Parse one JSON column; a broken row is a corrupt store, not an empty value. */
function jsonOf<T>(value: unknown): T {
  try {
    return JSON.parse(textOf(value)) as T
  } catch (error) {
    /* v8 ignore next -- JSON.parse always throws an Error */
    throw new StoreError('storage-corrupt', `a stored JSON value cannot be parsed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Serialize a JSON value; a non-JSON value is a caller error, never stored as `undefined`. */
function encode(value: unknown): string {
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(value)
  } catch (error) {
    /* v8 ignore next -- JSON.stringify always throws an Error */
    throw new StoreError('invalid-argument', `the value is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (encoded === undefined) throw new StoreError('invalid-argument', 'the value is not JSON serializable: undefined')
  return encoded
}

/** One app's scoped implementation over a shared connection. */
class Namespace implements AppNamespace {
  readonly documents: AppDocumentStore
  readonly collections: AppNamespace['collections']
  readonly meta: AppNamespace['meta']
  private readonly store: SqliteDataStore
  constructor(store: SqliteDataStore, readonly appId: string) {
    this.store = store
    this.documents = {
      get: <T>(scope: string): StoredDocument<T> | undefined => this.store.getDocument(this.appId, scope),
      put: <T>(scope: string, value: T, options?: DocumentWriteOptions): StoredDocument<T> => this.store.putDocument(this.appId, scope, value, options),
      delete: (scope: string, options?: { expectedRevision?: number }): boolean => this.store.deleteDocument(this.appId, scope, options),
      list: (): StoredDocumentEntry[] => this.store.listDocuments(this.appId),
    }
    const cache = new Map<string, AppCollectionStore>()
    const open = (name: string): AppCollectionStore => {
      const key = nameOf(name, 'collection name')
      let collection = cache.get(key)
      if (collection === undefined) {
        collection = {
          get: <T>(rowKey: string): CollectionItem<T> | undefined => this.store.getCollectionItem(this.appId, key, rowKey),
          put: <T>(rowKey: string, value: T): CollectionItem<T> => this.store.putCollectionItem(this.appId, key, rowKey, value),
          putMany: (entries): number => this.store.putCollectionItems(this.appId, key, entries),
          delete: (rowKey: string): boolean => this.store.deleteCollectionItem(this.appId, key, rowKey),
          clear: (): number => this.store.clearCollection(this.appId, key),
          count: (): number => this.store.countCollection(this.appId, key),
          list: <T>(query?: { limit?: number; after?: string; direction?: 'asc' | 'desc' }): CollectionPage<T> => this.store.listCollection<T>(this.appId, key, query),
        }
        cache.set(key, collection)
      }
      return collection
    }
    this.collections = Object.freeze({ open })
    this.meta = {
      get: (key: string): string | undefined => this.store.getMeta(this.appId, key),
      set: (key: string, value: string): void => { this.store.setMeta(this.appId, key, value) },
      delete: (key: string): boolean => this.store.deleteMeta(this.appId, key),
    }
  }

  transaction<T>(work: (tx: AppNamespace) => T): T {
    return this.store.transaction(() => work(this))
  }
}

/**
 * The SQLite core. One connection, one app namespace per application, one
 * transaction at a time (SQLite's own write lock; the host's row is a single
 * process writer, as the deployment boundary requires).
 */
export class SqliteDataStore {
  private readonly db: DatabaseSync
  private readonly dbPath: string | undefined
  private depth = 0
  private readonly clock: () => number

  /**
   * @param options - the database path (`:memory:` when absent) and the clock.
   */
  constructor(options: { dbPath?: string; now?: () => number } = {}) {
    this.dbPath = options.dbPath
    this.clock = options.now ?? Date.now
    if (this.dbPath !== undefined && this.dbPath !== ':memory:') mkdirSync(dirname(this.dbPath), { recursive: true })
    this.db = this.open()
  }

  /** The database path, or `undefined` for the in-memory test mode. */
  get path(): string | undefined {
    return this.dbPath
  }

  /** Open and validate the database; a failure preserves the original bytes. */
  private open(): DatabaseSync {
    let db: DatabaseSync
    try {
      db = new DatabaseSync(this.dbPath ?? ':memory:')
    } catch (error) {
      this.quarantine()
      /* v8 ignore next -- node:sqlite open failures are Errors */
      throw new StoreError('storage-unavailable', `cannot open the application database: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = FULL')
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('PRAGMA foreign_keys = ON')
      const check = db.prepare('PRAGMA quick_check').get() as Row | undefined
      /* v8 ignore next -- a database that fails quick_check cannot be constructed by this test suite */
      if (check !== undefined && textOf(Object.values(check)[0]) !== 'ok') {
        throw new StoreError('storage-corrupt', `the application database failed its integrity check: ${JSON.stringify(check)}`)
      }
      const version = integer((db.prepare('PRAGMA user_version').get() as Row | undefined)?.user_version)
      if (version > DATA_STORE_SCHEMA_VERSION) {
        throw new StoreError('storage-corrupt', `the application database schema ${version} is newer than this build (${DATA_STORE_SCHEMA_VERSION})`)
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_documents (
          app_id TEXT NOT NULL,
          scope TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (app_id, scope)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS app_collections (
          app_id TEXT NOT NULL,
          collection TEXT NOT NULL,
          key TEXT NOT NULL,
          seq INTEGER NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (app_id, collection, key)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS app_collections_order ON app_collections (app_id, collection, seq);
        CREATE TABLE IF NOT EXISTS app_meta (
          app_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (app_id, key)
        ) WITHOUT ROWID;
        PRAGMA user_version = ${DATA_STORE_SCHEMA_VERSION};
      `)
      return db
    } catch (error) {
      try { db.close() } catch { /* already unusable */ }
      this.quarantine()
      /* v8 ignore next -- the non-StoreError arm is a native SQLite failure, which is an Error */
      throw error instanceof StoreError
        ? error
        : new StoreError('storage-corrupt', `the application database cannot be prepared: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Preserve a database file this process refused to open. */
  private quarantine(): void {
    /* v8 ignore next -- called only after a file-backed open failed */
    if (this.dbPath === undefined || this.dbPath === ':memory:' || !existsSync(this.dbPath)) return
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    try { copyFileSync(this.dbPath, `${this.dbPath}.corrupt-${stamp}`) } catch { /* best effort */ }
  }

  /** Open one application's scoped handle. */
  namespace(appId: string): AppNamespace {
    return new Namespace(this, nameOf(appId, 'application id'))
  }

  /** Close the connection (tests and row teardown). */
  close(): void {
    if (this.depth !== 0) throw new StoreError('storage-conflict', 'cannot close the store inside a transaction')
    this.db.close()
  }

  /** The current document for one app/scope. */
  getDocument<T>(appId: string, scope: string): StoredDocument<T> | undefined {
    const row = this.db.prepare('SELECT schema_version, revision, value, updated_at FROM app_documents WHERE app_id = ? AND scope = ?').get(appId, keyOf(scope, 'document scope')) as Row | undefined
    if (row === undefined) return undefined
    return { value: jsonOf<T>(row.value), revision: integer(row.revision), schemaVersion: integer(row.schema_version), updatedAt: integer(row.updated_at) }
  }

  /** Write one document with optional compare-and-swap. */
  putDocument<T>(appId: string, scope: string, value: T, options: DocumentWriteOptions = {}): StoredDocument<T> {
    const key = keyOf(scope, 'document scope')
    return this.transaction(() => {
      const existing = this.getDocument<T>(appId, key)
      if (options.expectedRevision !== undefined && existing?.revision !== options.expectedRevision) {
        throw new StoreError('storage-conflict', `document ${appId}/${key} is at revision ${existing?.revision ?? 0}, not ${options.expectedRevision}`)
      }
      const revision = (existing?.revision ?? 0) + 1
      const schemaVersion = options.schemaVersion ?? existing?.schemaVersion ?? 1
      const updatedAt = this.clock()
      this.db.prepare(`
        INSERT INTO app_documents (app_id, scope, schema_version, revision, value, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(app_id, scope) DO UPDATE SET
          schema_version = excluded.schema_version, revision = excluded.revision,
          value = excluded.value, updated_at = excluded.updated_at
      `).run(appId, key, schemaVersion, revision, encode(value), updatedAt)
      return { value, revision, schemaVersion, updatedAt }
    })
  }

  /** Delete one document, optionally conditional. */
  deleteDocument(appId: string, scope: string, options: { expectedRevision?: number } = {}): boolean {
    const key = keyOf(scope, 'document scope')
    return this.transaction(() => {
      const existing = this.getDocument(appId, key)
      if (existing === undefined) return false
      if (options.expectedRevision !== undefined && existing.revision !== options.expectedRevision) {
        throw new StoreError('storage-conflict', `document ${appId}/${key} is at revision ${existing.revision}, not ${options.expectedRevision}`)
      }
      return this.db.prepare('DELETE FROM app_documents WHERE app_id = ? AND scope = ?').run(appId, key).changes > 0
    })
  }

  /** Every document of one app (export, migration, the legacy whole-blob read). */
  listDocuments(appId: string): StoredDocumentEntry[] {
    return (this.db.prepare('SELECT scope, schema_version, revision, value, updated_at FROM app_documents WHERE app_id = ? ORDER BY scope').all(appId) as Row[])
      .map(row => ({ scope: textOf(row.scope), ...this.getDocument(appId, textOf(row.scope))! }))
  }

  /** One collection row. */
  getCollectionItem<T>(appId: string, collection: string, key: string): CollectionItem<T> | undefined {
    const row = this.db.prepare('SELECT key, seq, value, updated_at FROM app_collections WHERE app_id = ? AND collection = ? AND key = ?')
      .get(appId, nameOf(collection, 'collection name'), keyOf(key)) as Row | undefined
    if (row === undefined) return undefined
    return { key: textOf(row.key), value: jsonOf<T>(row.value), seq: integer(row.seq), updatedAt: integer(row.updated_at) }
  }

  /** Insert or replace one collection row; an existing row keeps its sequence. */
  putCollectionItem<T>(appId: string, collection: string, key: string, value: T): CollectionItem<T> {
    return this.transaction(() => this.writeCollectionItem(appId, nameOf(collection, 'collection name'), keyOf(key), value))
  }

  /** Insert or replace many rows in ONE transaction. */
  putCollectionItems(appId: string, collection: string, entries: readonly { key: string; value: unknown }[]): number {
    return this.transaction(() => {
      let written = 0
      for (const entry of entries) {
        this.writeCollectionItem(appId, nameOf(collection, 'collection name'), keyOf(entry.key), entry.value)
        written += 1
      }
      return written
    })
  }

  /** The write half shared by `put` and `putMany` (already inside a transaction). */
  private writeCollectionItem<T>(appId: string, collection: string, key: string, value: T): CollectionItem<T> {
    const existing = this.getCollectionItem<T>(appId, collection, key)
    const seq = existing?.seq ?? (integer((this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS max FROM app_collections WHERE app_id = ? AND collection = ?').get(appId, collection) as Row).max) + 1)
    const updatedAt = this.clock()
    this.db.prepare(`
      INSERT INTO app_collections (app_id, collection, key, seq, value, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(app_id, collection, key) DO UPDATE SET
        value = excluded.value, updated_at = excluded.updated_at
    `).run(appId, collection, key, seq, encode(value), updatedAt)
    return { key, value, seq, updatedAt }
  }

  /** Delete one collection row. */
  deleteCollectionItem(appId: string, collection: string, key: string): boolean {
    return Number(this.db.prepare('DELETE FROM app_collections WHERE app_id = ? AND collection = ? AND key = ?')
      .run(appId, nameOf(collection, 'collection name'), keyOf(key)).changes) > 0
  }

  /** Remove every row of one collection; returns the number removed. */
  clearCollection(appId: string, collection: string): number {
    return Number(this.db.prepare('DELETE FROM app_collections WHERE app_id = ? AND collection = ?')
      .run(appId, nameOf(collection, 'collection name')).changes)
  }

  /** Count one collection's rows. */
  countCollection(appId: string, collection: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM app_collections WHERE app_id = ? AND collection = ?')
      .get(appId, nameOf(collection, 'collection name')) as Row
    return integer(row.n)
  }

  /** Page one collection in sequence order. */
  listCollection<T>(appId: string, collection: string, query: { limit?: number; after?: string; direction?: 'asc' | 'desc' } = {}): CollectionPage<T> {
    const direction = query.direction ?? 'desc'
    const limit = Math.max(1, Math.min(Math.floor(query.limit ?? 100), 1000))
    const after = query.after === undefined ? undefined : Number(query.after)
    const params: SQLInputValue[] = [appId, nameOf(collection, 'collection name')]
    let where = 'app_id = ? AND collection = ?'
    if (after !== undefined && Number.isFinite(after)) {
      where += direction === 'desc' ? ' AND seq < ?' : ' AND seq > ?'
      params.push(after)
    }
    params.push(limit + 1)
    const rows = this.db.prepare(`SELECT key, seq, value, updated_at FROM app_collections WHERE ${where} ORDER BY seq ${direction === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`).all(...params) as Row[]
    const page = rows.slice(0, limit)
    const items = page.map(row => ({ key: textOf(row.key), value: jsonOf<T>(row.value), seq: integer(row.seq), updatedAt: integer(row.updated_at) }))
    return { items, next: rows.length > limit ? String(items.at(-1)?.seq) : undefined, hasMore: rows.length > limit }
  }

  /** One app's metadata value (migration markers, exporters). */
  getMeta(appId: string, key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM app_meta WHERE app_id = ? AND key = ?').get(appId, keyOf(key, 'meta key')) as Row | undefined
    return row === undefined ? undefined : textOf(row.value)
  }

  /** Set one app metadata value. */
  setMeta(appId: string, key: string, value: string): void {
    this.db.prepare('INSERT INTO app_meta (app_id, key, value) VALUES (?, ?, ?) ON CONFLICT(app_id, key) DO UPDATE SET value = excluded.value')
      .run(appId, keyOf(key, 'meta key'), value)
  }

  /** Delete one app metadata value. */
  deleteMeta(appId: string, key: string): boolean {
    return this.db.prepare('DELETE FROM app_meta WHERE app_id = ? AND key = ?').run(appId, keyOf(key, 'meta key')).changes > 0
  }

  /** Run one synchronous unit of work inside `BEGIN IMMEDIATE`/`COMMIT`. */
  transaction<T>(work: () => T): T {
    if (this.depth > 0) return work()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth = 1
    try {
      const value = work()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* the original failure is the answer */ }
      throw error
    } finally {
      this.depth = 0
    }
  }

  /** Snapshot every row for export. */
  exportAll(): DataStoreExport {
    // A null prototype, not `{}`: `__proto__` is a valid store name and a
    // plain object would turn that row into the object's prototype (the row
    // silently disappears from JSON) or make `constructor` collide with
    // Object.prototype. The maps must be dictionaries, never prototypes.
    const apps: DataStoreExport['apps'] = Object.create(null) as DataStoreExport['apps']
    const ensure = (appId: string): DataStoreExport['apps'][string] => {
      apps[appId] ??= { documents: Object.create(null), collections: Object.create(null), meta: Object.create(null) }
      return apps[appId]!
    }
    for (const row of this.db.prepare('SELECT app_id, scope, schema_version, revision, value, updated_at FROM app_documents ORDER BY app_id, scope').all() as Row[]) {
      const documentAppId = textOf(row.app_id)
      ensure(documentAppId).documents[textOf(row.scope)] = {
        schemaVersion: integer(row.schema_version), revision: integer(row.revision),
        value: jsonOf(row.value), updatedAt: integer(row.updated_at),
      }
    }
    for (const row of this.db.prepare('SELECT app_id, collection, key, seq, value, updated_at FROM app_collections ORDER BY app_id, collection, seq').all() as Row[]) {
      const collectionAppId = textOf(row.app_id)
      const app = ensure(collectionAppId)
      const rows = app.collections[textOf(row.collection)] ??= []
      rows.push({
        key: textOf(row.key), seq: integer(row.seq), value: jsonOf(row.value), updatedAt: integer(row.updated_at),
      })
    }
    for (const row of this.db.prepare('SELECT app_id, key, value FROM app_meta ORDER BY app_id, key').all() as Row[]) {
      ensure(textOf(row.app_id)).meta[textOf(row.key)] = textOf(row.value)
    }
    return { version: 1, exportedAt: this.clock(), apps }
  }

  /** Replace or merge an export. Validation happens before the transaction starts. */
  importAll(data: unknown, options: { mode?: 'replace' | 'merge' } = {}): { apps: number; documents: number; collections: number } {
    const parsed = parseExport(data)
    const mode = options.mode ?? 'merge'
    return this.transaction(() => {
      if (mode === 'replace') {
        this.db.exec('DELETE FROM app_documents; DELETE FROM app_collections; DELETE FROM app_meta;')
      }
      let documents = 0
      let collections = 0
      for (const [appId, app] of Object.entries(parsed.apps)) {
        nameOf(appId, 'application id')
        const written = this.writeApp(appId, app, mode === 'replace')
        documents += written.documents
        collections += written.collections
      }
      return { apps: Object.keys(parsed.apps).length, documents, collections }
    })
  }

  /**
   * Replace ONE application's namespace exactly, leaving every other app
   * untouched. The backup restore path uses this after validating the snapshot;
   * normal imports keep using `importAll(..., { mode: 'merge' })`.
   * @param appId - the application to replace.
   * @param app - that application's exported namespace (validated before any write).
   * @returns how many documents/collection rows were written.
   */
  replaceNamespace(appId: string, app: DataStoreExport['apps'][string]): { documents: number; collections: number } {
    const parsed = parseExport({ version: 1, exportedAt: this.clock(), apps: { [appId]: app } })
    const target = parsed.apps[appId]!
    return this.transaction(() => {
      nameOf(appId, 'application id')
      this.db.prepare('DELETE FROM app_documents WHERE app_id = ?').run(appId)
      this.db.prepare('DELETE FROM app_collections WHERE app_id = ?').run(appId)
      this.db.prepare('DELETE FROM app_meta WHERE app_id = ?').run(appId)
      return this.writeApp(appId, target, false)
    })
  }

  /** Insert one app's validated rows (the caller owns the transaction). */
  private writeApp(
    appId: string,
    app: DataStoreExport['apps'][string],
    clearCollections: boolean,
  ): { documents: number; collections: number } {
    let documents = 0
    let collections = 0
    for (const [scope, doc] of Object.entries(app.documents)) {
      this.db.prepare(`
        INSERT INTO app_documents (app_id, scope, schema_version, revision, value, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(app_id, scope) DO UPDATE SET schema_version = excluded.schema_version,
          revision = excluded.revision, value = excluded.value, updated_at = excluded.updated_at
      `).run(appId, keyOf(scope, 'document scope'), doc.schemaVersion, doc.revision, encode(doc.value), doc.updatedAt)
      documents += 1
    }
    for (const [collection, rows] of Object.entries(app.collections)) {
      const name = nameOf(collection, 'collection name')
      // `replace` restores the exact snapshot; `merge` keeps rows the dump
      // does not name instead of deleting a collection it only partially covers.
      if (clearCollections) this.clearCollection(appId, name)
      for (const row of rows) {
        this.db.prepare(`
          INSERT INTO app_collections (app_id, collection, key, seq, value, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(app_id, collection, key) DO UPDATE SET
            seq = excluded.seq, value = excluded.value, updated_at = excluded.updated_at
        `).run(appId, name, keyOf(row.key), row.seq, encode(row.value), row.updatedAt)
        collections += 1
      }
    }
    for (const [key, value] of Object.entries(app.meta ?? {})) this.setMeta(appId, keyOf(key, 'meta key'), value)
    return { documents, collections }
  }

  /** Copy a consistent database snapshot to a new path (never overwrites). */
  backupTo(path: string): string {
    if (this.dbPath === undefined) throw new StoreError('invalid-argument', 'an in-memory store has no file to back up')
    if (existsSync(path)) throw new StoreError('invalid-argument', `backup target already exists: ${path}`)
    mkdirSync(dirname(path), { recursive: true })
    const escaped = path.replaceAll("'", "''")
    this.db.exec(`VACUUM INTO '${escaped}'`)
    return path
  }

  /** The file size of the database, when it has one. */
  byteSize(): number | undefined {
    if (this.dbPath === undefined) return undefined
    try { return statSync(this.dbPath).size } catch { return undefined }
  }
}

/** Validate an imported export before any row is changed. */
function parseExport(data: unknown): DataStoreExport {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new StoreError('invalid-argument', 'the import is not an object')
  const record = data as { version?: unknown; apps?: unknown }
  if (record.version !== 1) throw new StoreError('invalid-argument', `unsupported import version: ${String(record.version)}`)
  if (typeof record.apps !== 'object' || record.apps === null || Array.isArray(record.apps)) throw new StoreError('invalid-argument', 'the import has no apps map')
  for (const [appId, app] of Object.entries(record.apps)) {
    nameOf(appId, 'application id')
    if (typeof app !== 'object' || app === null || Array.isArray(app)) throw new StoreError('invalid-argument', `app ${appId} is not an object`)
    const entry = app as { documents?: unknown; collections?: unknown; meta?: unknown }
    if (typeof entry.documents !== 'object' || entry.documents === null || Array.isArray(entry.documents)) throw new StoreError('invalid-argument', `app ${appId} has no documents map`)
    for (const [scope, doc] of Object.entries(entry.documents)) {
      keyOf(scope, 'document scope')
      if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new StoreError('invalid-argument', `document ${appId}/${scope} is not an object`)
      const value = doc as { schemaVersion?: unknown; revision?: unknown; value?: unknown; updatedAt?: unknown }
      if (!Number.isInteger(value.schemaVersion) || !Number.isInteger(value.revision) || !Number.isInteger(value.updatedAt)) throw new StoreError('invalid-argument', `document ${appId}/${scope} has invalid version facts`)
      encode(value.value)
    }
    if (entry.collections !== undefined) {
      if (typeof entry.collections !== 'object' || entry.collections === null || Array.isArray(entry.collections)) throw new StoreError('invalid-argument', `app ${appId} has an invalid collections map`)
      for (const [collection, rows] of Object.entries(entry.collections)) {
        nameOf(collection, 'collection name')
        if (!Array.isArray(rows)) throw new StoreError('invalid-argument', `collection ${appId}/${collection} is not an array`)
        for (const row of rows) {
          if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new StoreError('invalid-argument', `collection ${appId}/${collection} has a non-object row`)
          const item = row as { key?: unknown; seq?: unknown; value?: unknown; updatedAt?: unknown }
          if (typeof item.key !== 'string' || !Number.isInteger(item.seq) || !Number.isInteger(item.updatedAt)) throw new StoreError('invalid-argument', `collection ${appId}/${collection} has an invalid row`)
          keyOf(item.key)
          encode(item.value)
        }
      }
    }
    if (entry.meta !== undefined) {
      if (typeof entry.meta !== 'object' || entry.meta === null || Array.isArray(entry.meta)) throw new StoreError('invalid-argument', `app ${appId} has an invalid meta map`)
      for (const [key, value] of Object.entries(entry.meta)) {
        keyOf(key, 'meta key')
        if (typeof value !== 'string') throw new StoreError('invalid-argument', `meta ${appId}/${key} is not a string`)
      }
    }
  }
  return data as DataStoreExport
}
