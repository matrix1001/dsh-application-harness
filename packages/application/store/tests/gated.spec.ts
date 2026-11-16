/**
 * The capability-gated namespace handle: every document, collection and meta
 * operation goes through the attached storage door, and an unattached handle
 * refuses instead of reading.
 */
import { describe, expect, test } from 'vitest'
import { GatedStore, type StorageGate } from '../src/gated.ts'
import { SqliteDataStore, StoreError } from '../src/sqlite-store.ts'

/** A real in-memory namespace and a gate that records every use. */
function fixture(): { store: GatedStore; uses: string[]; gate: StorageGate } {
  const core = new SqliteDataStore({ dbPath: ':memory:' })
  const uses: string[] = []
  const gate: StorageGate = {
    use: async (name, work) => {
      uses.push(name)
      return await work()
    },
  }
  const store = new GatedStore(core.namespace('app'))
  return { store, uses, gate }
}

describe('GatedStore', () => {
  test('refuses every operation before the capability door is attached', async () => {
    const { store } = fixture()
    expect(store.appId).toBe('app')
    await expect(store.documents.get('settings')).rejects.toThrow(StoreError)
    await expect(store.documents.get('settings')).rejects.toThrow(/not attached/u)
    await expect(store.collections.open('inbox').get('one')).rejects.toThrow(/not attached/u)
    await expect(store.meta.get('key')).rejects.toThrow(/not attached/u)
    await expect(store.transaction(() => undefined)).rejects.toThrow(/not attached/u)
  })

  test('routes documents, collections, meta and transactions through one gate', async () => {
    const { store, uses, gate } = fixture()
    store.attach(gate)

    expect(await store.documents.put('settings', { theme: 'dark' })).toMatchObject({ revision: 1 })
    expect(await store.documents.get('settings')).toMatchObject({ value: { theme: 'dark' } })
    expect((await store.documents.list()).map(entry => entry.scope)).toEqual(['settings'])
    expect(await store.documents.delete('settings')).toBe(true)

    const collection = store.collections.open('inbox')
    expect(await collection.put('one', { title: 'one' })).toMatchObject({ key: 'one', seq: 1 })
    expect(await collection.get('one')).toMatchObject({ value: { title: 'one' } })
    expect(await collection.putMany([{ key: 'two', value: { title: 'two' } }])).toBe(1)
    expect(await collection.count()).toBe(2)
    expect((await collection.list({ limit: 1 })).items).toHaveLength(1)
    expect(await collection.delete('one')).toBe(true)
    expect(await collection.clear()).toBe(1)

    await store.meta.set('legacy', 'yes')
    expect(await store.meta.get('legacy')).toBe('yes')
    expect(await store.meta.delete('legacy')).toBe(true)

    expect(await store.transaction(tx => {
      tx.documents.put('tx', { inside: true })
      return 7
    })).toBe(7)
    expect(await store.documents.get('tx')).toMatchObject({ value: { inside: true } })

    expect(uses.length).toBe(16)
    expect(uses.every(name => name === 'storage')).toBe(true)
  })

  test('rethrows a store conflict from a gated write unchanged', async () => {
    const { store, gate } = fixture()
    store.attach(gate)
    await store.documents.put('settings', { version: 1 })
    await expect(store.documents.put('settings', { version: 2 }, { expectedRevision: 1 })).resolves.toMatchObject({ revision: 2 })
    await expect(store.documents.put('settings', { version: 3 }, { expectedRevision: 1 })).rejects.toThrow(/storage-conflict|revision/u)
  })
})
