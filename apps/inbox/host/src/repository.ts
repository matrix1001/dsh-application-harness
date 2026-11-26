/**
 * The inbox repository: one durable document behind the application's storage
 * capability, one serialized writer, and nothing else. Operations read the
 * in-memory document through {@link InboxRepository.read} and change it through
 * {@link InboxRepository.mutate}; the caller owns validation, notifications and
 * cross-application effects.
 * @module @matrix1001/dsh-application-harness-inbox/repository
 */

import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { DocumentWriteOptions, StoredDocument } from '@matrix1001/dsh-application-harness-store/sqlite-store'
import { emptyDocument, INBOX_SCHEMA_VERSION } from './model.ts'
import type { InboxDocument } from './model.ts'

/** The document scope this application owns. */
export const DOCUMENT_SCOPE = 'document'

/**
 * The narrow store face the repository needs. The shipped row passes the
 * gated namespace, so every method is capability-checked; a spec passes the
 * same shape over a double.
 */
export interface InboxStorePort {
  documents: {
    get<T = unknown>(scope: string): Promise<StoredDocument<T> | undefined>
    put<T>(scope: string, value: T, options?: DocumentWriteOptions): Promise<StoredDocument<T>>
  }
}

/** Whether one untrusted value is a document this application can read. */
function isDocument(value: unknown): value is InboxDocument {
  if (typeof value !== 'object' || value === null) return false
  const document = value as Partial<InboxDocument>
  return document.schemaVersion === INBOX_SCHEMA_VERSION
    && Array.isArray(document.sources)
    && Array.isArray(document.entries)
    && typeof document.settings === 'object'
    && document.settings !== null
}

/** The inbox document repository. */
export class InboxRepository {
  private document: InboxDocument = emptyDocument()
  private revision: number | undefined
  private loaded = false
  private queue: Promise<unknown> = Promise.resolve()

  /** @param store - the capability-gated document store. */
  constructor(private readonly store: InboxStorePort) {}

  /** Load the durable document once; a missing document is an empty first run. */
  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  /** Load (or re-load after an external import) the durable document. */
  async load(): Promise<void> {
    const stored = await this.store.documents.get<InboxDocument>(DOCUMENT_SCOPE)
    if (stored === undefined) {
      this.document = emptyDocument()
      this.revision = undefined
      this.loaded = true
      return
    }
    if (!isDocument(stored.value)) throw new AppError('storage-corrupt', 'inbox: unsupported or malformed document')
    this.document = stored.value
    this.revision = stored.revision
    this.loaded = true
  }

  /** Read the in-memory document (callers must have awaited {@link ensureLoaded}). */
  read<T>(inspect: (document: InboxDocument) => T): T {
    return inspect(this.document)
  }

  /**
   * Run one synchronous change against the document and persist it as one
   * transaction. Writes are serialized, so two operations never interleave a
   * read-modify-write; the stored value (not the callback's copy) becomes the
   * new in-memory document.
   */
  async mutate<T>(change: (document: InboxDocument) => { document: InboxDocument; result: T }): Promise<T> {
    await this.ensureLoaded()
    const run = async (): Promise<T> => {
      const next = change(this.document)
      const stored = await this.store.documents.put(DOCUMENT_SCOPE, next.document, {
        schemaVersion: INBOX_SCHEMA_VERSION,
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
