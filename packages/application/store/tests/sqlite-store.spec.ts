/**
 * The unified SQLite store: per-application namespaces, document CAS,
 * collection paging, transactions, persistence, export/import and backup.
 * These are the guarantees the application migrations stand on.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { SqliteDataStore, StoreError } from '../src/sqlite-store.ts'

/** A temporary directory cleaned by the caller. */
function tempDir(prefix: string): { path: string; clean: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix))
  return { path, clean: () => { rmSync(path, { recursive: true, force: true }) } }
}

describe('SqliteDataStore: documents', () => {
  test('keeps namespaces isolated and versions every document write', () => {
    const store = new SqliteDataStore()
    try {
      const a = store.namespace('app-a')
      const b = store.namespace('app-b')
      expect(a.documents.get('settings')).toBeUndefined()
      expect(a.documents.put('settings', { theme: 'dark' })).toMatchObject({ revision: 1, schemaVersion: 1 })
      expect(b.documents.get('settings')).toBeUndefined()
      expect(a.documents.put('settings', { theme: 'light' }, { expectedRevision: 1 })).toMatchObject({ revision: 2, value: { theme: 'light' } })
      expect(() => a.documents.put('settings', {}, { expectedRevision: 1 })).toThrow(StoreError)
      expect(() => a.documents.put('settings', {}, { expectedRevision: 1 })).toThrow(/revision 2/)
      expect(a.documents.list()).toEqual([{ scope: 'settings', value: { theme: 'light' }, revision: 2, schemaVersion: 1, updatedAt: expect.any(Number) }])
      expect(a.documents.delete('settings', { expectedRevision: 2 })).toBe(true)
      expect(a.documents.get('settings')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('rolls a failed transaction back, including a document already written inside it', () => {
    const store = new SqliteDataStore()
    try {
      const ns = store.namespace('app-a')
      expect(() => ns.transaction(() => {
        ns.documents.put('first', { value: 1 })
        ns.collections.open('items').put('a', { value: 1 })
        throw new Error('stop')
      })).toThrow('stop')
      expect(ns.documents.get('first')).toBeUndefined()
      expect(ns.collections.open('items').count()).toBe(0)
    } finally {
      store.close()
    }
  })

  test('rejects an invalid application id instead of touching SQL', () => {
    const store = new SqliteDataStore()
    try {
      expect(() => store.namespace('bad id')).toThrow(/not a valid store name/u)
      expect(() => store.namespace('')).toThrow(StoreError)
    } finally {
      store.close()
    }
  })
})

describe('SqliteDataStore: collections', () => {
  test('pages in insertion order, preserves a key sequence on update, and deletes/clears', () => {
    const store = new SqliteDataStore()
    try {
      const items = store.namespace('app-a').collections.open('inbox')
      items.putMany([{ key: 'a', value: { n: 1 } }, { key: 'b', value: { n: 2 } }, { key: 'c', value: { n: 3 } }])
      const first = items.list({ limit: 2 })
      expect(first.items.map(item => item.key)).toEqual(['c', 'b'])
      expect(first.hasMore).toBe(true)
      expect(first.next).toBe(first.items.at(-1)!.seq.toString())
      const second = items.list({ limit: 2, after: first.next! })
      expect(second.items.map(item => item.key)).toEqual(['a'])
      expect(second.hasMore).toBe(false)
      // Updating a row keeps its place in the insertion order.
      items.put('b', { n: 20 })
      expect(items.list({ direction: 'asc' }).items.map(item => item.key)).toEqual(['a', 'b', 'c'])
      expect(items.count()).toBe(3)
      expect(items.delete('b')).toBe(true)
      expect(items.delete('b')).toBe(false)
      expect(items.clear()).toBe(2)
      expect(items.count()).toBe(0)
    } finally {
      store.close()
    }
  })
})

describe('SqliteDataStore: durability and evidence', () => {
  test('persists documents and collections across a reopen', () => {
    const dir = tempDir('app-store-')
    try {
      const path = join(dir.path, 'data.sqlite')
      const first = new SqliteDataStore({ dbPath: path })
      first.namespace('info-hub').documents.put('settings', { usageRefreshMs: 1 })
      first.namespace('info-hub').collections.open('inbox').put('k', { title: 'external' })
      first.close()
      const second = new SqliteDataStore({ dbPath: path })
      try {
        expect(second.namespace('info-hub').documents.get('settings')?.value).toEqual({ usageRefreshMs: 1 })
        expect(second.namespace('info-hub').collections.open('inbox').get('k')?.value).toEqual({ title: 'external' })
      } finally {
        second.close()
      }
    } finally {
      dir.clean()
    }
  })

  test('exports, imports (replace and merge), and backs up a consistent snapshot', () => {
    const dir = tempDir('app-store-')
    try {
      const path = join(dir.path, 'data.sqlite')
      const source = new SqliteDataStore({ dbPath: path })
      source.namespace('app-a').documents.put('settings', { a: 1 })
      source.namespace('app-a').collections.open('items').put('k', { v: 1 })
      const dump = source.exportAll()
      expect(dump).toMatchObject({ version: 1, apps: { 'app-a': { documents: { settings: { value: { a: 1 } } }, collections: { items: [{ key: 'k', value: { v: 1 } }] } } } })
      const target = new SqliteDataStore()
      try {
        target.importAll(dump)
        expect(target.namespace('app-a').documents.get('settings')?.value).toEqual({ a: 1 })
        expect(target.namespace('app-a').collections.open('items').get('k')?.value).toEqual({ v: 1 })
        target.namespace('app-a').documents.put('other', { keep: true })
        target.importAll(dump)
        expect(target.namespace('app-a').documents.get('other')?.value).toEqual({ keep: true })
        target.importAll(dump, { mode: 'replace' })
        expect(target.namespace('app-a').documents.get('other')).toBeUndefined()
      } finally {
        target.close()
      }
      const backup = join(dir.path, 'backup.sqlite')
      source.backupTo(backup)
      const restored = new SqliteDataStore({ dbPath: backup })
      try {
        expect(restored.namespace('app-a').documents.get('settings')?.value).toEqual({ a: 1 })
      } finally {
        restored.close()
      }
      expect(() => source.backupTo(backup)).toThrow(/already exists/u)
      source.close()
    } finally {
      dir.clean()
    }
  })

  test('preserves an unreadable database and refuses to open it', () => {
    const dir = tempDir('app-store-corrupt-')
    try {
      const path = join(dir.path, 'data.sqlite')
      writeFileSync(path, 'not a sqlite database', 'utf8')
      expect(() => new SqliteDataStore({ dbPath: path })).toThrow(StoreError)
      expect(() => new SqliteDataStore({ dbPath: path })).toThrow(/database/u)
      // The original bytes stay; a best-effort recovery copy exists beside it.
      expect(readdirSync(dir.path).some(name => name.startsWith('data.sqlite.corrupt-'))).toBe(true)
    } finally {
      dir.clean()
    }
  })

  test('rejects malformed imports before changing any row', () => {
    const store = new SqliteDataStore()
    try {
      store.namespace('app-a').documents.put('keep', { value: true })
      expect(() => store.importAll({ version: 2, apps: {} })).toThrow(/unsupported import version/u)
      expect(() => store.importAll({ version: 1, apps: { 'app-a': { documents: { x: { schemaVersion: 1, revision: 1, value: undefined, updatedAt: 1 } } } } })).toThrow(/not JSON serializable/u)
      expect(store.namespace('app-a').documents.get('keep')?.value).toEqual({ value: true })
    } finally {
      store.close()
    }
  })
})


describe('SqliteDataStore: refusal vocabulary', () => {
  test('rejects reserved prototype names at the store-name boundary', () => {
    const store = new SqliteDataStore()
    try {
      const ns = store.namespace('app-a')
      expect(() => ns.collections.open('constructor')).toThrow(/reserved name/u)
      expect(() => ns.collections.open('__proto__')).toThrow(/reserved name/u)
      expect(() => store.putCollectionItem('app-a', 'prototype', 'k', 1)).toThrow(/reserved name/u)
      ns.documents.put('__proto__', { value: 1 })
      expect(store.exportAll().apps['app-a']?.documents['__proto__']?.value).toEqual({ value: 1 })
    } finally {
      store.close()
    }
  })

  test('rejects an empty collection key and a non-JSON value', () => {
    const store = new SqliteDataStore()
    try {
      const items = store.namespace('app-a').collections.open('items')
      expect(() => items.put('', {})).toThrow(/collection key is empty/u)
      const circular: Record<string, unknown> = {}
      circular.self = circular
      expect(() => items.put('k', circular)).toThrow(/not JSON serializable/u)
      expect(() => store.namespace('app-a').documents.put('doc', circular)).toThrow(/not JSON serializable/u)
      expect(() => store.namespace('app-a').documents.put('doc', undefined)).toThrow(/undefined/u)
    } finally {
      store.close()
    }
  })

  test('accepts arbitrary legacy scopes and meta keys, not only identifier-shaped names', () => {
    const store = new SqliteDataStore()
    try {
      const ns = store.namespace('app-a')
      ns.documents.put('ui-fixtures/counter', { value: 4 })
      expect(ns.documents.get('ui-fixtures/counter')?.value).toEqual({ value: 4 })
      ns.meta.set('migration/source', 'legacy')
      expect(ns.meta.get('migration/source')).toBe('legacy')
      const dump = store.exportAll()
      expect(dump.apps['app-a']?.documents['ui-fixtures/counter']?.value).toEqual({ value: 4 })
    } finally {
      store.close()
    }
  })

  test('exposes metadata and the database path, and refuses an in-memory backup', () => {
    const store = new SqliteDataStore()
    try {
      const ns = store.namespace('app-a')
      expect(store.path).toBeUndefined()
      ns.meta.set('m', 'v')
      expect(ns.meta.get('m')).toBe('v')
      expect(ns.meta.get('missing')).toBeUndefined()
      expect(ns.meta.delete('m')).toBe(true)
      expect(ns.meta.delete('m')).toBe(false)
      expect(() => store.backupTo('/tmp/nope.sqlite')).toThrow(/in-memory/u)
    } finally {
      store.close()
    }
  })

  test('pages with an invalid cursor and clamps an over-large limit', () => {
    const store = new SqliteDataStore()
    try {
      const items = store.namespace('app-a').collections.open('items')
      items.putMany(Array.from({ length: 3 }, (_, index) => ({ key: `k${index}`, value: index })))
      expect(items.list({ limit: 99_999 }).items).toHaveLength(3)
      expect(items.list({ after: 'not-a-number' }).items).toHaveLength(3)
      expect(items.list({ limit: 0 }).items).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  test('refuses a database that is a directory and preserves a newer schema', () => {
    const dir = tempDir('app-store-refuse-')
    try {
      expect(() => new SqliteDataStore({ dbPath: dir.path })).toThrow(/cannot open/u)
      const path = join(dir.path, 'newer.sqlite')
      const raw = new DatabaseSync(path)
      raw.exec('PRAGMA user_version = 999')
      raw.close()
      expect(() => new SqliteDataStore({ dbPath: path })).toThrow(/newer than this build/u)
      expect(readdirSync(dir.path).some(name => name.startsWith('newer.sqlite.corrupt-'))).toBe(true)
      const bad = join(dir.path, 'bad-dir')
      mkdirSync(bad)
      expect(() => new SqliteDataStore({ dbPath: bad })).toThrow(StoreError)
    } finally {
      dir.clean()
    }
  })

  test('turns a malformed stored row into storage-corrupt, not an empty value', () => {
    const dir = tempDir('app-store-row-')
    try {
      const path = join(dir.path, 'data.sqlite')
      const store = new SqliteDataStore({ dbPath: path })
      store.namespace('app-a').documents.put('doc', { ok: true })
      store.close()
      const raw = new DatabaseSync(path)
      raw.exec("UPDATE app_documents SET value = 'not json'")
      raw.close()
      const reopened = new SqliteDataStore({ dbPath: path })
      try {
        expect(() => reopened.namespace('app-a').documents.get('doc')).toThrow(/cannot be parsed/u)
      } finally {
        reopened.close()
      }
    } finally {
      dir.clean()
    }
  })

  test('rejects every malformed import shape before touching a row', () => {
    const store = new SqliteDataStore()
    try {
      const invalid: unknown[] = [
        null,
        {},
        { version: 2, apps: {} },
        { version: 1, apps: [] },
        { version: 1, apps: { 'app-a': null } },
        { version: 1, apps: { 'app-a': { documents: [] } } },
        { version: 1, apps: { 'app-a': { documents: { doc: {} } } } },
        { version: 1, apps: { 'app-a': { documents: { doc: { schemaVersion: 1, revision: 1, value: {}, updatedAt: 1 } }, collections: [] } } },
        { version: 1, apps: { 'app-a': { documents: {}, collections: { c: [null] } } } },
        { version: 1, apps: { 'app-a': { documents: {}, collections: { c: [{ key: '', seq: 1, value: {}, updatedAt: 1 }] } } } },
        { version: 1, apps: { 'app-a': { documents: {}, meta: [] } } },
        { version: 1, apps: { 'app-a': { documents: {}, meta: { k: 1 } } } },
      ]
      for (const data of invalid) expect(() => store.importAll(data)).toThrow(StoreError)
    } finally {
      store.close()
    }
  })
})

describe('SqliteDataStore: remaining refusal and export facts', () => {
  test('deletes a missing document and refuses a stale conditional delete', () => {
    const store = new SqliteDataStore()
    try {
      const ns = store.namespace('app-a')
      expect(ns.documents.delete('missing')).toBe(false)
      ns.documents.put('doc', {})
      expect(() => ns.documents.delete('doc', { expectedRevision: 0 })).toThrow(/revision 1/u)
      expect(ns.documents.get('doc')).toBeDefined()
    } finally {
      store.close()
    }
  })

  test('exports and imports metadata, and reports the database byte size', () => {
    const dir = tempDir('app-store-meta-')
    try {
      const path = join(dir.path, 'data.sqlite')
      const store = new SqliteDataStore({ dbPath: path })
      store.namespace('app-a').meta.set('marker', 'yes')
      expect(store.byteSize()).toBeGreaterThan(0)
      const dump = store.exportAll()
      expect(dump.apps['app-a']?.meta).toEqual({ marker: 'yes' })
      const target = new SqliteDataStore()
      expect(target.byteSize()).toBeUndefined()
      target.importAll(dump, { mode: 'replace' })
      expect(target.namespace('app-a').meta.get('marker')).toBe('yes')
      target.close()
      store.close()
    } finally {
      dir.clean()
    }
  })

  test('refuses to close inside a transaction', () => {
    const store = new SqliteDataStore()
    try {
      expect(() => store.namespace('app-a').transaction(() => { store.close() })).toThrow(/inside a transaction/u)
    } finally {
      if (store.path !== undefined) store.close()
    }
  })

  test('pages asc after a cursor, checks a missing target and tolerates an optional meta map', () => {
    const dir = tempDir('app-store-extra-')
    try {
      const path = join(dir.path, 'data.sqlite')
      const store = new SqliteDataStore({ dbPath: path })
      const items = store.namespace('app-a').collections.open('items')
      items.putMany([{ key: 'a', value: 1 }, { key: 'b', value: 2 }])
      expect(items.list({ direction: 'asc', after: '0' }).items.map(item => item.key)).toEqual(['a', 'b'])
      expect(() => store.namespace('app-a').documents.put('new', {}, { expectedRevision: 1 })).toThrow(/revision 0/u)
      // A valid import with no `meta` key and a meta-free app is accepted.
      expect(store.importAll({ version: 1, apps: { 'app-a': { documents: {}, collections: {} } } })).toMatchObject({ apps: 1 })
      expect(() => store.importAll({ version: 1, apps: { 'app-a': { documents: {}, collections: { c: {} } } } })).toThrow(/not an array/u)
      rmSync(path)
      expect(store.byteSize()).toBeUndefined()
      store.close()
    } finally {
      dir.clean()
    }
  })

  test('rejects a null/array document and a collection row with no usable key facts', () => {
    const store = new SqliteDataStore()
    try {
      const invalid: unknown[] = [
        { version: 1, apps: { 'app-a': { documents: { doc: null } } } },
        { version: 1, apps: { 'app-a': { documents: { doc: [] } } } },
        { version: 1, apps: { 'app-a': { documents: {}, collections: { c: [{}] } } } },
        { version: 1, apps: { 'app-a': { documents: {}, collections: { c: [{ key: 'k' }] } } } },
      ]
      for (const data of invalid) expect(() => store.importAll(data)).toThrow(StoreError)
    } finally {
      store.close()
    }
  })
})


describe('SqliteDataStore: per-application replace', () => {
  test('restores one namespace exactly and leaves every other application alone', () => {
    const store = new SqliteDataStore()
    try {
      const a = store.namespace('app-a')
      const b = store.namespace('app-b')
      a.documents.put('settings', { theme: 'dark' })
      a.documents.put('notes', { count: 1 })
      a.collections.open('items').putMany([{ key: 'one', value: 1 }, { key: 'two', value: 2 }])
      a.meta.set('legacy-imported', 'yes')
      b.documents.put('settings', { theme: 'light' })
      b.collections.open('items').put('b-one', { keep: true })
      const snapshot = store.exportAll()
      const backup = snapshot.apps['app-a']!

      a.documents.put('settings', { theme: 'changed' })
      a.documents.put('extra', { value: 1 })
      a.documents.delete('notes')
      a.collections.open('items').delete('one')
      a.collections.open('items').put('three', 3)
      a.meta.set('legacy-imported', 'changed')

      expect(store.replaceNamespace('app-a', backup)).toEqual({ documents: 2, collections: 2 })

      const restored = store.exportAll().apps['app-a']!
      expect(Object.keys(restored.documents).sort()).toEqual(['notes', 'settings'])
      expect(restored.documents.settings?.value).toEqual({ theme: 'dark' })
      expect(restored.documents.notes?.value).toEqual({ count: 1 })
      expect(restored.collections.items?.map(row => row.key)).toEqual(['one', 'two'])
      expect(restored.meta).toEqual({ 'legacy-imported': 'yes' })
      // The other namespace is untouched by the replace.
      const other = store.exportAll().apps['app-b']!
      expect(other.documents.settings?.value).toEqual({ theme: 'light' })
      expect(other.collections.items?.map(row => row.key)).toEqual(['b-one'])
    } finally {
      store.close()
    }
  })

  test('validates before touching the current namespace', () => {
    const store = new SqliteDataStore()
    try {
      const ns = store.namespace('app-a')
      ns.documents.put('keep', { value: 1 })
      expect(() => store.replaceNamespace('app-a', {
        documents: { bad: { schemaVersion: 1, revision: 1, value: undefined, updatedAt: 1 } },
        collections: {},
      } as never)).toThrow(/JSON serializable/u)
      expect(ns.documents.get('keep')?.value).toEqual({ value: 1 })
    } finally {
      store.close()
    }
  })
})
