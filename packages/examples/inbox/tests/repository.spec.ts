import { describe, expect, it } from 'vitest'
import type { DocumentWriteOptions, StoredDocument } from '@matrix1001/dsh-application-harness-store/sqlite-store'
import { InboxRepository, DOCUMENT_SCOPE } from '../src/repository.ts'
import { emptyDocument } from '../src/model.ts'
import type { InboxDocument } from '../src/model.ts'

/** One document store double that records the writes it received. */
function store(initial?: InboxDocument) {
  let current: InboxDocument | undefined = initial
  let revision = 0
  const writes: Array<{ value: InboxDocument; options: DocumentWriteOptions | undefined }> = []
  let delay: Promise<void> | undefined
  return {
    writes,
    get current() { return current },
    documents: {
      async get<T>(scope: string): Promise<StoredDocument<T> | undefined> {
        if (scope !== DOCUMENT_SCOPE || current === undefined) return undefined
        return { value: structuredClone(current) as T, revision, schemaVersion: 1, updatedAt: 0 }
      },
      async put<T>(_scope: string, value: T, options?: DocumentWriteOptions): Promise<StoredDocument<T>> {
        if (delay !== undefined) await delay
        writes.push({ value: structuredClone(value) as InboxDocument, options })
        current = structuredClone(value) as InboxDocument
        revision += 1
        return { value: structuredClone(value), revision, schemaVersion: 1, updatedAt: revision }
      },
    },
    hold(): () => void {
      let release!: () => void
      delay = new Promise<void>((resolve) => { release = resolve })
      return () => { delay = undefined; release() }
    },
  }
}

describe('InboxRepository', () => {
  it('starts empty when the document is missing and only loads once', async () => {
    const fake = store()
    const repository = new InboxRepository(fake)
    await repository.ensureLoaded()
    expect(repository.read(document => document)).toEqual(emptyDocument())
    await repository.ensureLoaded()
    expect(fake.writes).toEqual([])
    await repository.mutate(document => ({ document, result: undefined }))
    expect(fake.writes[0]?.options).toEqual({ schemaVersion: 1 })
  })

  it('loads a stored document and keeps its revision for the first write', async () => {
    const fake = store(emptyDocument())
    const repository = new InboxRepository(fake)
    await repository.ensureLoaded()
    const result = await repository.mutate(document => ({ document: { ...document, settings: { ...document.settings, retentionDays: 7 } }, result: 'ok' }))
    expect(result).toBe('ok')
    expect(fake.writes[0]?.options).toEqual({ schemaVersion: 1, expectedRevision: 0 })
    expect(fake.current?.settings.retentionDays).toBe(7)
    await repository.mutate(document => ({ document, result: undefined }))
    expect(fake.writes[1]?.options).toEqual({ schemaVersion: 1, expectedRevision: 1 })
  })

  it('refuses malformed documents', async () => {
    for (const value of [null, { schemaVersion: 2 }, { schemaVersion: 1, sources: [] }, { schemaVersion: 1, sources: [], entries: [] }, { schemaVersion: 1, sources: [], entries: [], settings: null }]) {
      const fake = store()
      const repository = new InboxRepository({
        documents: {
          get: async <T>() => ({ value: value as T, revision: 0, schemaVersion: 1, updatedAt: 0 }),
          put: fake.documents.put,
        },
      })
      await expect(repository.ensureLoaded()).rejects.toMatchObject({ code: 'storage-corrupt' })
    }
  })

  it('serializes overlapping writes and recovers after a failed change', async () => {
    const fake = store(emptyDocument())
    const repository = new InboxRepository(fake)
    await repository.ensureLoaded()
    const release = fake.hold()
    const first = repository.mutate(document => ({ document: { ...document, entries: [...document.entries, { id: 'e1' } as never] }, result: 1 }))
    const second = repository.mutate(document => ({ document: { ...document, entries: [...document.entries, { id: 'e2' } as never] }, result: 2 }))
    release()
    expect(await Promise.all([first, second])).toEqual([1, 2])
    expect(fake.writes.map(write => write.options?.expectedRevision)).toEqual([0, 1])
    expect(fake.current?.entries.map(entry => entry.id)).toEqual(['e1', 'e2'])
    await expect(repository.mutate(() => { throw new Error('nope') })).rejects.toThrow('nope')
    const recovered = await repository.mutate(document => ({ document, result: document.entries.length }))
    expect(recovered).toBe(2)
  })
})
