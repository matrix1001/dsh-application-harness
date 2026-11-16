/**
 * The capability-gated view of one application namespace.
 *
 * The store's raw `AppNamespace` is synchronous and unconditional: an
 * application that holds it can read whenever it likes, whether or not the user
 * allowed its `storage` capability. `GatedStore` keeps that namespace private
 * and routes every document, collection and meta operation through one
 * capability door, so a revoke takes effect on the next use and a new
 * application has no raw handle to bypass it.
 *
 * The door is attached in the application's start hook (the runtime hands the
 * application its `AppContext` only then); a use before attachment is
 * `storage-unavailable`, not an empty read. `transaction` runs its synchronous
 * callback under the outer gate and hands the callback the raw transaction
 * handle, which is the one controlled escape the store's synchronous
 * transaction API requires; the handle must not be retained past the callback.
 * @module
 */

import type {
  AppNamespace, CollectionItem, CollectionPage, DocumentWriteOptions, StoredDocument, StoredDocumentEntry,
} from './sqlite-store.ts'
import { StoreError } from './sqlite-store.ts'

/** The one capability door a {@link GatedStore} uses. */
export interface StorageGate {
  /**
   * Run one `storage` use under the application's declaration and grants.
   * @param name - the capability name (always `storage` here).
   * @param work - the store operation to run after the check.
   * @returns the operation's result.
   */
  use<T>(name: 'storage', work: () => T | Promise<T>): Promise<T>
}

/** One named collection behind the gate; every method checks the capability first. */
export class GatedCollection {
  /**
   * @param run - the store's gate wrapper (it owns the private namespace).
   * @param name - the collection name.
   */
  constructor(
    private readonly run: <T>(work: (namespace: AppNamespace) => T) => Promise<T>,
    private readonly name: string,
  ) {}

  /** Read one entry. */
  async get<T = unknown>(key: string): Promise<CollectionItem<T> | undefined> {
    return await this.run(namespace => namespace.collections.open(this.name).get<T>(key))
  }

  /** Write one entry (insert or update). */
  async put<T>(key: string, value: T): Promise<CollectionItem<T>> {
    return await this.run(namespace => namespace.collections.open(this.name).put(key, value))
  }

  /** Write many entries in one call. */
  async putMany(entries: readonly { key: string; value: unknown }[]): Promise<number> {
    return await this.run(namespace => namespace.collections.open(this.name).putMany(entries))
  }

  /** Delete one entry. */
  async delete(key: string): Promise<boolean> {
    return await this.run(namespace => namespace.collections.open(this.name).delete(key))
  }

  /** Remove every entry. */
  async clear(): Promise<number> {
    return await this.run(namespace => namespace.collections.open(this.name).clear())
  }

  /** Count the entries. */
  async count(): Promise<number> {
    return await this.run(namespace => namespace.collections.open(this.name).count())
  }

  /** Read one page. */
  async list<T = unknown>(query?: { limit?: number; after?: string; direction?: 'asc' | 'desc' }): Promise<CollectionPage<T>> {
    return await this.run(namespace => namespace.collections.open(this.name).list<T>(query))
  }
}

/** The async, capability-gated handle for one application namespace. */
export class GatedStore {
  private access: StorageGate | undefined

  /** @param namespace - the application's own raw namespace (never re-exposed). */
  constructor(private readonly namespace: AppNamespace) {}

  /** The application this handle belongs to. */
  get appId(): string {
    return this.namespace.appId
  }

  /** Bind the capability door (the application's start hook). */
  attach(access: StorageGate): void {
    this.access = access
  }

  /** Run one read/in-memory check under the storage capability. */
  async withAccess<T>(work: () => T | Promise<T>): Promise<T> {
    const access = this.access
    if (access === undefined) throw new StoreError('storage-unavailable', 'the storage capability door is not attached yet')
    return await access.use('storage', work)
  }

  /** Document operations, each checked before it touches the namespace. */
  readonly documents = {
    get: <T = unknown>(scope: string): Promise<StoredDocument<T> | undefined> =>
      this.withAccess(() => this.namespace.documents.get<T>(scope)),
    put: <T>(scope: string, value: T, options?: DocumentWriteOptions): Promise<StoredDocument<T>> =>
      this.withAccess(() => this.namespace.documents.put(scope, value, options)),
    delete: (scope: string, options?: { expectedRevision?: number }): Promise<boolean> =>
      this.withAccess(() => this.namespace.documents.delete(scope, options)),
    list: (): Promise<StoredDocumentEntry[]> =>
      this.withAccess(() => this.namespace.documents.list()),
  }

  /** Collection handles; each operation checks the capability first. */
  readonly collections = {
    open: (name: string): GatedCollection =>
      new GatedCollection(work => this.withAccess(() => work(this.namespace)), name),
  }

  /** Namespace meta operations, each checked before it touches the namespace. */
  readonly meta = {
    get: (key: string): Promise<string | undefined> =>
      this.withAccess(() => this.namespace.meta.get(key)),
    set: (key: string, value: string): Promise<void> =>
      this.withAccess(() => { this.namespace.meta.set(key, value) }),
    delete: (key: string): Promise<boolean> =>
      this.withAccess(() => this.namespace.meta.delete(key)),
  }

  /**
   * Run one synchronous transaction under the outer gate. The callback receives
   * the raw transaction namespace because the store's transaction API is
   * synchronous; it must not be retained past the callback.
   * @param work - the synchronous transaction body.
   * @returns the body's result.
   */
  async transaction<T>(work: (tx: AppNamespace) => T): Promise<T> {
    return await this.withAccess(() => this.namespace.transaction(work))
  }
}
