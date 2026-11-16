import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelLimitError, ModelLimitGate, ModelLimitStore, defaultLimits } from '../src/limits.ts'

describe('ModelLimitStore', () => {
  it('persists validated limits and starts from the default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-limits-'))
    const path = join(dir, 'limits.json')
    const store = new ModelLimitStore(path)
    expect(store.get('notes')).toEqual(defaultLimits())
    await store.set('notes', { background: false, maxConcurrent: 2, maxCallsPerMinute: 5 })
    expect(store.get('notes')).toEqual({ background: false, maxConcurrent: 2, maxCallsPerMinute: 5 })
    const loaded = new ModelLimitStore(path)
    await loaded.load()
    expect(loaded.get('notes')).toEqual({ background: false, maxConcurrent: 2, maxCallsPerMinute: 5 })
    await expect(store.set('notes', { background: true, maxConcurrent: 0 })).rejects.toThrow(/positive integer/u)
  })

  it('rejects malformed files and entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-limits-'))
    const path = join(dir, 'limits.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 1, apps: { notes: { background: 'yes' } } }))
    await expect(new ModelLimitStore(path).load()).rejects.toThrow(/background boolean/u)
    await writeFile(path, JSON.stringify({ schemaVersion: 1, apps: [] }))
    await expect(new ModelLimitStore(path).load()).rejects.toThrow(/apps object/u)
    await writeFile(path, JSON.stringify({ schemaVersion: 1, apps: { notes: null } }))
    await expect(new ModelLimitStore(path).load()).rejects.toThrow(/must be an object/u)
  })

  it('rolls back when the file cannot be written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-limits-'))
    const path = join(dir, 'table')
    await mkdir(path)
    const store = new ModelLimitStore(path)
    await expect(store.set('notes', { background: false })).rejects.toThrow()
    expect(store.get('notes')).toEqual({ background: true })

    const existingPath = join(dir, 'existing.json')
    await writeFile(existingPath, JSON.stringify({ schemaVersion: 1, apps: { notes: { background: false } } }))
    const existing = new ModelLimitStore(existingPath)
    await existing.load()
    await chmod(dir, 0o555)
    try {
      await expect(existing.set('notes', { background: true })).rejects.toThrow()
      expect(existing.get('notes')).toEqual({ background: false })
    } finally { await chmod(dir, 0o755) }
  })
})

describe('ModelLimitGate', () => {
  it('denies disabled background calls, concurrency and rate overruns, and releases slots', () => {
    const gate = new ModelLimitGate()
    expect(() => gate.begin('notes', true, { background: false })).toThrow(ModelLimitError)
    const release = gate.begin('notes', false, { background: true, maxConcurrent: 1 })
    expect(() => gate.begin('notes', false, { background: true, maxConcurrent: 1 })).toThrow(/in flight/u)
    release()
    release()
    expect(() => gate.begin('notes', false, { background: true, maxConcurrent: 1 })).not.toThrow()
    const now = 1_000
    gate.begin('rate', false, { background: true, maxCallsPerMinute: 2 }, now)
    gate.begin('rate', false, { background: true, maxCallsPerMinute: 2 }, now + 1_000)
    expect(() => gate.begin('rate', false, { background: true, maxCallsPerMinute: 2 }, now + 2_000)).toThrow(/this minute/u)
    expect(() => gate.begin('rate', false, { background: true, maxCallsPerMinute: 2 }, now + 61_000)).not.toThrow()
  })
})
