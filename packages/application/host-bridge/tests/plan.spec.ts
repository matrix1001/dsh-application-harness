/** Short-lived import/restore plans: TTL, baseRevision and requestId replay. */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteDataStore } from '@matrix1001/dsh-application-harness-store/sqlite-store'
import { demoApp, host, waitFor } from './harness.ts'

const dirs: string[] = []
function tempDir(): string { const dir = mkdtempSync(join(tmpdir(), 'application-harness-plan-')); dirs.push(dir); return dir }
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })


describe('data plans', () => {
  it('replays an import commit for the same request id without a second backup', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const store = new SqliteDataStore({ dbPath: db })
    store.putDocument('alpha', 'settings', { theme: 'dark' })
    store.close()
    const { bridge, dispose } = await host([demoApp('alpha')], {}, { dataPath: db })
    try {
      const json = bridge.dataExport('alpha').json
      const preview = bridge.dataImportPreview('alpha', json)
      expect(preview.planId).toMatch(/^plan_/u)
      expect(preview.expiresAt).toBeGreaterThan(Date.now())
      const first = await bridge.dataImport('alpha', json, preview.planId, 'req-1')
      const replay = await bridge.dataImport('alpha', json, preview.planId, 'req-1')
      expect(replay).toEqual(first)
      expect(readdirSync(join(dirOf(db))).filter(name => name.startsWith('app-data.sqlite.before-import-'))).toHaveLength(1)
      await expect(bridge.dataImport('alpha', json, preview.planId, 'req-2')).rejects.toThrow(/already committed/u)
      // The explicit cancel path removes a plan before it is committed.
      const discarded = bridge.dataImportPreview('alpha', json)
      expect(bridge.discardDataPlan(discarded.planId!)).toBe(true)
      await expect(bridge.dataImport('alpha', json, discarded.planId, 'req-3')).rejects.toThrow(/missing or expired/u)
    } finally {
      await dispose()
    }
  })

  it('keeps a bounded automatic backup window after repeated imports', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const store = new SqliteDataStore({ dbPath: db })
    store.putDocument('alpha', 'settings', { theme: 'dark' })
    store.close()
    const { bridge, dispose } = await host([demoApp('alpha')], {}, { dataPath: db })
    try {
      const json = bridge.dataExport('alpha').json
      for (let index = 0; index < 6; index += 1) {
        const preview = bridge.dataImportPreview('alpha', json)
        await bridge.dataImport('alpha', json, preview.planId, `req-${String(index)}`)
      }
      expect(bridge.dataInfo('alpha').backupCount).toBe(5)
    } finally {
      await dispose()
    }
  })

  it('requires a request id, binds the plan to its app/kind, and bounds the plan table', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const store = new SqliteDataStore({ dbPath: db })
    store.putDocument('alpha', 'settings', { theme: 'dark' })
    store.close()
    const { bridge, dispose } = await host([demoApp('alpha'), demoApp('beta')], {}, { dataPath: db })
    try {
      const json = bridge.dataExport('alpha').json
      const preview = bridge.dataImportPreview('alpha', json)
      await expect(bridge.dataImport('alpha', json, preview.planId)).rejects.toThrow(/request id/u)
      await expect(bridge.dataImport('beta', json, preview.planId, 'req')).rejects.toThrow(/different application/u)
      const backupStore = new SqliteDataStore({ dbPath: db })
      const backup = backupStore.backupTo(`${db}.before-import-kind`)
      backupStore.close()
      const restorePlan = bridge.dataRestorePreview('alpha', backup)
      await expect(bridge.dataImport('alpha', json, restorePlan.planId, 'req')).rejects.toThrow(/different application or operation/u)
      let first: string | undefined
      for (let index = 0; index < 51; index += 1) {
        const next = bridge.dataImportPreview('alpha', json)
        first ??= next.planId
      }
      await expect(bridge.dataImport('alpha', json, first, 'req')).rejects.toThrow(/missing or expired/u)
    } finally {
      await dispose()
    }
  })

  it('refuses an import plan whose current base changed', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const store = new SqliteDataStore({ dbPath: db })
    store.putDocument('alpha', 'settings', { theme: 'dark' })
    store.close()
    const { bridge, dispose } = await host([demoApp('alpha')], {}, { dataPath: db })
    try {
      const json = bridge.dataExport('alpha').json
      const preview = bridge.dataImportPreview('alpha', json)
      const changed = new SqliteDataStore({ dbPath: db })
      changed.putDocument('alpha', 'settings', { theme: 'light' })
      changed.close()
      await expect(bridge.dataImport('alpha', json, preview.planId, 'req')).rejects.toThrow(/changed since the import preview/u)
    } finally {
      await dispose()
    }
  })

  it('expires an import plan', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const store = new SqliteDataStore({ dbPath: db })
    store.putDocument('alpha', 'settings', { theme: 'dark' })
    store.close()
    const { bridge, dispose } = await host([demoApp('alpha')], {}, { dataPath: db })
    try {
      const now = new Date('2026-01-01T00:00:00.000Z')
      vi.useFakeTimers()
      vi.setSystemTime(now)
      const json = bridge.dataExport('alpha').json
      const preview = bridge.dataImportPreview('alpha', json)
      vi.setSystemTime(now.getTime() + 6 * 60 * 1000)
      await expect(bridge.dataImport('alpha', json, preview.planId, 'req')).rejects.toThrow(/expired/u)
    } finally {
      await dispose()
    }
  })

  it('replays a restore commit for the same request id', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const store = new SqliteDataStore({ dbPath: db })
    store.putDocument('alpha', 'settings', { theme: 'dark' })
    const backup = store.backupTo(`${db}.before-import-original`)
    store.putDocument('alpha', 'settings', { theme: 'changed' })
    store.close()
    const { bridge, dispose } = await host([demoApp('alpha')], {}, { dataPath: db })
    try {
      const preview = bridge.dataRestorePreview('alpha', backup)
      const first = await bridge.dataRestore('alpha', backup, preview.previewFingerprint, preview.planId, 'req-1')
      const replay = await bridge.dataRestore('alpha', backup, preview.previewFingerprint, preview.planId, 'req-1')
      expect(replay).toEqual(first)
      await expect(bridge.dataRestore('alpha', backup, preview.previewFingerprint, preview.planId, 'req-2')).rejects.toThrow(/already committed/u)
    } finally {
      await dispose()
    }
  })

  /**
   * DATA-001: the preview fingerprint used to be compared BEFORE the maintenance
   * hold took the application out of service. A call that was already running
   * could commit while beginMaintenance waited for it, and the import/restore
   * then overwrote that write without ever re-checking the base.
   *
   * The gate op makes the window deterministic: it signals that it is running,
   * the test starts the commit, waits for the hold, then releases the write.
   * The write must therefore land between the preview and the commit.
   */
  it('refuses an import whose base moved while the hold drained', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const seed = new SqliteDataStore({ dbPath: db })
    seed.putDocument('alpha', 'settings', { theme: 'dark' })
    seed.close()
    let started!: () => void
    const running = new Promise<void>((resolve) => { started = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const base = demoApp('alpha')
    const app = {
      ...base,
      ops: {
        ...base.ops,
        lateWrite: {
          description: 'writes the application document when the test releases it',
          params: {},
          result: { type: 'json' as const },
          execute: async () => {
            started()
            await gate
            const store = new SqliteDataStore({ dbPath: db })
            try { store.putDocument('alpha', 'settings', { theme: 'light' }) } finally { store.close() }
            return { wrote: true }
          },
        },
      },
    }
    const { bridge, runtime, dispose } = await host([app], {}, { dataPath: db })
    try {
      const json = bridge.dataExport('alpha').json
      const preview = bridge.dataImportPreview('alpha', json)
      const inFlight = bridge.call('alpha', 'lateWrite', {})
      await running
      // Never an unhandled rejection: the refusal is settled into a value.
      const committing = bridge.dataImport('alpha', json, preview.planId, 'req-1').then(
        value => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      await waitFor(() => runtime.maintenance('alpha'))
      release()
      await inFlight
      const outcome = await committing
      expect(outcome.ok).toBe(false)
      expect(String((outcome as { error: unknown }).error)).toMatch(/changed since the import preview/u)
      const after = new SqliteDataStore({ dbPath: db })
      try { expect(after.exportAll().apps.alpha?.documents.settings?.value).toEqual({ theme: 'light' }) } finally { after.close() }
      // The refusal releases the hold: the application is callable again.
      expect(runtime.maintenance('alpha')).toBe(false)
    } finally {
      release()
      await dispose()
    }
  })

  it('refuses a restore whose base moved while the hold drained', async () => {
    const db = join(tempDir(), 'app-data.sqlite')
    const seed = new SqliteDataStore({ dbPath: db })
    seed.putDocument('alpha', 'settings', { theme: 'dark' })
    const backup = seed.backupTo(`${db}.before-import-original`)
    seed.close()
    let started!: () => void
    const running = new Promise<void>((resolve) => { started = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const base = demoApp('alpha')
    const app = {
      ...base,
      ops: {
        ...base.ops,
        lateWrite: {
          description: 'writes the application document when the test releases it',
          params: {},
          result: { type: 'json' as const },
          execute: async () => {
            started()
            await gate
            const store = new SqliteDataStore({ dbPath: db })
            try { store.putDocument('alpha', 'settings', { theme: 'light' }) } finally { store.close() }
            return { wrote: true }
          },
        },
      },
    }
    const { bridge, runtime, dispose } = await host([app], {}, { dataPath: db })
    try {
      const preview = bridge.dataRestorePreview('alpha', backup)
      const inFlight = bridge.call('alpha', 'lateWrite', {})
      await running
      const committing = bridge.dataRestore('alpha', backup, preview.previewFingerprint, preview.planId, 'req-1').then(
        value => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      await waitFor(() => runtime.maintenance('alpha'))
      release()
      await inFlight
      const outcome = await committing
      expect(outcome.ok).toBe(false)
      expect(String((outcome as { error: unknown }).error)).toMatch(/changed since the restore preview/u)
      const after = new SqliteDataStore({ dbPath: db })
      try { expect(after.exportAll().apps.alpha?.documents.settings?.value).toEqual({ theme: 'light' }) } finally { after.close() }
      expect(runtime.maintenance('alpha')).toBe(false)
    } finally {
      release()
      await dispose()
    }
  })
})

function dirOf(file: string): string { return dirname(file) }
