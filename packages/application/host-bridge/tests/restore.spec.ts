/**
 * Per-application restore from a whole-database backup: preview/no-write,
 * exact namespace replacement, pre-restore backup, fingerprint guard, path
 * safety and the untouched sibling application.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteDataStore } from '@matrix1001/dsh-application-harness-store/sqlite-store'
import type { AppDeclaration } from '@matrix1001/dsh-application-harness-runtime'
import { host } from './harness.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'application-harness-restore-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function alpha(reload: () => void): AppDeclaration {
  return {
    id: 'alpha', name: 'alpha', description: 'restore target', version: '1.0.0',
    ops: {
      echo: {
        description: 'echo', params: { text: { type: 'string', required: true } }, result: { type: 'string' },
        execute: (args: unknown) => (args as { text: string }).text,
      },
    },
    reload,
  }
}

function seed(path: string): string {
  const store = new SqliteDataStore({ dbPath: path })
  store.putDocument('alpha', 'settings', { theme: 'dark' })
  store.putDocument('alpha', 'notes', { count: 1 })
  store.putDocument('alpha', 'same', { stable: true })
  store.putCollectionItem('alpha', 'items', 'one', { value: 1 })
  store.putCollectionItem('alpha', 'items', 'two', { value: 2 })
  store.putCollectionItem('alpha', 'same', 'stable', { value: 'same' })
  store.putCollectionItem('alpha', 'onlyBackup', 'backup-only', { value: true })
  store.setMeta('alpha', 'legacy-imported', 'yes')
  store.putDocument('beta', 'settings', { theme: 'light' })
  const backup = store.backupTo(`${path}.before-import-original`)
  store.close()
  return backup
}

function mutate(path: string): void {
  const store = new SqliteDataStore({ dbPath: path })
  store.putDocument('alpha', 'settings', { theme: 'changed' })
  store.putDocument('alpha', 'extra', { current: true })
  store.deleteDocument('alpha', 'notes')
  store.deleteCollectionItem('alpha', 'items', 'one')
  store.putCollectionItem('alpha', 'items', 'two', { value: 99 })
  store.putCollectionItem('alpha', 'items', 'three', { value: 3 })
  store.namespace('alpha').collections.open('onlyBackup').clear()
  store.putCollectionItem('alpha', 'onlyCurrent', 'current-only', { value: true })
  store.setMeta('alpha', 'legacy-imported', 'changed')
  store.close()
}

function dump(path: string): ReturnType<SqliteDataStore['exportAll']> {
  const store = new SqliteDataStore({ dbPath: path })
  try { return store.exportAll() } finally { store.close() }
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('application data restore', () => {
  it('previews without writing, restores ONE app exactly, and leaves a pre-restore backup', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const backup = seed(db)
    mutate(db)
    const sourceDigest = digest(backup)
    let reloads = 0
    const { bridge, dispose } = await host([alpha(() => { reloads += 1 })], {}, { dataPath: db })
    try {
      const preview = bridge.dataRestorePreview('alpha', backup)
      expect(preview).toMatchObject({
        appId: 'alpha', backupPath: backup,
        documents: { backupOnly: 1, currentOnly: 1, modified: 1, unchanged: 1 },
        collections: { backupOnly: 2, currentOnly: 2, modified: 1, unchanged: 1 },
        conflictCount: 5, truncated: false,
      })
      expect(preview.conflicts.map(item => `${item.kind}:${item.name}${item.key === undefined ? '' : `/${item.key}`}`).sort())
        .toEqual(['collection:items/three', 'collection:items/two', 'collection:onlyCurrent/current-only', 'document:extra', 'document:settings'])
      expect(preview.metaChanged).toEqual(['legacy-imported'])
      expect(digest(backup)).toBe(sourceDigest)
      // The preview itself did not change the current data.
      expect(dump(db).apps.alpha!.documents.extra).toBeDefined()

      const result = await bridge.dataRestore('alpha', backup, preview.previewFingerprint)
      expect(result).toMatchObject({
        appId: 'alpha', restoredFrom: backup, documents: 3, collections: 4, reload: 'ok',
      })
      expect(reloads).toBe(1)
      expect(result.backupPath).not.toBe(backup)
      expect(existsSync(result.backupPath)).toBe(true)
      expect(digest(backup)).toBe(sourceDigest)

      const restored = dump(db)
      expect(restored.apps.alpha!.documents.settings?.value).toEqual({ theme: 'dark' })
      expect(restored.apps.alpha!.documents.notes?.value).toEqual({ count: 1 })
      expect(restored.apps.alpha!.documents.same?.value).toEqual({ stable: true })
      expect(restored.apps.alpha!.documents.extra).toBeUndefined()
      expect(restored.apps.alpha!.collections.items?.map(row => row.key)).toEqual(['one', 'two'])
      expect(restored.apps.alpha!.collections.same?.map(row => row.key)).toEqual(['stable'])
      expect(restored.apps.alpha!.collections.onlyBackup?.map(row => row.key)).toEqual(['backup-only'])
      expect(restored.apps.alpha!.collections.onlyCurrent).toBeUndefined()
      expect(restored.apps.alpha!.meta).toEqual({ 'legacy-imported': 'yes' })
      expect(restored.apps.beta!.documents.settings?.value).toEqual({ theme: 'light' })
      expect(readdirSync(dirname(result.backupPath)).filter(name => name.startsWith(`${basename(db)}.before-import-`))).toHaveLength(2)
    } finally {
      await dispose()
    }
  })

  it('refuses a stale preview fingerprint and leaves the current data unchanged', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const backup = seed(db)
    mutate(db)
    const { bridge, dispose } = await host([alpha(() => {})], {}, { dataPath: db })
    try {
      const preview = bridge.dataRestorePreview('alpha', backup)
      const store = new SqliteDataStore({ dbPath: db })
      store.putDocument('alpha', 'settings', { theme: 'newer' })
      store.close()
      await expect(bridge.dataRestore('alpha', backup, preview.previewFingerprint)).rejects.toThrow(/changed since the restore preview/u)
      expect(dump(db).apps.alpha!.documents.settings?.value).toEqual({ theme: 'newer' })
    } finally {
      await dispose()
    }
  })

  it('rejects missing, live, foreign, symlinked and app-less backups', async () => {
    const dir = tempDir()
    const db = join(dir, 'app-data.sqlite')
    const backup = seed(db)
    const { bridge, dispose } = await host([alpha(() => {})], {}, { dataPath: db })
    try {
      expect(() => bridge.dataRestorePreview('alpha', join(dir, 'missing.sqlite'))).toThrow()
      expect(() => bridge.dataRestorePreview('alpha', db)).toThrow(/live database/u)
      const foreign = join(dir, 'foreign.sqlite')
      const store = new SqliteDataStore({ dbPath: foreign })
      store.close()
      expect(() => bridge.dataRestorePreview('alpha', foreign)).toThrow(/not a pre-import backup/u)
      const link = join(dir, 'link.sqlite')
      symlinkSync(backup, link)
      expect(() => bridge.dataRestorePreview('alpha', link)).toThrow(/symlink/u)
      const empty = new SqliteDataStore({ dbPath: join(dir, 'empty.sqlite') })
      empty.putDocument('beta', 'settings', { theme: 'light' })
      const noAlpha = empty.backupTo(join(dir, 'app-data.sqlite.before-import-empty'))
      empty.close()
      expect(() => bridge.dataRestorePreview('alpha', noAlpha)).toThrow(/no data for alpha/u)
      await expect(bridge.dataRestore('ghost', backup)).rejects.toThrow(/not registered/u)
    } finally {
      await dispose()
    }
  })
})


describe('application restore failure paths', () => {
  it('previews and restores into an empty live database (backup-only namespace)', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const backup = seed(db)
    rmSync(db, { force: true })
    const { bridge, dispose } = await host([alpha(() => {})], {}, { dataPath: db })
    try {
      const preview = bridge.dataRestorePreview('alpha', backup)
      expect(preview.documents).toMatchObject({ backupOnly: 3, currentOnly: 0, modified: 0, unchanged: 0 })
      expect(preview.collections).toMatchObject({ backupOnly: 4, currentOnly: 0, modified: 0, unchanged: 0 })
      const result = await bridge.dataRestore('alpha', backup, preview.previewFingerprint)
      expect(result).toMatchObject({ documents: 3, collections: 4, reload: 'ok' })
      expect(dump(db).apps.alpha!.documents.settings?.value).toEqual({ theme: 'dark' })
    } finally {
      await dispose()
    }
  })

  it('restores a stopped application offline and reports reload as skipped', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const backup = seed(db)
    mutate(db)
    const { bridge, runtime, dispose } = await host([alpha(() => { throw new Error('should not reload') })], {}, { dataPath: db })
    try {
      await runtime.stop('alpha')
      const result = await bridge.dataRestore('alpha', backup)
      expect(result).toMatchObject({ appId: 'alpha', reload: 'skipped', documents: 3, collections: 4 })
      expect(dump(db).apps.alpha!.documents.extra).toBeUndefined()
    } finally {
      await dispose()
    }
  })

  it('keeps the restore committed when the reload hook throws', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const backup = seed(db)
    mutate(db)
    const { bridge, dispose } = await host([alpha(() => { throw new Error('reload failed') })], {}, { dataPath: db })
    try {
      const result = await bridge.dataRestore('alpha', backup)
      expect(result).toMatchObject({ reload: 'failed', reloadError: 'reload failed' })
      expect(dump(db).apps.alpha!.documents.extra).toBeUndefined()
    } finally {
      await dispose()
    }
  })

  it('rejects an in-memory database, an empty path, an outside path and a directory', async () => {
    const memoryHost = await host([alpha(() => {})], {}, { dataPath: ':memory:' })
    try {
      expect(() => memoryHost.bridge.dataRestorePreview('alpha', '/tmp/x.sqlite')).toThrow(/in-memory/u)
    } finally {
      await memoryHost.dispose()
    }
    const dir = tempDir()
    const db = join(dir, 'app-data.sqlite')
    const backup = seed(db)
    const { bridge, dispose } = await host([alpha(() => {})], {}, { dataPath: db })
    try {
      expect(() => bridge.dataRestorePreview('alpha', '')).toThrow(/required/u)
      const outsideDir = tempDir()
      const outside = join(outsideDir, `${basename(db)}.before-import-outside`)
      // A real file outside the data directory is still refused by the parent check.
      const copy = new SqliteDataStore({ dbPath: outside })
      copy.close()
      expect(() => bridge.dataRestorePreview('alpha', outside)).toThrow(/beside the application database/u)
      const directory = join(dir, `${basename(db)}.before-import-directory`)
      mkdirSync(directory)
      expect(() => bridge.dataRestorePreview('alpha', directory)).toThrow(/regular file/u)
      await expect(bridge.dataRestore('alpha', backup, 'stale')).rejects.toThrow(/changed since the restore preview/u)
    } finally {
      await dispose()
    }
  })

  it('refuses a restore while the application is stopping', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const backup = seed(db)
    mutate(db)
    const { bridge, dispose } = await host([alpha(() => {})], {}, { dataPath: db })
    try {
      const stopping = bridge.stopApp('alpha')
      await expect(bridge.dataRestore('alpha', backup)).rejects.toThrow(/stopping/u)
      await stopping
    } finally {
      await dispose()
    }
  })


  it('reports a string reload failure without losing the committed data', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const backup = seed(db)
    mutate(db)
    const { bridge, dispose } = await host([alpha(() => { throw 'reload string' })], {}, { dataPath: db })
    try {
      const result = await bridge.dataRestore('alpha', backup)
      expect(result).toMatchObject({ reload: 'failed', reloadError: 'reload string' })
      expect(dump(db).apps.alpha!.documents.extra).toBeUndefined()
    } finally {
      await dispose()
    }
  })

  it('reports a backup failure for an offline app without a hold to release', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const backup = seed(db)
    mutate(db)
    const { bridge, runtime, dispose } = await host([alpha(() => {})], {}, { dataPath: db })
    const spy = vi.spyOn(SqliteDataStore.prototype, 'backupTo').mockImplementationOnce(() => { throw new Error('offline backup down') })
    try {
      await runtime.stop('alpha')
      await expect(bridge.dataRestore('alpha', backup)).rejects.toThrow(/offline backup down/u)
    } finally {
      spy.mockRestore()
      await dispose()
    }
  })

  it('releases the maintenance hold when the pre-restore backup fails', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const backup = seed(db)
    mutate(db)
    const { bridge, dispose } = await host([alpha(() => {})], {}, { dataPath: db })
    const spy = vi.spyOn(SqliteDataStore.prototype, 'backupTo').mockImplementationOnce(() => { throw new Error('backup down') })
    try {
      await expect(bridge.dataRestore('alpha', backup)).rejects.toThrow(/backup down/u)
      spy.mockRestore()
      // The failed restore released the hold: the app is callable again.
      expect((await bridge.call('alpha', 'echo', { text: 'ok' })).status).toBe('success')
    } finally {
      spy.mockRestore()
      await dispose()
    }
  })

})