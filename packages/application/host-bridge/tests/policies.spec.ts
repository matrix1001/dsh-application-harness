import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PolicyFileStore } from '../src/policies.ts'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'application-harness-policies-'))
}

describe('the durable operation-policy table', () => {
  it('treats a missing file as the empty table and round-trips entries', async () => {
    const dir = home()
    try {
      const store = new PolicyFileStore(join(dir, 'policies.json'))
      expect(await store.list()).toEqual([])
      await store.save([{ appId: 'notes', operation: 'create', policy: 'confirm', updatedAt: '2026-01-01T00:00:00.000Z' }])
      expect(await store.list()).toEqual([{ appId: 'notes', operation: 'create', policy: 'confirm', updatedAt: '2026-01-01T00:00:00.000Z' }])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects a corrupt or malformed table instead of treating it as empty', async () => {
    const dir = home()
    try {
      const path = join(dir, 'policies.json')
      const store = new PolicyFileStore(path)
      writeFileSync(path, '{ not json')
      await expect(store.list()).rejects.toThrow(/not valid JSON/u)
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, policies: {} }))
      await expect(store.list()).rejects.toThrow(/carries no policies array/u)
      for (const entry of [
        null,
        { appId: '', operation: 'x', policy: 'allow', updatedAt: 't' },
        { appId: 'a', operation: '', policy: 'allow', updatedAt: 't' },
        { appId: 'a', operation: 'x', policy: 'default', updatedAt: 't' },
        { appId: 'a', operation: 'x', policy: 'allow', updatedAt: 1 },
      ]) {
        writeFileSync(path, JSON.stringify({ schemaVersion: 1, policies: [entry] }))
        await expect(store.list()).rejects.toThrow(/malformed entry/u)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
