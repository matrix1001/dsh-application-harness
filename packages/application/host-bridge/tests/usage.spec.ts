import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelUsageStore } from '../src/usage.ts'

describe('ModelUsageStore', () => {
  it('aggregates success, failure and missing usage, then persists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-usage-'))
    const path = join(dir, 'usage.json')
    const store = new ModelUsageStore(path)
    await store.record('notes', { status: 'success', durationMs: 10, model: { provider: 'p', model: 'm' }, inputTokens: 3, outputTokens: 4 })
    await store.record('notes', { status: 'failed', durationMs: 5 })
    await store.record('notes', { status: 'cancelled', durationMs: 2 })
    expect(store.get('notes')).toMatchObject({
      calls: 3, succeeded: 1, failed: 1, cancelled: 1, usageMissing: 2, totalDurationMs: 17,
      inputTokens: 3, outputTokens: 4, lastStatus: 'cancelled', lastModel: { provider: 'p', model: 'm' },
    })
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    expect(parsed.apps.notes.calls).toBe(3)
    const loaded = new ModelUsageStore(path)
    await loaded.load()
    expect(loaded.get('notes')).toMatchObject({ calls: 3, inputTokens: 3 })
  })

  it('starts empty and rejects malformed entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-usage-'))
    const path = join(dir, 'usage.json')
    expect(new ModelUsageStore(path).get('none').calls).toBe(0)
    await writeFile(path, JSON.stringify({ schemaVersion: 1, apps: { notes: { calls: -1 } } }))
    await expect(new ModelUsageStore(path).load()).rejects.toThrow(/non-negative/u)
    await writeFile(path, JSON.stringify({ schemaVersion: 1, apps: [] }))
    await expect(new ModelUsageStore(path).load()).rejects.toThrow(/apps object/u)
    await writeFile(path, JSON.stringify({ schemaVersion: 1, apps: { notes: [] } }))
    await expect(new ModelUsageStore(path).load()).rejects.toThrow(/must be an object/u)
  })

  it('rolls an entry back when the file cannot be written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-usage-'))
    const path = join(dir, 'table')
    await mkdir(path)
    const store = new ModelUsageStore(path)
    await expect(store.record('notes', { status: 'success', durationMs: 1 })).rejects.toThrow()
    expect(store.get('notes').calls).toBe(0)

    const existingPath = join(dir, 'existing.json')
    await writeFile(existingPath, JSON.stringify({ schemaVersion: 1, apps: { notes: { calls: 1, succeeded: 1, failed: 0, cancelled: 0, usageMissing: 0, totalDurationMs: 1 } } }))
    const existing = new ModelUsageStore(existingPath)
    await existing.load()
    await chmod(dir, 0o555)
    try {
      await expect(existing.record('notes', { status: 'success', durationMs: 1 })).rejects.toThrow()
      expect(existing.get('notes').calls).toBe(1)
    } finally { await chmod(dir, 0o755) }
  })
})
