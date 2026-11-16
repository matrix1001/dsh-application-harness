import { chmodSync, mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, utimesSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteDataStore } from '@matrix1001/dsh-application-harness-store/sqlite-store'
import type { AppDeclaration } from '@matrix1001/dsh-application-harness-runtime'
import { demoApp, host } from './harness.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'application-harness-data-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('application data page', () => {
  it('reports an absent database without creating it and exports an empty namespace', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const { bridge, dispose } = await host([], {}, { dataPath: db })
    try {
      expect(bridge.dataInfo('alpha')).toMatchObject({ appId: 'alpha', path: db, byteSize: 0, schemaVersion: 0, documentCount: 0, collections: {} })
      expect(existsSync(db)).toBe(false)
      const exported = JSON.parse(bridge.dataExport('alpha').json)
      expect(exported.apps).toEqual({})
    } finally {
      await dispose()
    }
  })

  it('reports an own-sqlite declaration at its declared data-root path and refuses namespace export', async () => {
    const dir = tempDir()
    const db = join(dir, 'app-data.sqlite')
    mkdirSync(join(dir, 'disk'), { recursive: true })
    writeFileSync(join(dir, 'disk/index.db'), 'index')
    const declaration = demoApp('disk-space', {
      generation: 2,
      data: { kind: 'own-sqlite', path: 'disk/index.db', schemaVersion: 2, backup: 'exclude' },
    })
    const { bridge, dispose } = await host([declaration], {}, { dataPath: db })
    try {
      expect(bridge.dataInfo('disk-space')).toMatchObject({
        path: join(dir, 'disk/index.db'), byteSize: 5, schemaVersion: 2, documentCount: 0, backups: [], backupCount: 0,
      })
      expect(() => bridge.dataExport('disk-space')).toThrow(/only unified namespaces/u)
      expect(() => bridge.dataImportPreview('disk-space', '{}')).toThrow(/only unified namespaces/u)
    } finally {
      await dispose()
    }
  })

  it('uses the declared unified namespace when it differs from the application id', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const store = new SqliteDataStore({ dbPath: db })
    store.putDocument('review', 'settings', { redact: true }, { schemaVersion: 1 })
    store.putCollectionItem('review', 'sessions', 's1', { title: 'one' })
    store.close()
    const declaration = demoApp('workspace-review', {
      generation: 2,
      data: { kind: 'unified', namespace: 'review', schemaVersion: 1 },
    })
    const { bridge, dispose } = await host([declaration], {}, { dataPath: db })
    try {
      expect(bridge.dataInfo('workspace-review')).toMatchObject({ appId: 'workspace-review', documentCount: 1, collections: { sessions: 1 } })
      const dumped = JSON.parse(bridge.dataExport('workspace-review').json)
      expect(Object.keys(dumped.apps)).toEqual(['review'])
      expect(dumped.apps.review.documents.settings.value).toEqual({ redact: true })
    } finally {
      await dispose()
    }
  })

  it('reports a declared files directory without reading it as a unified namespace', async () => {
    const dir = tempDir()
    const db = join(dir, 'app-data.sqlite')
    mkdirSync(join(dir, 'files'), { recursive: true })
    writeFileSync(join(dir, 'files/data.bin'), 'bytes')
    const declaration = demoApp('files-app', {
      generation: 2,
      data: { kind: 'files', path: 'files', schemaVersion: 3, backup: 'exclude' },
    })
    const { bridge, dispose } = await host([declaration], {}, { dataPath: db })
    try {
      expect(bridge.dataInfo('files-app')).toMatchObject({
        path: join(dir, 'files'), schemaVersion: 3, documentCount: 0, collections: {},
      })
    } finally {
      await dispose()
    }
  })

  it('reads one namespace only and exports its schema facts', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const store = new SqliteDataStore({ dbPath: db })
    store.putDocument('alpha', 'settings', { theme: 'dark' }, { schemaVersion: 3 })
    store.putCollectionItem('alpha', 'inbox', 'one', { title: 'one' })
    store.putCollectionItem('alpha', 'inbox', 'two', { title: 'two' })
    store.putDocument('beta', 'settings', { theme: 'light' }, { schemaVersion: 9 })
    store.close()

    const { bridge, dispose } = await host([], {}, { dataPath: db })
    try {
      expect(bridge.dataInfo('alpha')).toMatchObject({ schemaVersion: 3, documentCount: 1, collections: { inbox: 2 } })
      expect(bridge.dataInfo('beta')).toMatchObject({ schemaVersion: 9, documentCount: 1, collections: {} })
      expect(bridge.dataInfo('missing')).toMatchObject({ schemaVersion: 0, documentCount: 0, collections: {} })
      const dumped = JSON.parse(bridge.dataExport('alpha').json)
      expect(Object.keys(dumped.apps)).toEqual(['alpha'])
      expect(dumped.apps.alpha.documents.settings.value).toEqual({ theme: 'dark' })
      expect(dumped.apps.alpha.collections.inbox).toHaveLength(2)
      expect(JSON.parse(bridge.dataExport('missing').json).apps).toEqual({})
    } finally {
      await dispose()
    }
  })
})


it('mounts with the row default data path when the deployment omits the config', async () => {
  const home = tempDir()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { bridge, dispose } = await host([], {}, { dataPath: null })
    try {
      expect(bridge.dataInfo('alpha').path).toBe(join(home, 'application-harness/app-data.sqlite'))
    } finally {
      await dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})


describe('application data import', () => {
  it('lists the five newest pre-import snapshots beside the database', async () => {
    const dir = tempDir()
    const db = join(dir, 'app-data.sqlite')
    for (let index = 0; index < 6; index += 1) {
      const path = join(dir, `app-data.sqlite.before-import-${String(index)}`)
      writeFileSync(path, `backup-${String(index)}`)
      utimesSync(path, new Date(1_000 + index * 1_000), new Date(1_000 + index * 1_000))
    }
    const { bridge, dispose } = await host([], {}, { dataPath: db })
    try {
      const info = bridge.dataInfo('alpha')
      expect(info.backupCount).toBe(6)
      expect(info.backups).toHaveLength(5)
      expect(info.backups[0]?.path).toBe(join(dir, 'app-data.sqlite.before-import-5'))
      expect(info.backups[0]?.byteSize).toBe(Buffer.byteLength('backup-5'))
      expect(info.backups.at(-1)?.path).toBe(join(dir, 'app-data.sqlite.before-import-1'))
    } finally {
      await dispose()
    }
  })

  it('prunes only the oldest snapshots, and only on an explicit positive keep', async () => {
    const dir = tempDir()
    const db = join(dir, 'app-data.sqlite')
    for (let index = 0; index < 7; index += 1) {
      const path = join(dir, `app-data.sqlite.before-import-${String(index)}`)
      writeFileSync(path, `backup-${String(index)}`)
      utimesSync(path, new Date(1_000 + index * 1_000), new Date(1_000 + index * 1_000))
    }
    const { bridge, dispose } = await host([], {}, { dataPath: db })
    try {
      expect(bridge.dataInfo('alpha').backupCount).toBe(7)
      await expect(bridge.dataPruneBackups(0)).rejects.toThrow(/positive integer/u)
      expect((await bridge.dataPruneBackups(5)).removed).toBe(2)
      const remaining = readdirSync(dir).filter(name => name.startsWith('app-data.sqlite.before-import-')).sort()
      expect(remaining).toEqual(['app-data.sqlite.before-import-2', 'app-data.sqlite.before-import-3', 'app-data.sqlite.before-import-4', 'app-data.sqlite.before-import-5', 'app-data.sqlite.before-import-6'])
      // Pruning again removes nothing: the keep count is already satisfied.
      expect((await bridge.dataPruneBackups(5)).removed).toBe(0)
    } finally {
      await dispose()
    }
  })

  it('reports a backup it could not remove instead of counting it', async () => {
    const dir = tempDir()
    const db = join(dir, 'app-data.sqlite')
    for (let index = 0; index < 3; index += 1) {
      const path = join(dir, `app-data.sqlite.before-import-${String(index)}`)
      writeFileSync(path, `backup-${String(index)}`)
      utimesSync(path, new Date(1_000 + index * 1_000), new Date(1_000 + index * 1_000))
    }
    const { ctx, bridge, dispose } = await host([], {}, { dataPath: db })
    const warned: string[] = []
    ctx.logger.warn = ((...args: unknown[]) => { warned.push(args.map(String).join(' ')) }) as typeof ctx.logger.warn
    chmodSync(dir, 0o500)
    try {
      expect((await bridge.dataPruneBackups(1)).removed).toBe(0)
      expect(warned.join(' ')).toContain('could not be removed')
    } finally {
      chmodSync(dir, 0o700)
      await dispose()
    }
  })

  it('treats in-memory, missing-directory, directory and broken-link snapshots as no snapshots', async () => {
    const memory = await host([], {}, { dataPath: ':memory:' })
    try {
      expect(memory.bridge.dataInfo('alpha')).toMatchObject({ backups: [], backupCount: 0 })
    } finally {
      await memory.dispose()
    }

    const missingDir = join(tempDir(), 'missing', 'app-data.sqlite')
    const missing = await host([], {}, { dataPath: missingDir })
    try {
      expect(missing.bridge.dataInfo('alpha')).toMatchObject({ backups: [], backupCount: 0 })
    } finally {
      await missing.dispose()
    }

    const dir = tempDir()
    mkdirSync(join(dir, 'app-data.sqlite.before-import-dir'))
    symlinkSync(join(dir, 'missing-target'), join(dir, 'app-data.sqlite.before-import-broken'))
    const odd = await host([], {}, { dataPath: join(dir, 'app-data.sqlite') })
    try {
      expect(odd.bridge.dataInfo('alpha')).toMatchObject({ backups: [], backupCount: 0 })
    } finally {
      await odd.dispose()
    }
  })

  it('reports the legacy migration markers this namespace recorded', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const store = new SqliteDataStore({ dbPath: db })
    store.namespace('alpha').meta.set('legacy-workbook-imported', '2026-10-20T00:00:00.000Z')
    store.namespace('alpha').meta.set('legacy-settings-imported', '2026-10-19T00:00:00.000Z')
    store.namespace('alpha').meta.set('unrelated', 'hidden')
    store.close()
    const { bridge, dispose } = await host([], {}, { dataPath: db })
    try {
      expect(bridge.dataInfo('alpha').legacyImports).toEqual({
        'legacy-settings-imported': '2026-10-19T00:00:00.000Z',
        'legacy-workbook-imported': '2026-10-20T00:00:00.000Z',
      })
      expect(bridge.dataInfo('beta').legacyImports).toEqual({})
    } finally {
      await dispose()
    }
  })

  it('previews in memory, backs up and restores only the named namespace', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const store = new SqliteDataStore({ dbPath: db })
    store.putDocument('alpha', 'settings', { theme: 'dark' })
    store.putCollectionItem('alpha', 'inbox', 'one', { title: 'one' })
    store.putCollectionItem('beta', 'inbox', 'other', { title: 'keep me' })
    store.close()

    const { bridge, dispose } = await host([demoApp('alpha')], {}, { dataPath: db })
    try {
      const json = bridge.dataExport('alpha').json
      const preview = bridge.dataImportPreview('alpha', json)
      expect(preview).toMatchObject({
        appId: 'alpha', apps: 1, documents: 1, collections: 1,
        newDocuments: 0, overwrittenDocuments: 1, removedDocuments: 0,
        newCollectionItems: 0, overwrittenCollectionItems: 1, removedCollectionItems: 0,
      })
      const result = await bridge.dataImport('alpha', json)
      expect(result).toMatchObject({ appId: 'alpha', apps: 1, documents: 1, collections: 1, overwrittenDocuments: 1, reload: 'ok' })
      expect(existsSync(result.backupPath)).toBe(true)
      // The import merged alpha and left beta alone.
      expect(bridge.dataInfo('beta').collections).toEqual({ inbox: 1 })
      expect(bridge.dataInfo('alpha').collections).toEqual({ inbox: 1 })
    } finally {
      await dispose()
    }
  })

  it('previews the merge delta: new versus overwritten, and never a delete', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const store = new SqliteDataStore({ dbPath: db })
    store.putDocument('alpha', 'settings', { theme: 'dark' })
    store.putCollectionItem('alpha', 'inbox', 'one', { title: 'one' })
    store.close()
    const { bridge, dispose } = await host([], {}, { dataPath: db })
    try {
      const json = JSON.stringify({
        version: 1,
        exportedAt: 1,
        apps: {
          alpha: {
            documents: {
              settings: { schemaVersion: 1, revision: 1, value: { theme: 'light' }, updatedAt: 1 },
              extra: { schemaVersion: 1, revision: 1, value: { fresh: true }, updatedAt: 1 },
            },
            collections: {
              inbox: [
                { key: 'one', seq: 1, value: { title: 'one' }, updatedAt: 1 },
                { key: 'two', seq: 2, value: { title: 'two' }, updatedAt: 2 },
              ],
            },
            meta: {},
          },
        },
      })
      expect(bridge.dataImportPreview('alpha', json)).toMatchObject({
        documents: 2,
        collections: 2,
        newDocuments: 1,
        overwrittenDocuments: 1,
        removedDocuments: 0,
        newCollectionItems: 1,
        overwrittenCollectionItems: 1,
        removedCollectionItems: 0,
      })
    } finally {
      await dispose()
    }
  })

  it('previews a missing database as all new', async () => {
    const db = join(tempDir(), 'missing.sqlite')
    const { bridge, dispose } = await host([], {}, { dataPath: db })
    try {
      const json = JSON.stringify({
        version: 1,
        exportedAt: 1,
        apps: {
          alpha: {
            documents: { settings: { schemaVersion: 1, revision: 1, value: { theme: 'light' }, updatedAt: 1 } },
            collections: { inbox: [{ key: 'one', seq: 1, value: { title: 'one' }, updatedAt: 1 }] },
            meta: {},
          },
        },
      })
      expect(bridge.dataImportPreview('alpha', json)).toMatchObject({
        newDocuments: 1,
        overwrittenDocuments: 0,
        removedDocuments: 0,
        newCollectionItems: 1,
        overwrittenCollectionItems: 0,
        removedCollectionItems: 0,
      })
    } finally {
      await dispose()
    }
  })

  it('refuses an empty export with a clear reason instead of crashing', async () => {
    const { bridge, dispose } = await host([demoApp('alpha')])
    try {
      const empty = JSON.stringify({ version: 1, exportedAt: 1, apps: {} })
      expect(() => bridge.dataImportPreview('alpha', empty)).toThrow(/no data for alpha/u)
      await expect(bridge.dataImport('alpha', empty)).rejects.toThrow(/no data for alpha/u)
    } finally {
      await dispose()
    }
  })

  it('asks the running application to reload after the import commits', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    let reloads = 0
    const app: AppDeclaration = {
      id: 'alpha',
      name: 'alpha',
      description: 'the import target',
      version: '1.0.0',
      ops: {
        echo: {
          description: 'echoes',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: (args: unknown) => (args as { text: string }).text,
        },
      },
      reload: () => { reloads += 1 },
    }
    const { bridge, dispose } = await host([app], {}, { dataPath: db })
    try {
      const json = JSON.stringify({ version: 1, apps: { alpha: { documents: {}, collections: {}, meta: {} } } })
      const result = await bridge.dataImport('alpha', json)
      expect(result.reload).toBe('ok')
      expect(reloads).toBe(1)
    } finally {
      await dispose()
    }
  })

  it('keeps the committed import when the reload hook throws, holds the app, and releases it on retry', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    let refuse = true
    let reloads = 0
    const app: AppDeclaration = {
      ...demoApp('alpha'),
      reload: () => {
        if (refuse) throw 'reload refused'
        reloads += 1
      },
    }
    const { bridge, dispose } = await host([app], {}, { dataPath: db })
    try {
      const json = JSON.stringify({ version: 1, apps: { alpha: { documents: {}, collections: {}, meta: {} } } })
      const result = await bridge.dataImport('alpha', json)
      expect(existsSync(result.backupPath)).toBe(true)
      expect(result).toMatchObject({ reload: 'failed', reloadError: 'reload refused' })
      // The committed import is not served through a stale cache: the app is
      // held out of service until the reload really succeeds.
      expect(await bridge.call('alpha', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.unavailable' } })
      refuse = false
      await bridge.dataReload('alpha')
      expect(reloads).toBe(1)
      expect(await bridge.call('alpha', 'echo', { text: 'x' })).toMatchObject({ status: 'success', result: { text: 'x' } })
    } finally {
      await dispose()
    }
  })

  it('refuses an import for an application that is not registered', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const { bridge, dispose } = await host([], {}, { dataPath: db })
    try {
      const json = JSON.stringify({ version: 1, apps: { ghost: { documents: {}, collections: {}, meta: {} } } })
      await expect(bridge.dataImport('ghost', json)).rejects.toThrow(/not registered/)
      expect(bridge.dataInfo('ghost').documentCount).toBe(0)
    } finally {
      await dispose()
    }
  })

  it('holds a running application: the import waits for its in-flight call and refuses new calls', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    let release: (() => void) | undefined
    const app: AppDeclaration = {
      ...demoApp('alpha'),
      ops: {
        echo: {
          description: 'waits for release',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: async (args) => {
            await new Promise<void>((resolve) => { release = resolve })
            return (args as { text: string }).text
          },
        },
      },
    }
    const { bridge, dispose } = await host([app], {}, { dataPath: db })
    try {
      const json = JSON.stringify({ version: 1, apps: { alpha: { documents: {}, collections: {}, meta: {} } } })
      const inFlight = bridge.call('alpha', 'echo', { text: 'before' })
      const importing = bridge.dataImport('alpha', json)
      for (let turn = 0; release === undefined && turn < 100; turn += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 1) })
      }
      expect(await bridge.call('alpha', 'echo', { text: 'after' })).toMatchObject({ status: 'rejected', error: { code: 'platform.unavailable' } })
      release?.()
      expect(await inFlight).toMatchObject({ status: 'success' })
      expect((await importing).reload).toBe('ok')
    } finally {
      await dispose()
    }
  })

  it('imports a stopped application offline and reports the reload as skipped', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const { bridge, dispose } = await host([demoApp('alpha')], {}, { dataPath: db })
    try {
      await bridge.stopApp('alpha')
      const json = JSON.stringify({ version: 1, apps: { alpha: { documents: {}, collections: {}, meta: {} } } })
      const result = await bridge.dataImport('alpha', json)
      expect(result.reload).toBe('skipped')
    } finally {
      await dispose()
    }
  })

  it('refuses an import while the application is stopping', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    let release: (() => void) | undefined
    const app: AppDeclaration = {
      ...demoApp('alpha'),
      stop: async () => { await new Promise<void>((resolve) => { release = resolve }) },
    }
    const { bridge, dispose } = await host([app], {}, { dataPath: db })
    try {
      const stopping = bridge.stopApp('alpha')
      for (let turn = 0; release === undefined && turn < 100; turn += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 1) })
      }
      const json = JSON.stringify({ version: 1, apps: { alpha: { documents: {}, collections: {}, meta: {} } } })
      await expect(bridge.dataImport('alpha', json)).rejects.toThrow(/stopping/)
      release?.()
      await stopping
    } finally {
      await dispose()
    }
  })

  it('releases the import hold when the store cannot be opened', async () => {
    const dir = tempDir()
    const db = join(dir, 'not-a-database')
    mkdirSync(db)
    const { bridge, dispose } = await host([demoApp('alpha')], {}, { dataPath: db })
    try {
      const json = JSON.stringify({ version: 1, apps: { alpha: { documents: {}, collections: {}, meta: {} } } })
      await expect(bridge.dataImport('alpha', json)).rejects.toThrow()
      // The hold was released by the failure path: the app is callable again.
      expect(await bridge.call('alpha', 'echo', { text: 'after' })).toMatchObject({ status: 'success' })
    } finally {
      await dispose()
    }
  })

  it('does not take a hold for a stopped application when the store fails', async () => {
    const dir = tempDir()
    const db = join(dir, 'not-a-database')
    mkdirSync(db)
    const { bridge, dispose } = await host([demoApp('alpha')], {}, { dataPath: db })
    try {
      await bridge.stopApp('alpha')
      const json = JSON.stringify({ version: 1, apps: { alpha: { documents: {}, collections: {}, meta: {} } } })
      await expect(bridge.dataImport('alpha', json)).rejects.toThrow()
    } finally {
      await dispose()
    }
  })

  it('refuses a reload for an unknown application or one that is not held', async () => {
    const { bridge, dispose } = await host([demoApp('alpha')], {}, { dataPath: join(tempDir(), 'app-data.sqlite') })
    try {
      await expect(bridge.dataReload('ghost')).rejects.toThrow(/not registered/)
      await expect(bridge.dataReload('alpha')).rejects.toThrow(/not waiting for a reload/)
    } finally {
      await dispose()
    }
  })

  it('refuses invalid JSON, the wrong version, and a dump without this app', async () => {
    const { bridge, dispose } = await host([], {}, { dataPath: join(tempDir(), 'app-data.sqlite') })
    try {
      expect(() => bridge.dataImportPreview('alpha', 'not json')).toThrow(/valid JSON/)
      expect(() => bridge.dataImportPreview('alpha', '{"version":2,"apps":{}}')).toThrow(/version-1/)
      expect(() => bridge.dataImportPreview('alpha', '{"version":1,"apps":{"beta":{}}}')).toThrow(/no data for alpha/)
      expect(bridge.dataImportPreview('alpha', '{"version":1,"apps":{"alpha":{"documents":{},"collections":{},"meta":{}}}}')).toMatchObject({ apps: 1 })
    } finally {
      await dispose()
    }
  })
})

describe('bridge secret port and own-data edge', () => {
  it('moves declared secrets through the host store and reports a missing own database', async () => {
    const dir = tempDir()
    const db = join(dir, 'app-data.sqlite')
    const declaration = demoApp('vault', {
      generation: 2,
      capabilities: ['storage'],
      data: { kind: 'unified', namespace: 'vault', schemaVersion: 1, secretFields: ['token'] },
      ops: {
        probe: {
          description: 'probe secrets',
          params: {},
          result: { type: 'json' },
          execute: async (_args, ctx) => {
            await ctx.secrets.set('token', 'value')
            const value = await ctx.secrets.get('token')
            const names = [...await ctx.secrets.names()]
            const has = await ctx.secrets.has('token')
            await ctx.secrets.delete('token')
            return { names, has, value: value ?? null }
          },
        },
      },
    })
    const { bridge, runtime, dispose } = await host([declaration], {}, { dataPath: db })
    try {
      await runtime.grant({ caller: { kind: 'app', appId: 'vault' }, capabilities: ['capability:storage'], grantedAt: '2026-01-01T00:00:00.000Z' })
      expect(await runtime.call({ kind: 'human' }, 'vault', 'probe', {})).toMatchObject({ status: 'success', result: { names: ['token'], has: true, value: 'value' } })

      const missing = demoApp('missing-own', {
        generation: 2,
        data: { kind: 'own-sqlite', path: 'missing/index.db', schemaVersion: 3, backup: 'exclude' },
      })
      await runtime.register(missing)
      expect(bridge.dataInfo('missing-own')).toMatchObject({ path: join(dir, 'missing/index.db'), schemaVersion: 3 })

    } finally {
      await dispose()
    }
  })
})
