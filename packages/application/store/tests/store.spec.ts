import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AppStore } from '../src/index.ts'

const ctx = { reflect: { provide: () => {} } } as unknown as Context

describe('AppStore: in-memory (no storePath)', () => {
  test('get/set/update/clear operate on the in-memory blob without persistence', async () => {
    const store = new AppStore(ctx)
    expect(store.get()).toEqual({})
    expect(store.get('a')).toBeUndefined()
    await store.set('a', 1)
    expect(store.get('a')).toBe(1)
    await store.update<number>('a', current => (current ?? 0) + 1)
    expect(store.get('a')).toBe(2)
    await store.clear('a')
    expect(store.get('a')).toBeUndefined()
    await store.set('b', 2)
    await store.clear()
    expect(store.get()).toEqual({})
  })

  test('update seeds an undefined scope and set persists without a file', async () => {
    const store = new AppStore(ctx)
    await store.update<string>('list', current => current ?? [])
    expect(store.get('list')).toEqual([])
    await store.set('x', { ok: true })
    expect(store.get('x')).toEqual({ ok: true })
  })
})

describe('AppStore: persistence (storePath)', () => {
  test('set persists the blob and a fresh store reloads it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    const path = join(dir, 's.json')
    try {
      const s1 = new AppStore(ctx, { storePath: path })
      // `set` resolves AFTER its atomic write, so the file is already on disk.
      await s1.set('settings', { autoRefreshMs: 600000 })
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ settings: { autoRefreshMs: 600000 } })
      const s2 = new AppStore(ctx, { storePath: path })
      // Awaiting `ready` waits for the async load; a fixed sleep raced under load
      // (release:check 2026-09-19: the 20 ms sleep lost to a busy machine).
      await s2.ready
      expect(s2.get('settings')).toEqual({ autoRefreshMs: 600000 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a fresh store exposes the persisted blob once start() settles (no manual sleep)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    const path = join(dir, 's.json')
    try {
      writeFileSync(path, JSON.stringify({ settings: { autoRefreshMs: 600000, platformToken: 'tok' } }))
      const s2 = new AppStore(ctx, { storePath: path })
      // Awaiting `ready` waits for the async file load, so the very next
      // synchronous read sees the persisted value — the boot race a sibling
      // app reading the store in its own start would otherwise hit is closed.
      await s2.ready
      expect(s2.get('settings')).toEqual({ autoRefreshMs: 600000, platformToken: 'tok' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('concurrent set/update serialize their writes and never interleave', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    const path = join(dir, 's.json')
    try {
      const s = new AppStore(ctx, { storePath: path })
      await Promise.all([s.set('a', 1), s.set('b', 2), s.update<number>('a', c => (c ?? 0) + 10)])
      await new Promise(r => setTimeout(r, 30))
      const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      expect(Object.keys(saved).sort()).toEqual(['a', 'b'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing file is the first run and loads empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    try {
      const store = new AppStore(ctx, { storePath: join(dir, 'missing.json') })
      await store.ready
      expect(store.loadFailure).toBeUndefined()
      expect(store.get()).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each([
    ['unparseable text', '{ not json'],
    ['a JSON array', JSON.stringify([1, 2])],
    ['JSON null', JSON.stringify(null)],
  ])('refuses to read or overwrite %s', async (_label, content) => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    const path = join(dir, 's.json')
    writeFileSync(path, content)
    const before = readFileSync(path, 'utf8')
    try {
      const store = new AppStore(ctx, { storePath: path })
      await store.ready
      expect(store.loadFailure).toMatchObject({ code: 'storage-corrupt' })
      expect(() => store.get()).toThrow(/storage-corrupt/)
      await expect(store.set('a', 1)).rejects.toMatchObject({ code: 'storage-corrupt' })
      await expect(store.clear()).rejects.toMatchObject({ code: 'storage-corrupt' })
      // The unreadable bytes are still exactly what the process found.
      expect(readFileSync(path, 'utf8')).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unreadable path is storage-unavailable and is never overwritten', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    const path = join(dir, 'as-directory')
    mkdirSync(path)
    try {
      const store = new AppStore(ctx, { storePath: path })
      await store.ready
      expect(store.loadFailure).toMatchObject({ code: 'storage-unavailable' })
      expect(() => store.get()).toThrow(/storage-unavailable/)
      await expect(store.set('a', 1)).rejects.toMatchObject({ code: 'storage-unavailable' })
      expect(existsSync(path)).toBe(true)
      expect(readdirSync(path)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a mutation before the initial load resolves is merged, not lost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    const path = join(dir, 's.json')
    writeFileSync(path, JSON.stringify({ preset: 1, shared: 'old' }))
    try {
      const s = new AppStore(ctx, { storePath: path })
      await s.set('a', 2)
      expect(s.get('a')).toBe(2)
      // The pre-load mutation is folded over the loaded blob: previously
      // persisted scopes are preserved alongside the pre-load write.
      await new Promise(r => setTimeout(r, 20))
      expect(s.get('preset')).toBe(1)
      expect(s.get('shared')).toBe('old')
      expect(s.get('a')).toBe(2)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ preset: 1, shared: 'old', a: 2 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a write is an atomic rewrite: the blob replaces the path and leaves no temp file behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    const path = join(dir, 's.json')
    // The shared primitive (`anchor/atomic`) names its temp uniquely
    // (`<path>.<pid>.<seq>.tmp`) and renames it away; a LEGACY fixed-name
    // remnant is a pre-existing file the new protocol neither claims nor
    // truncates (it is inert — nothing ever reads it), so it may stay.
    writeFileSync(path + '.tmp', 'stale partial write')
    try {
      const s = new AppStore(ctx, { storePath: path })
      await s.set('a', 1)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 })
      expect(readdirSync(dir).filter(name => !name.startsWith('s.json')).filter(name => name !== 's.json.tmp')).toEqual([])
      expect(existsSync(path + '.tmp')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a scope cleared before the initial load settles does not resurrect from the loaded blob', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    const path = join(dir, 's.json')
    writeFileSync(path, JSON.stringify({ preset: 1, shared: 'old' }))
    try {
      const s = new AppStore(ctx, { storePath: path })
      await s.clear('shared')
      expect(s.get('shared')).toBeUndefined()
      // The pre-load clear is folded over the loaded blob: the cleared scope
      // stays cleared while untouched loaded scopes survive.
      await new Promise(r => setTimeout(r, 20))
      expect(s.get('shared')).toBeUndefined()
      expect(s.get('preset')).toBe(1)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ preset: 1 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a full clear before the initial load settles leaves an empty store, not the loaded blob', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    const path = join(dir, 's.json')
    writeFileSync(path, JSON.stringify({ preset: 1, shared: 'old' }))
    try {
      const s = new AppStore(ctx, { storePath: path })
      await s.clear()
      await new Promise(r => setTimeout(r, 20))
      expect(s.get()).toEqual({})
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a pre-load write of a scope cleared pre-load still wins (later mutation beats the clear mark)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    const path = join(dir, 's.json')
    writeFileSync(path, JSON.stringify({ a: 'old' }))
    try {
      const s = new AppStore(ctx, { storePath: path })
      await s.clear('a')
      await s.set('a', 'new')
      await new Promise(r => setTimeout(r, 20))
      expect(s.get('a')).toBe('new')
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 'new' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a failed write reaches its caller, and the queue still runs the next write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    const path = join(dir, 's.json')
    try {
      const s = new AppStore(ctx, { storePath: path })
      await s.ready
      // A directory at the target makes the atomic rename fail. The write that
      // asked for persistence must SEE that — reporting success for a write the
      // disk never took is the defect this closes.
      mkdirSync(path)
      await expect(s.set('a', 1)).rejects.toThrow()
      expect(s.get('a')).toBeUndefined()
      // The queue moves on: once the target is usable again the NEXT write
      // lands with the whole blob, instead of being lost with the failed one.
      rmSync(path, { recursive: true, force: true })
      await s.set('b', 2)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ b: 2 })
      const restarted = new AppStore(ctx, { storePath: path })
      await restarted.ready
      expect(restarted.get()).toEqual({ b: 2 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('AppStore: get() hands out a snapshot', () => {
  test('set captures its input and update cannot leak a mutable result', async () => {
    const store = new AppStore(ctx)
    const value = { nested: { n: 1 } }
    const pending = store.set('a', value)
    value.nested.n = 9
    await pending
    expect(store.get('a')).toEqual({ nested: { n: 1 } })
    await store.update('a', () => value)
    value.nested.n = 10
    expect(store.get('a')).toEqual({ nested: { n: 9 } })
    await expect(store.update<{ nested: { n: number } }>('a', current => {
      current!.nested.n = 100
      throw new Error('reducer failed')
    })).rejects.toThrow('reducer failed')
    expect(store.get('a')).toEqual({ nested: { n: 9 } })
  })

  test.each(['update', 'clear', 'clear-all'] as const)('a failed %s preserves committed data through a later write', async kind => {
    const dir = mkdtempSync(join(process.cwd(), 'tmp/store-failure-'))
    const path = join(dir, 'store.json')
    try {
      const store = new AppStore(ctx, { storePath: path })
      await store.set('a', { n: 1 })
      renameSync(path, join(dir, 'saved.json'))
      mkdirSync(path)
      const failure = kind === 'update'
        ? store.update<{ n: number }>('a', current => { current!.n = 2; return current! })
        : store.clear(kind === 'clear' ? 'a' : undefined)
      expect(store.get('a')).toEqual({ n: 1 })
      await expect(failure).rejects.toThrow()
      expect(store.get('a')).toEqual({ n: 1 })
      rmSync(path, { recursive: true })
      await store.set('b', 2)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: { n: 1 }, b: 2 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an update queued before loading computes from persisted state', async () => {
    const dir = mkdtempSync(join(process.cwd(), 'tmp/store-load-'))
    const path = join(dir, 'store.json')
    try {
      writeFileSync(path, JSON.stringify({ count: 5 }))
      const store = new AppStore(ctx, { storePath: path })
      await Promise.all([store.update<number>('count', n => n! + 1), store.update<number>('count', n => n! + 1)])
      expect(store.get('count')).toBe(7)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ count: 7 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an in-place edit of a scope read never reaches the store', async () => {
    const store = new AppStore(ctx)
    await store.set('settings', { autoRefreshMs: 600000, tags: ['a'] })
    const read = store.get<{ autoRefreshMs: number; tags: string[] }>('settings')!
    read.autoRefreshMs = 1
    read.tags.push('b')
    // The nested array is what proves the copy is deep: spreading one level
    // would still alias the array.
    expect(store.get('settings')).toEqual({ autoRefreshMs: 600000, tags: ['a'] })
  })

  test('an in-place edit of the whole-blob read never reaches the store', async () => {
    const store = new AppStore(ctx)
    await store.set('a', { n: 1 })
    const blob = store.get<Record<string, { n: number }>>()!
    blob.a!.n = 99
    blob.b = { n: 2 }
    expect(store.get()).toEqual({ a: { n: 1 } })
    // A fresh copy per read: the store hands out its value, not a view of it.
    expect(store.get()).not.toBe(store.get())
  })

  test('a read edited in place is not what the next write persists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'))
    const path = join(dir, 's.json')
    try {
      const store = new AppStore(ctx, { storePath: path })
      await store.set('settings', { token: 'tok' })
      store.get<{ token: string }>('settings')!.token = 'tampered'
      // Any later write persists the store's own blob, so the untouched value
      // is what reaches the file.
      await store.set('other', 1)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ settings: { token: 'tok' }, other: 1 })
      expect(store.get('settings')).toEqual({ token: 'tok' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
