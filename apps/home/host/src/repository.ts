/**
 * The home repository: one durable document behind the application's storage
 * capability, one serialized writer, and nothing else. Operations read the
 * in-memory document through {@link HomeRepository.read} and change it through
 * {@link HomeRepository.mutate}; the caller owns validation and notifications.
 * @module @matrix1001/dsh-application-harness-home/repository
 */

import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { DocumentWriteOptions, StoredDocument } from '@matrix1001/dsh-application-harness-store/sqlite-store'
import { emptyDocument, HOME_SCHEMA_VERSION, isHomeDocument } from './model.ts'
import type { HomeDocument } from './model.ts'

/** The document scope this application owns. */
export const DOCUMENT_SCOPE = 'document'

/**
 * The narrow store face the repository needs. The shipped row passes the gated
 * namespace, so every method is capability-checked; a spec passes the same
 * shape over a double.
 */
export interface HomeStorePort {
  documents: {
    get<T = unknown>(scope: string): Promise<StoredDocument<T> | undefined>
    put<T>(scope: string, value: T, options?: DocumentWriteOptions): Promise<StoredDocument<T>>
  }
}

/** The home document repository. */
export class HomeRepository {
  private document: HomeDocument = emptyDocument()
  private revision: number | undefined
  private loaded = false
  private queue: Promise<unknown> = Promise.resolve()

  /** @param store - the capability-gated document store. */
  constructor(private readonly store: HomeStorePort) {}

  /** Load the durable document once; a missing document is an empty first run. */
  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  /** Load (or re-load after an external import) the durable document. */
  async load(): Promise<void> {
    const stored = await this.store.documents.get<HomeDocument>(DOCUMENT_SCOPE)
    if (stored === undefined) {
      this.document = emptyDocument()
      this.revision = undefined
      this.loaded = true
      return
    }
    if (!isHomeDocument(stored.value)) throw new AppError('storage-corrupt', 'home: unsupported or malformed document')
    this.document = stored.value
    this.revision = stored.revision
    this.loaded = true
  }

  /** Read the in-memory document (callers must have awaited {@link ensureLoaded}). */
  read<T>(inspect: (document: HomeDocument) => T): T {
    return inspect(this.document)
  }

  /**
   * Run one synchronous change against the document and persist it as one
   * transaction. Writes are serialized, so two operations never interleave a
   * read-modify-write; the stored value becomes the new in-memory document.
   */
  async mutate<T>(change: (document: HomeDocument) => { document: HomeDocument; result: T }): Promise<T> {
    await this.ensureLoaded()
    const run = async (): Promise<T> => {
      const next = change(this.document)
      if (next.document === this.document) return next.result
      const stored = await this.store.documents.put(DOCUMENT_SCOPE, next.document, {
        schemaVersion: HOME_SCHEMA_VERSION,
        ...(this.revision === undefined ? {} : { expectedRevision: this.revision }),
      })
      this.document = stored.value
      this.revision = stored.revision
      return next.result
    }
    const pending = this.queue.then(run, run)
    this.queue = pending.then(() => undefined, () => undefined)
    return await pending
  }
}
