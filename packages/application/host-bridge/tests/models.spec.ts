import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelSelectionStore } from '../src/models.ts'

describe('ModelSelectionStore', () => {
  it('loads, replaces, clears and persists validated selections', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-models-'))
    const path = join(dir, 'models.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 1, apps: { notes: { provider: 'p', model: 'm' } } }))
    const store = new ModelSelectionStore(path)
    await store.load()
    expect(store.get('notes')).toEqual({ provider: 'p', model: 'm' })
    await store.set('tasks', { provider: 'q', model: 'n' })
    expect(store.get('tasks')).toEqual({ provider: 'q', model: 'n' })
    expect(JSON.parse(await readFile(path, 'utf8')).apps.tasks).toEqual({ provider: 'q', model: 'n' })
    await store.set('tasks', null)
    expect(store.get('tasks')).toBeUndefined()
    await expect(store.set('tasks', { provider: '', model: 'x' })).rejects.toThrow(/provider and model/u)
  })

  it('refuses a malformed file and bad entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-models-'))
    const path = join(dir, 'models.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 1, apps: { notes: { provider: 'p' } } }))
    await expect(new ModelSelectionStore(path).load()).rejects.toThrow(/provider and model/u)
    await writeFile(path, JSON.stringify({ schemaVersion: 1, apps: [] }))
    await expect(new ModelSelectionStore(path).load()).rejects.toThrow(/apps object/u)
    await writeFile(path, JSON.stringify({ schemaVersion: 2, apps: {} }))
    await expect(new ModelSelectionStore(path).load()).rejects.toThrow(/schema/u)
    await writeFile(path, JSON.stringify({ schemaVersion: 1, apps: { notes: [] } }))
    await expect(new ModelSelectionStore(path).load()).rejects.toThrow(/must be an object/u)
    await writeFile(path, JSON.stringify({ schemaVersion: 1, apps: { notes: { provider: 'p', model: '' } } }))
    await expect(new ModelSelectionStore(path).load()).rejects.toThrow(/provider and model/u)
  })

  it('rolls the in-memory entry back when the file cannot be written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-models-'))
    const path = join(dir, 'table')
    await mkdir(path)
    const store = new ModelSelectionStore(path)
    await expect(store.set('notes', { provider: 'p', model: 'm' })).rejects.toThrow()
    expect(store.get('notes')).toBeUndefined()

    const existingPath = join(dir, 'existing.json')
    await writeFile(existingPath, JSON.stringify({ schemaVersion: 1, apps: { notes: { provider: 'old', model: 'old' } } }))
    const existing = new ModelSelectionStore(existingPath)
    await existing.load()
    await chmod(dir, 0o555)
    try {
      await expect(existing.set('notes', { provider: 'new', model: 'new' })).rejects.toThrow()
      expect(existing.get('notes')).toEqual({ provider: 'old', model: 'old' })
    } finally { await chmod(dir, 0o755) }
  })
})
