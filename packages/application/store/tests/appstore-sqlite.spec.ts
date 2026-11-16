/**
 * The `applicationStore` service in its unified mode: one SQLite database,
 * per-app namespaces, and the migration/export/backup surface. The legacy
 * `storePath` mode is covered separately; this file is the production row.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test } from 'vitest'
import { AppStore, type GatedStore, type StorageGate } from '../src/index.ts'

/** A distinct context per service instance (the service name is registered on it). */
const context = (): Context => new Context()

/** A pass-through capability door for inspecting the service's own namespace. */
const gate: StorageGate = { use: async (_name, work) => await work() }

/** One application's gated handle, bound to the test door. */
function gated(store: AppStore, appId: string): GatedStore {
  const handle = store.gatedNamespace(appId)
  handle.attach(gate)
  return handle
}

describe('AppStore: unified SQLite mode', () => {
  test('exposes the gated handle and no raw namespace method', () => {
    expect('namespace' in AppStore.prototype).toBe(false)
    expect(typeof AppStore.prototype.gatedNamespace).toBe('function')
  })

  test('persists a namespace across a reopen and exposes the legacy path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'appstore-sqlite-'))
    try {
      const path = join(dir, 'data.sqlite')
      const first = new AppStore(context(), { dbPath: path, legacyStorePath: join(dir, 'store.json') })
      await first.ready
      await gated(first, 'info-hub').documents.put('settings', { usageRefreshMs: 7 })
      await gated(first, 'workbook').collections.open('notes').put('n1', { text: 'x' })
      expect(first.legacyStorePath).toBe(join(dir, 'store.json'))
      expect(first.dbPath).toBe(path)
      const backup = join(dir, 'backup.sqlite')
      expect(first.backupTo(backup)).toBe(backup)
      first.close()
      const second = new AppStore(context(), { dbPath: path })
      await second.ready
      try {
        expect((await gated(second, 'info-hub').documents.get('settings'))?.value).toEqual({ usageRefreshMs: 7 })
        expect((await gated(second, 'workbook').collections.open('notes').get('n1'))?.value).toEqual({ text: 'x' })
        const dump = second.exportAll()
        expect(dump.apps['info-hub']?.documents.settings?.value).toEqual({ usageRefreshMs: 7 })
        const target = new AppStore(context())
        await target.ready
        expect(target.importAll(dump, { mode: 'replace' })).toMatchObject({ apps: 2, documents: 1, collections: 1 })
        expect((await gated(target, 'workbook').collections.open('notes').get('n1'))?.value).toEqual({ text: 'x' })
        target.close()
        const restored = new AppStore(context(), { dbPath: backup })
        await restored.ready
        try {
          expect((await gated(restored, 'info-hub').documents.get('settings'))?.value).toEqual({ usageRefreshMs: 7 })
        } finally {
          restored.close()
        }
      } finally {
        second.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('keeps the legacy shared KV face on the same namespace store', async () => {
    const store = new AppStore(context())
    await store.ready
    try {
      await store.set('settings', { mode: 'legacy' })
      expect(store.get('settings')).toEqual({ mode: 'legacy' })
      await store.update<{ mode: string }>('settings', current => ({ ...current, mode: 'updated' }))
      expect(store.get<{ mode: string }>('settings')).toEqual({ mode: 'updated' })
      expect(store.get()).toEqual({ settings: { mode: 'updated' } })
      await store.clear('settings')
      expect(store.get('settings')).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
