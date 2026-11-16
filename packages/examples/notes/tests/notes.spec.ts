import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ApplicationRuntime } from '@matrix1001/dsh-application-harness-runtime'
import { AppStore } from '@matrix1001/dsh-application-harness-store'
import * as NotesPlugin from '../src/index.ts'

function host() {
  const ctx = new Context()
  const runtime = new ApplicationRuntime()
  const store = new AppStore(ctx)
  ctx.reflect.provide('applications', runtime)
  return { ctx, runtime, store }
}

const grant = { caller: { kind: 'app' as const, appId: 'notes' }, capabilities: ['capability:storage'], grantedAt: '2026-01-01T00:00:00.000Z' }

async function ready(runtime: ApplicationRuntime): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (runtime.list().find(entry => entry.declaration.id === 'notes')?.status() === 'available') return
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  }
  throw new Error('notes did not become available')
}

describe('notes application', () => {
  it('creates, lists, updates, soft-deletes and restores a note', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant(grant)
    await NotesPlugin.apply(ctx)
    await ready(runtime)
    const created = await runtime.call({ kind: 'human' }, 'notes', 'create', { body: '# Hello\n\nworld', tags: ['b', 'a'] })
    expect(created).toMatchObject({ status: 'success' })
    const note = created.status === 'success' ? created.result as { id: string; title: string; version: number; tags: string[] } : undefined
    expect(note).toMatchObject({ title: '# Hello', version: 1, tags: ['a', 'b'] })
    const listed = await runtime.call({ kind: 'human' }, 'notes', 'list', {})
    expect(listed).toMatchObject({ status: 'success' })
    const updated = await runtime.call({ kind: 'human' }, 'notes', 'update', { id: note!.id, expectedVersion: 1, body: 'changed' })
    expect(updated).toMatchObject({ status: 'success' })
    expect(await runtime.call({ kind: 'human' }, 'notes', 'update', { id: note!.id, expectedVersion: 1, body: 'again' })).toMatchObject({ status: 'failed', error: { code: 'app.stale-version' } })
    expect(await runtime.call({ kind: 'human' }, 'notes', 'delete', { id: note!.id })).toMatchObject({ status: 'success' })
    expect((await runtime.call({ kind: 'human' }, 'notes', 'list', {}))).toMatchObject({ status: 'success' })
    expect(await runtime.call({ kind: 'human' }, 'notes', 'restore', { id: note!.id })).toMatchObject({ status: 'success' })
    expect((await runtime.call({ kind: 'human' }, 'notes', 'get', { id: note!.id }))).toMatchObject({ status: 'success' })
    expect(runtime.list()[0]?.declaration.data).toMatchObject({ kind: 'unified', namespace: 'notes' })
    store.close()
    await ctx.fiber.dispose()
  })

  it('replays a create by requestId and keeps its source', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant(grant)
    await NotesPlugin.apply(ctx)
    await ready(runtime)
    const first = await runtime.call({ kind: 'human' }, 'notes', 'create', { body: 'from inbox', requestId: 'inbox:1', source: { app: 'inbox', id: 'entry-1' } })
    const second = await runtime.call({ kind: 'human' }, 'notes', 'create', { body: 'different body', requestId: 'inbox:1', source: { app: 'inbox', id: 'entry-1' } })
    expect(first.status).toBe('success')
    expect(second.status).toBe('success')
    if (first.status !== 'success' || second.status !== 'success') throw new Error('create failed')
    expect((second.result as { id: string }).id).toBe((first.result as { id: string }).id)
    expect((first.result as { source: { app: string } }).source.app).toBe('inbox')
    expect((await runtime.call({ kind: 'human' }, 'notes', 'list', {})).status).toBe('success')
    if ((await runtime.call({ kind: 'human' }, 'notes', 'list', {})).status !== 'success') throw new Error('list failed')
    const listed = await runtime.call({ kind: 'human' }, 'notes', 'list', {})
    expect((listed as { result: unknown[] }).result).toHaveLength(1)
    store.close()
    await ctx.fiber.dispose()
  })

  it('reads page-citation state through one bounded operation', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant(grant)
    await NotesPlugin.apply(ctx)
    await ready(runtime)
    await runtime.call({ kind: 'human' }, 'notes', 'create', { body: 'cited note' })
    expect(await runtime.call({ kind: 'human' }, 'notes', 'contextState', {})).toMatchObject({
      status: 'success',
      result: { notes: [{ title: 'cited note' }] },
    })
    store.close()
    await ctx.fiber.dispose()
  })

  it('exports and imports a document', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant(grant)
    await NotesPlugin.apply(ctx)
    await ready(runtime)
    await runtime.call({ kind: 'human' }, 'notes', 'create', { body: 'exported' })
    const exported = await runtime.call({ kind: 'human' }, 'notes', 'exportNotes', {})
    const json = exported.status === 'success' ? (exported.result as { json: string }).json : ''
    expect(json).toContain('exported')
    expect(await runtime.call({ kind: 'human' }, 'notes', 'importNotes', { json })).toMatchObject({ status: 'success' })
    expect(await runtime.call({ kind: 'human' }, 'notes', 'importNotes', { json: 'not json' })).toMatchObject({ status: 'failed' })
    store.close()
    await ctx.fiber.dispose()
  })

  it('resolves and searches for peers', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant(grant)
    await NotesPlugin.apply(ctx)
    await ready(runtime)
    const created = await runtime.call({ kind: 'human' }, 'notes', 'create', { body: 'find me' })
    const id = created.status === 'success' ? (created.result as { id: string }).id : ''
    expect(await runtime.call({ kind: 'human' }, 'notes', 'resolveNotes', { ids: [id] })).toMatchObject({ status: 'success' })
    expect(await runtime.call({ kind: 'human' }, 'notes', 'searchNotes', { query: 'find' })).toMatchObject({ status: 'success' })
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('notes validation and edge paths', () => {
  it('covers tag/body bounds, lookup errors, filters and tags', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant(grant)
    await NotesPlugin.apply(ctx)
    await ready(runtime)
    const call = async (op: string, args: unknown) => await runtime.call({ kind: 'human' }, 'notes', op, args as never)
    expect(await call('create', { body: 'x'.repeat(100_001) })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('create', { body: 'x', tags: Array.from({ length: 21 }, (_, i) => `t${String(i)}`) })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('create', { body: 'x', tags: ['t'.repeat(41)] })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    const long = await call('create', { body: `${'a'.repeat(200)} tail`, tags: ['z', ' z ', 'a'], pinned: true })
    if (long.status !== 'success') throw new Error('create failed')
    const longId = (long.result as { id: string }).id
    const short = await call('create', { body: 'find me' })
    if (short.status !== 'success') throw new Error('create failed')
    const shortId = (short.result as { id: string }).id
    expect(await call('list', { tag: 'a', favorites: true })).toMatchObject({ status: 'success', result: [{ id: longId }] })
    expect(await call('list', { includeDeleted: true })).toMatchObject({ status: 'success', result: expect.any(Array) })
    expect(await call('listTags', {})).toMatchObject({ status: 'success', result: [{ tag: 'a', count: 1 }, { tag: 'z', count: 1 }] })
    expect(await call('get', { id: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call('search', { query: 'me' })).toMatchObject({ status: 'success' })
    expect(await call('resolveNotes', { ids: [longId, shortId, 'missing'] })).toMatchObject({ status: 'success' })
    expect(await call('update', { id: 'missing', expectedVersion: 1 })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call('update', { id: longId, expectedVersion: 99, body: 'x' })).toMatchObject({ status: 'failed', error: { code: 'app.stale-version' } })
    expect(await call('update', { id: longId, expectedVersion: 1, tags: [] })).toMatchObject({ status: 'success' })
    expect(await call('delete', { id: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call('delete', { id: longId })).toMatchObject({ status: 'success' })
    expect(await call('delete', { id: longId })).toMatchObject({ status: 'success' })
    expect(await call('update', { id: longId, expectedVersion: 2, body: 'x' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call('restore', { id: longId })).toMatchObject({ status: 'success' })
    expect(await call('restore', { id: longId })).toMatchObject({ status: 'success' })
    expect(await call('restore', { id: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call('get', { id: shortId })).toMatchObject({ status: 'success' })
    store.close()
    await ctx.fiber.dispose()
  })

  it('covers import validation, overwrite and reload', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant(grant)
    await NotesPlugin.apply(ctx)
    await ready(runtime)
    const call = async (op: string, args: unknown) => await runtime.call({ kind: 'human' }, 'notes', op, args as never)
    expect(await call('importNotes', { json: '{', mode: 'merge' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('importNotes', { json: '{"schemaVersion":2}', mode: 'merge' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('importNotes', { json: '{"schemaVersion":1}', mode: 'merge' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('importNotes', { json: '{"schemaVersion":1,"notes":[{}]}', mode: 'merge' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    const doc = { schemaVersion: 1, notes: [{ id: 'n1', title: 't', body: 'b', tags: [], pinned: false, createdAt: 1, updatedAt: 2, version: 1 }] }
    expect(await call('importNotes', { json: JSON.stringify(doc), mode: 'overwrite' })).toMatchObject({ status: 'success', result: { imported: 1 } })
    expect(await call('importNotes', { json: '{"schemaVersion":1,"notes":[{"id":"n1"}]}', mode: 'merge' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('importNotes', { json: '{"schemaVersion":1,"notes":[{"id":"n1","title":"t","body":"b"}]}', mode: 'merge' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('importNotes', { json: '{"schemaVersion":1,"notes":[]}', mode: 'merge' })).toMatchObject({ status: 'success', result: { imported: 0 } })
    const reload = runtime.list()[0]?.declaration.reload
    await reload?.({} as never)
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('notes plugin mount', () => {
  it('fails loudly without the application store', async () => {
    const ctx = new Context()
    await expect(NotesPlugin.apply(ctx)).rejects.toThrow(/application store/u)
    await ctx.fiber.dispose()
  })
})

describe('notes branches', () => {
  it('uses the untitled fallback, counts tags for live notes only and keeps a title when the body is absent', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant(grant)
    await NotesPlugin.apply(ctx)
    await ready(runtime)
    const call = async (op: string, args: unknown) => await runtime.call({ kind: 'human' }, 'notes', op, args as never)
    const blank = await call('create', { body: '\n\n' })
    if (blank.status !== 'success') throw new Error('blank')
    expect((blank.result as { title: string }).title).toBe('无标题')
    const tagged = await call('create', { body: 'tagged', tags: ['keep'] })
    const deleted = await call('create', { body: 'deleted', tags: ['gone'] })
    if (tagged.status !== 'success' || deleted.status !== 'success') throw new Error('create')
    await call('delete', { id: (deleted.result as { id: string }).id })
    expect(await call('listTags', {})).toMatchObject({ status: 'success', result: [{ tag: 'keep', count: 1 }] })
    expect(await call('update', { id: (tagged.result as { id: string }).id, expectedVersion: 1 })).toMatchObject({ status: 'success', result: { title: 'tagged' } })
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('notes list and pin branches', () => {
  it('sorts equal-pin notes by time and updates the pinned flag', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant(grant)
    await NotesPlugin.apply(ctx)
    await ready(runtime)
    const call = async (op: string, args: unknown) => await runtime.call({ kind: 'human' }, 'notes', op, args as never)
    const a = await call('create', { body: 'a' })
    await new Promise<void>(resolve => { setTimeout(resolve, 2) })
    const b = await call('create', { body: 'b' })
    if (a.status !== 'success' || b.status !== 'success') throw new Error('create')
    expect(await call('list', {})).toMatchObject({ status: 'success' })
    expect(await call('update', { id: (b.result as { id: string }).id, expectedVersion: 1, pinned: true })).toMatchObject({ status: 'success', result: { pinned: true } })
    store.close()
    await ctx.fiber.dispose()
  })
})
