import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ApplicationRuntime, type OperationContext } from '@matrix1001/dsh-application-harness-runtime'
import { AppStore } from '@matrix1001/dsh-application-harness-store'
import type { ModelAskRequest, ModelAskResult, ModelPort } from '@matrix1001/dsh-application-harness-host-bridge'
import * as NotesPlugin from '../src/index.ts'
import { NotesDeclaration, NotesRepository } from '../src/app.ts'
import { AttachmentStore } from '../src/attachments.ts'

const tempDirs: string[] = []

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      chmodSync(dir, 0o700)
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A failed test may have left a chmod behind; temp cleanup is best effort.
    }
  }
})

function host() {
  const ctx = new Context()
  const runtime = new ApplicationRuntime()
  const store = new AppStore(ctx)
  ctx.reflect.provide('applications', runtime)
  const dir = tempRoot('notes-app-')
  return { ctx, runtime, store, dir, attachmentsPath: join(dir, 'attachments') }
}

const grant = { caller: { kind: 'app' as const, appId: 'notes' }, capabilities: ['capability:storage'], grantedAt: '2026-01-01T00:00:00.000Z' }
const access = { appId: 'notes', use: async <T>(_name: string, work: () => T | Promise<T>): Promise<T> => await work() }

async function ready(runtime: ApplicationRuntime): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (runtime.list().find(entry => entry.declaration.id === 'notes')?.status() === 'available') return
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  }
  throw new Error('notes did not become available')
}

type HumanCaller = { kind: 'human' }
type AiCaller = { kind: 'ai'; sessionId: string }
type AppCaller = { kind: 'app'; appId: string }
type AnyCaller = HumanCaller | AiCaller | AppCaller

async function call(runtime: ApplicationRuntime, op: string, args: unknown = {}, caller: AnyCaller = { kind: 'human' }) {
  return await runtime.call(caller as never, 'notes', op, args as never)
}

async function ok<T>(runtime: ApplicationRuntime, op: string, args: unknown = {}): Promise<T> {
  const outcome = await call(runtime, op, args)
  expect(outcome.status).toBe('success')
  return outcome.status === 'success' ? outcome.result as T : (undefined as never)
}

/** A fully mounted notes application with an isolated attachment directory. */
async function mount(options: { config?: boolean } = {}) {
  const world = host()
  await world.runtime.grant(grant)
  if (options.config === false) await NotesPlugin.apply(world.ctx)
  else await NotesPlugin.apply(world.ctx, { attachmentsPath: world.attachmentsPath })
  await ready(world.runtime)
  return world
}

/** Write a document straight into the namespace before the plugin mounts (import fixtures). */
async function seed(store: AppStore, document: unknown): Promise<void> {
  const gated = store.openForMount('notes')
  gated.attach(access as never)
  await gated.documents.put('document', document, { schemaVersion: 2 })
}

function encoded(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function attachmentId(): string {
  return `att_${randomUUID()}`
}

interface DocAttachmentFixture {
  id?: string
  name?: string
  size?: number
  type?: string
  sha256?: string
}

function attachmentMeta(overrides: DocAttachmentFixture = {}): Record<string, unknown> {
  const body = 'imported'
  return {
    id: attachmentId(),
    name: 'imported.txt',
    size: Buffer.byteLength(body),
    type: 'text/plain',
    sha256: sha256(body),
    ...overrides,
  }
}

function noteFixture(overrides: Record<string, unknown> = {}, attachments?: unknown[]): Record<string, unknown> {
  return {
    id: `n_${randomUUID()}`,
    title: 'imported',
    body: 'imported',
    tags: [],
    pinned: false,
    createdAt: 1,
    updatedAt: 2,
    version: 1,
    ...(attachments === undefined ? {} : { attachments }),
    ...overrides,
  }
}

function documentJson(notes: unknown[], attachments?: Record<string, unknown>): string {
  return JSON.stringify({ schemaVersion: 2, notes, ...(attachments === undefined ? {} : { attachments }) })
}

function uploadedMeta(outcome: unknown): { note: { id: string; version: number; attachments: Array<{ id: string }> }; attachment: { id: string; name: string; size: number; type: string; sha256: string } } {
  return outcome as never
}

describe('notes application', () => {
  it('creates, lists, updates, soft-deletes and restores a note', async () => {
    const { ctx, runtime, store } = await mount()
    const created = await runtime.call({ kind: 'human' }, 'notes', 'create', { body: '# Hello\n\nworld', tags: ['b', 'a'] })
    expect(created).toMatchObject({ status: 'success' })
    const note = created.status === 'success' ? created.result as { id: string; title: string; version: number; tags: string[]; attachments: unknown[] } : undefined
    expect(note).toMatchObject({ title: '# Hello', version: 1, tags: ['a', 'b'], attachments: [] })
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
    const { ctx, runtime, store } = await mount()
    const first = await runtime.call({ kind: 'human' }, 'notes', 'create', { body: 'from inbox', requestId: 'inbox:1', source: { app: 'inbox', id: 'entry-1' } })
    const second = await runtime.call({ kind: 'human' }, 'notes', 'create', { body: 'different body', requestId: 'inbox:1', source: { app: 'inbox', id: 'entry-1' } })
    expect(first.status).toBe('success')
    expect(second.status).toBe('success')
    if (first.status !== 'success' || second.status !== 'success') throw new Error('create failed')
    expect((second.result as { id: string }).id).toBe((first.result as { id: string }).id)
    expect((first.result as { source: { app: string } }).source.app).toBe('inbox')
    const listed = await runtime.call({ kind: 'human' }, 'notes', 'list', {})
    expect((listed as { result: unknown[] }).result).toHaveLength(1)
    store.close()
    await ctx.fiber.dispose()
  })

  it('reads page-citation state through one bounded operation', async () => {
    const { ctx, runtime, store } = await mount()
    await call(runtime, 'create', { body: 'cited note' })
    expect(await call(runtime, 'contextState')).toMatchObject({
      status: 'success',
      result: { notes: [{ title: 'cited note' }] },
    })
    store.close()
    await ctx.fiber.dispose()
  })

  it('exports and imports a document', async () => {
    const { ctx, runtime, store } = await mount()
    await call(runtime, 'create', { body: 'exported' })
    const exported = await call(runtime, 'exportNotes')
    const value = exported.status === 'success' ? exported.result as { json: string; warnings: string[] } : { json: '', warnings: [] }
    expect(value.json).toContain('exported')
    expect(value.warnings).toEqual([])
    expect(JSON.parse(value.json)).toMatchObject({ schemaVersion: 2, attachments: {} })
    expect(await call(runtime, 'importNotes', { json: value.json })).toMatchObject({ status: 'success' })
    expect(await call(runtime, 'importNotes', { json: 'not json' })).toMatchObject({ status: 'failed' })
    store.close()
    await ctx.fiber.dispose()
  })

  it('resolves and searches for peers', async () => {
    const { ctx, runtime, store } = await mount()
    const created = await call(runtime, 'create', { body: 'find me' })
    const id = created.status === 'success' ? (created.result as { id: string }).id : ''
    expect(await call(runtime, 'resolveNotes', { ids: [id] })).toMatchObject({ status: 'success' })
    expect(await call(runtime, 'searchNotes', { query: 'find' })).toMatchObject({ status: 'success' })
    store.close()
    await ctx.fiber.dispose()
  })

  it('searches tags case-insensitively and reaches trashed notes on request', async () => {
    const { ctx, runtime, store } = await mount()
    const created = await call(runtime, 'create', { body: 'plain body', tags: ['DeepWork'] })
    if (created.status !== 'success') throw new Error('create failed')
    const id = (created.result as { id: string }).id
    // Tags are part of the query contract, not just a local list filter.
    expect(await call(runtime, 'list', { query: 'deepwork' })).toMatchObject({ status: 'success', result: [{ id }] })
    expect(await call(runtime, 'search', { query: 'DEEPWORK' })).toMatchObject({ status: 'success', result: [{ id }] })
    expect(await call(runtime, 'searchNotes', { query: 'deepwork' })).toMatchObject({ status: 'success', result: [{ id }] })
    // The platform index normalizes full-width forms before matching.
    expect(await call(runtime, 'search', { query: 'ＤＥＥＰＷＯＲＫ' })).toMatchObject({ status: 'success', result: [{ id }] })
    // A soft-deleted note stays out of the live search until the caller asks
    // for the trash scope: the page's trash search passes includeDeleted.
    expect(await call(runtime, 'delete', { id })).toMatchObject({ status: 'success' })
    expect(await call(runtime, 'search', { query: 'deepwork' })).toMatchObject({ status: 'success', result: [] })
    expect(await call(runtime, 'search', { query: 'deepwork', includeDeleted: true })).toMatchObject({ status: 'success', result: [{ id }] })
    expect(await call(runtime, 'searchNotes', { query: 'deepwork', includeDeleted: true })).toMatchObject({ status: 'success', result: [{ id }] })
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('notes validation and edge paths', () => {
  it('covers tag/body bounds, lookup errors, filters and tags', async () => {
    const { ctx, runtime, store } = await mount()
    expect(await call(runtime, 'create', { body: 'x'.repeat(100_001) })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call(runtime, 'create', { body: 'x', tags: Array.from({ length: 21 }, (_, i) => `t${String(i)}`) })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call(runtime, 'create', { body: 'x', tags: ['t'.repeat(41)] })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    const long = await call(runtime, 'create', { body: `${'a'.repeat(200)} tail`, tags: ['z', ' z ', 'a'], pinned: true })
    if (long.status !== 'success') throw new Error('create failed')
    const longId = (long.result as { id: string }).id
    const short = await call(runtime, 'create', { body: 'find me' })
    if (short.status !== 'success') throw new Error('create failed')
    const shortId = (short.result as { id: string }).id
    expect(await call(runtime, 'list', { tag: 'a', favorites: true })).toMatchObject({ status: 'success', result: [{ id: longId }] })
    expect(await call(runtime, 'list', { includeDeleted: true })).toMatchObject({ status: 'success', result: expect.any(Array) })
    expect(await call(runtime, 'listTags', {})).toMatchObject({ status: 'success', result: [{ tag: 'a', count: 1 }, { tag: 'z', count: 1 }] })
    expect(await call(runtime, 'get', { id: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call(runtime, 'search', { query: 'me' })).toMatchObject({ status: 'success' })
    expect(await call(runtime, 'resolveNotes', { ids: [longId, shortId, 'missing'] })).toMatchObject({ status: 'success' })
    expect(await call(runtime, 'update', { id: 'missing', expectedVersion: 1 })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call(runtime, 'update', { id: longId, expectedVersion: 99, body: 'x' })).toMatchObject({ status: 'failed', error: { code: 'app.stale-version' } })
    expect(await call(runtime, 'update', { id: longId, expectedVersion: 1, tags: [] })).toMatchObject({ status: 'success' })
    expect(await call(runtime, 'delete', { id: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call(runtime, 'delete', { id: longId })).toMatchObject({ status: 'success' })
    expect(await call(runtime, 'delete', { id: longId })).toMatchObject({ status: 'success' })
    expect(await call(runtime, 'update', { id: longId, expectedVersion: 2, body: 'x' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call(runtime, 'restore', { id: longId })).toMatchObject({ status: 'success' })
    expect(await call(runtime, 'restore', { id: longId })).toMatchObject({ status: 'success' })
    expect(await call(runtime, 'restore', { id: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call(runtime, 'get', { id: shortId })).toMatchObject({ status: 'success' })
    store.close()
    await ctx.fiber.dispose()
  })

  it('covers import validation, overwrite and reload', async () => {
    const { ctx, runtime, store } = await mount()
    expect(await call(runtime, 'importNotes', { json: '{', mode: 'merge' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call(runtime, 'importNotes', { json: '{"schemaVersion":2}', mode: 'merge' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call(runtime, 'importNotes', { json: '{"schemaVersion":1}', mode: 'merge' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call(runtime, 'importNotes', { json: '{"schemaVersion":1,"notes":[{}]}', mode: 'merge' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    const doc = { schemaVersion: 2, notes: [{ id: 'n1', title: 't', body: 'b', tags: [], pinned: false, createdAt: 1, updatedAt: 2, version: 1, attachments: [] }] }
    expect(await call(runtime, 'importNotes', { json: JSON.stringify(doc), mode: 'overwrite' })).toMatchObject({ status: 'success', result: { imported: 1 } })
    expect(await call(runtime, 'importNotes', { json: '{"schemaVersion":1,"notes":[{"id":"n1"}]}', mode: 'merge' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call(runtime, 'importNotes', { json: '{"schemaVersion":1,"notes":[{"id":"n1","title":"t","body":"b"}]}', mode: 'merge' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call(runtime, 'importNotes', { json: '{"schemaVersion":2,"notes":[]}', mode: 'merge' })).toMatchObject({ status: 'success', result: { imported: 0 } })
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

  it('mounts the keyless composition with the default attachment location', async () => {
    const home = tempRoot('notes-default-home-')
    const previous = process.env['DSH_HOME']
    process.env['DSH_HOME'] = home
    try {
      const { ctx, runtime, store } = await mount({ config: false })
      expect(await call(runtime, 'list')).toMatchObject({ status: 'success', result: [] })
      store.close()
      await ctx.fiber.dispose()
    } finally {
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }
  })
})

describe('notes branches', () => {
  it('uses the untitled fallback, counts tags for live notes only and keeps a title when the body is absent', async () => {
    const { ctx, runtime, store } = await mount()
    const blank = await call(runtime, 'create', { body: '\n\n' })
    if (blank.status !== 'success') throw new Error('blank')
    expect((blank.result as { title: string }).title).toBe('无标题')
    const tagged = await call(runtime, 'create', { body: 'tagged', tags: ['keep'] })
    const deleted = await call(runtime, 'create', { body: 'deleted', tags: ['gone'] })
    if (tagged.status !== 'success' || deleted.status !== 'success') throw new Error('create')
    await call(runtime, 'delete', { id: (deleted.result as { id: string }).id })
    expect(await call(runtime, 'listTags', {})).toMatchObject({ status: 'success', result: [{ tag: 'keep', count: 1 }] })
    expect(await call(runtime, 'update', { id: (tagged.result as { id: string }).id, expectedVersion: 1 })).toMatchObject({ status: 'success', result: { title: 'tagged' } })
    store.close()
    await ctx.fiber.dispose()
  })

  it('sorts equal-pin notes by time and updates the pinned flag', async () => {
    const { ctx, runtime, store } = await mount()
    const a = await call(runtime, 'create', { body: 'a' })
    await new Promise<void>(resolve => { setTimeout(resolve, 2) })
    const b = await call(runtime, 'create', { body: 'b' })
    if (a.status !== 'success' || b.status !== 'success') throw new Error('create')
    expect(await call(runtime, 'list', {})).toMatchObject({ status: 'success' })
    expect(await call(runtime, 'update', { id: (b.result as { id: string }).id, expectedVersion: 1, pinned: true })).toMatchObject({ status: 'success', result: { pinned: true } })
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('notes attachments', () => {
  it('uploads, downloads, preserves through update and deletes, keeping bytes for trashed notes', async () => {
    const { ctx, runtime, store, attachmentsPath } = await mount()
    const note = await ok<{ id: string; version: number }>(runtime, 'create', { body: '# with files' })
    const body = 'hello attachment'
    const uploaded = uploadedMeta(await ok(runtime, 'uploadAttachment', { noteId: note.id, name: 'hello.txt', type: 'text/plain', dataBase64: encoded(body) }))
    expect(uploaded.attachment).toMatchObject({ name: 'hello.txt', size: Buffer.byteLength(body), type: 'text/plain', sha256: sha256(body) })
    expect(uploaded.note.attachments).toHaveLength(1)
    expect(uploaded.note.version).toBe(note.version + 1)
    expect(existsSync(join(attachmentsPath, uploaded.attachment.id))).toBe(true)

    const viewed = await ok<{ attachments: Array<{ id: string; missing: boolean }>; version: number }>(runtime, 'get', { id: note.id })
    expect(viewed.attachments).toEqual([expect.objectContaining({ id: uploaded.attachment.id, missing: false })])
    const downloaded = await ok<{ missing: boolean; dataBase64: string; name: string }>(runtime, 'downloadAttachment', { noteId: note.id, attachmentId: uploaded.attachment.id })
    expect(downloaded).toMatchObject({ missing: false, name: 'hello.txt' })
    expect(Buffer.from(downloaded.dataBase64, 'base64').toString('utf8')).toBe(body)

    const second = uploadedMeta(await ok(runtime, 'uploadAttachment', { noteId: note.id, name: 'image.png', type: 'image/png', dataBase64: encoded('png-bytes') }))
    expect(second.note.attachments).toHaveLength(2)
    const updated = await ok<{ attachments: unknown[]; version: number }>(runtime, 'update', { id: note.id, expectedVersion: second.note.version, body: 'changed' })
    expect(updated.attachments).toHaveLength(2)

    const afterDelete = await ok<{ note: { attachments: Array<{ id: string }>; version: number }; attachment: { id: string } }>(runtime, 'deleteAttachment', { noteId: note.id, attachmentId: uploaded.attachment.id })
    expect(afterDelete.note.attachments).toHaveLength(1)
    expect(existsSync(join(attachmentsPath, uploaded.attachment.id))).toBe(false)

    await ok(runtime, 'delete', { id: note.id })
    expect(existsSync(join(attachmentsPath, second.attachment.id))).toBe(true)
    expect(await call(runtime, 'deleteAttachment', { noteId: note.id, attachmentId: second.attachment.id })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call(runtime, 'uploadAttachment', { noteId: note.id, name: 'x.txt', type: 'text/plain', dataBase64: encoded('x') })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    await ok(runtime, 'restore', { id: note.id })
    const restored = await ok<{ missing: boolean; dataBase64: string }>(runtime, 'downloadAttachment', { noteId: note.id, attachmentId: second.attachment.id })
    expect(Buffer.from(restored.dataBase64, 'base64').toString('utf8')).toBe('png-bytes')

    store.close()
    await ctx.fiber.dispose()
  })

  it('validates uploads, enforces the type whitelist and reports the per-note quota', async () => {
    const { ctx, runtime, store } = await mount()
    const note = await ok<{ id: string }>(runtime, 'create', { body: 'quota' })
    const base = { noteId: note.id, name: 'file.txt', type: 'text/plain', dataBase64: encoded('x') }
    expect(await call(runtime, 'uploadAttachment', { ...base, type: 'application/x-msdownload' })).toMatchObject({ status: 'failed', error: { code: 'app.attachment-type' } })
    expect(await call(runtime, 'uploadAttachment', { ...base, name: 'payload.exe' })).toMatchObject({ status: 'failed', error: { code: 'app.attachment-type' } })
    expect(await call(runtime, 'uploadAttachment', { ...base, dataBase64: 'not base64!' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call(runtime, 'uploadAttachment', { ...base, name: '   ' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call(runtime, 'uploadAttachment', { ...base, noteId: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })

    // A metadata-only import can fill the quota without owning the bytes.
    const big = Array.from({ length: 10 }, (_, index) => attachmentMeta({ name: `big-${String(index)}.pdf`, type: 'application/pdf', size: 2 * 1024 * 1024, sha256: 'a'.repeat(64) }))
    const quotaNote = noteFixture({}, big)
    await ok(runtime, 'importNotes', { json: documentJson([quotaNote]), mode: 'overwrite' })
    expect(await call(runtime, 'uploadAttachment', { noteId: quotaNote['id'], name: 'tiny.txt', type: 'text/plain', dataBase64: encoded('x') })).toMatchObject({ status: 'failed', error: { code: 'app.attachment-quota' } })

    store.close()
    await ctx.fiber.dispose()
  })

  it('replays an upload by requestId and refuses to rebind it to another note', async () => {
    const { ctx, runtime, store } = await mount()
    const first = await ok<{ id: string; version: number }>(runtime, 'create', { body: 'one' })
    const other = await ok<{ id: string }>(runtime, 'create', { body: 'two' })
    const args = { noteId: first.id, name: 'replay.txt', type: 'text/plain', dataBase64: encoded('replay'), requestId: 'attach:1' }
    const uploaded = uploadedMeta(await ok(runtime, 'uploadAttachment', args))
    const replayed = uploadedMeta(await ok(runtime, 'uploadAttachment', { ...args, dataBase64: encoded('different') }))
    expect(replayed.attachment.id).toBe(uploaded.attachment.id)
    expect(replayed.note.version).toBe(uploaded.note.version)
    expect(await call(runtime, 'uploadAttachment', { ...args, noteId: other.id })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    // A second, distinct requestId on the same note covers the receipt merge.
    const third = uploadedMeta(await ok(runtime, 'uploadAttachment', { ...args, requestId: 'attach:2', name: 'other.txt' }))
    expect(third.note.attachments).toHaveLength(2)
    await ok(runtime, 'deleteAttachment', { noteId: first.id, attachmentId: uploaded.attachment.id })
    expect(await call(runtime, 'uploadAttachment', args)).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    store.close()
    await ctx.fiber.dispose()
  })

  it('flags missing bytes and refuses corrupt bytes', async () => {
    const { ctx, runtime, store, attachmentsPath } = await mount()
    const note = await ok<{ id: string }>(runtime, 'create', { body: 'bytes' })
    const uploaded = uploadedMeta(await ok(runtime, 'uploadAttachment', { noteId: note.id, name: 'gone.txt', type: 'text/plain', dataBase64: encoded('gone') }))
    rmSync(join(attachmentsPath, uploaded.attachment.id))
    expect(await ok<{ attachments: Array<{ missing: boolean }> }>(runtime, 'get', { id: note.id })).toMatchObject({ attachments: [{ missing: true }] })
    const missing = await ok<{ missing: boolean; dataBase64?: string }>(runtime, 'downloadAttachment', { noteId: note.id, attachmentId: uploaded.attachment.id })
    expect(missing).toMatchObject({ missing: true })
    expect(missing.dataBase64).toBeUndefined()

    const corrupt = uploadedMeta(await ok(runtime, 'uploadAttachment', { noteId: note.id, name: 'corrupt.txt', type: 'text/plain', dataBase64: encoded('good') }))
    writeFileSync(join(attachmentsPath, corrupt.attachment.id), 'evil')
    expect(await call(runtime, 'downloadAttachment', { noteId: note.id, attachmentId: corrupt.attachment.id })).toMatchObject({ status: 'failed', error: { code: 'app.storage-corrupt' } })
    expect(await call(runtime, 'downloadAttachment', { noteId: note.id, attachmentId: attachmentId() })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call(runtime, 'deleteAttachment', { noteId: note.id, attachmentId: attachmentId() })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call(runtime, 'downloadAttachment', { noteId: 'missing', attachmentId: corrupt.attachment.id })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    store.close()
    await ctx.fiber.dispose()
  })

  it('exports small attachment bytes inline and budgets the cumulative total', async () => {
    const { ctx, runtime, store, attachmentsPath } = host()
    mkdirSync(attachmentsPath, { recursive: true })
    const seeded: Array<{ id: string; bytes: Buffer }> = []
    for (let index = 0; index < 4; index += 1) {
      const bytes = Buffer.alloc(2 * 1024 * 1024, index + 1)
      const id = attachmentId()
      writeFileSync(join(attachmentsPath, id), bytes)
      seeded.push({ id, bytes })
    }
    // Four files fill the 8 MiB budget exactly; the fifth attachment is metadata only.
    const overBudget = attachmentMeta({ name: 'budget.txt', size: 1, sha256: 'b'.repeat(64) })
    const missingMeta = attachmentMeta({ name: 'missing.txt', size: 4, sha256: sha256('miss') })
    const missingNote = noteFixture({ id: 'n_missing' }, [missingMeta])
    const budgetNote = noteFixture({ id: 'n_budget' }, [
      ...seeded.map((file, index) => ({ id: file.id, name: `part-${String(index)}.pdf`, size: file.bytes.length, type: 'application/pdf', sha256: sha256Bytes(file.bytes) })),
      overBudget,
    ])
    await seed(store, { schemaVersion: 2, notes: [missingNote, budgetNote] })
    await runtime.grant(grant)
    await NotesPlugin.apply(ctx, { attachmentsPath })
    await ready(runtime)

    const exported = await ok<{ json: string; warnings: string[] }>(runtime, 'exportNotes')
    const parsed = JSON.parse(exported.json) as { attachments: Record<string, { dataBase64?: string; omitted?: string }> }
    for (const file of seeded) expect(parsed.attachments[file.id]).toEqual({ dataBase64: file.bytes.toString('base64') })
    expect(parsed.attachments[String(overBudget['id'])]).toEqual({ omitted: 'budget' })
    expect(parsed.attachments[String(missingMeta['id'])]).toEqual({ omitted: 'missing' })
    expect(exported.warnings).toEqual(expect.arrayContaining([`attachment-omitted:${String(overBudget['id'])}`, `attachment-missing:${String(missingMeta['id'])}`]))

    store.close()
    await ctx.fiber.dispose()
  })

  it('reports corrupt byte files and storage failures on export', async () => {
    const { ctx, runtime, store, attachmentsPath } = await mount()
    const note = await ok<{ id: string }>(runtime, 'create', { body: 'export me' })
    const body = 'inline bytes'
    const uploaded = uploadedMeta(await ok(runtime, 'uploadAttachment', { noteId: note.id, name: 'inline.txt', type: 'text/plain', dataBase64: encoded(body) }))
    const exported = await ok<{ json: string; warnings: string[] }>(runtime, 'exportNotes')
    expect(exported.warnings).toEqual([])
    const parsed = JSON.parse(exported.json) as { attachments: Record<string, { dataBase64?: string }> }
    expect(parsed.attachments[uploaded.attachment.id]).toMatchObject({ dataBase64: encoded(body) })

    // A byte file that no longer matches its digest is reported as corrupt.
    writeFileSync(join(attachmentsPath, uploaded.attachment.id), 'corrupted!!!')
    const corrupt = await ok<{ json: string; warnings: string[] }>(runtime, 'exportNotes')
    expect(corrupt.warnings).toContain(`attachment-corrupt:${uploaded.attachment.id}`)

    // A digest that matches but a size that does not still fails the metadata check.
    const actual = 'four'
    const actualSha = sha256(actual)
    const wrongSize = attachmentMeta({ name: 'wrong-size.txt', size: Buffer.byteLength(actual) + 1, sha256: actualSha })
    const wrongSizeNote = noteFixture({}, [wrongSize])
    writeFileSync(join(attachmentsPath, String(wrongSize['id'])), actual)
    await ok(runtime, 'importNotes', { json: documentJson([wrongSizeNote]), mode: 'merge' })
    const wrongSized = await ok<{ warnings: string[] }>(runtime, 'exportNotes')
    expect(wrongSized.warnings).toContain(`attachment-corrupt:${String(wrongSize['id'])}`)

    // A read-only byte file surfaces as a storage failure, not a silent omission.
    chmodSync(join(attachmentsPath, uploaded.attachment.id), 0o000)
    expect(await call(runtime, 'exportNotes')).toMatchObject({ status: 'failed', error: { code: 'app.storage-failed' } })
    chmodSync(join(attachmentsPath, uploaded.attachment.id), 0o600)
    store.close()
    await ctx.fiber.dispose()
  })

  it('exports one shared attachment id once when two notes reference it', async () => {
    const { ctx, runtime, store } = await mount()
    const body = 'shared bytes'
    const shared = attachmentMeta({ name: 'shared.txt', size: Buffer.byteLength(body), sha256: sha256(body) })
    const first = noteFixture({ id: 'n_shared_a' }, [shared])
    const second = noteFixture({ id: 'n_shared_b' }, [shared])
    await ok(runtime, 'importNotes', { json: documentJson([first, second], { [String(shared['id'])]: { dataBase64: encoded(body) } }), mode: 'overwrite' })
    const exported = await ok<{ json: string; warnings: string[] }>(runtime, 'exportNotes')
    const parsed = JSON.parse(exported.json) as { attachments: Record<string, { dataBase64?: string }> }
    expect(Object.keys(parsed.attachments)).toEqual([String(shared['id'])])
    expect(parsed.attachments[String(shared['id'])]).toEqual({ dataBase64: encoded(body) })
    expect(exported.warnings).toEqual([])
    store.close()
    await ctx.fiber.dispose()
  })

  it('imports attachment bytes, counts missing ones and collects unreferenced files', async () => {
    const source = await mount()
    const note = await ok<{ id: string }>(source.runtime, 'create', { body: 'round trip' })
    const uploaded = uploadedMeta(await ok(source.runtime, 'uploadAttachment', { noteId: note.id, name: 'trip.txt', type: 'text/plain', dataBase64: encoded('trip bytes') }))
    const exported = await ok<{ json: string; warnings: string[] }>(source.runtime, 'exportNotes')
    source.store.close()
    await source.ctx.fiber.dispose()

    const target = await mount()
    const imported = await ok<{ imported: number; attachments: { written: number; missing: number; removed: number }; warnings: string[] }>(target.runtime, 'importNotes', { json: exported.json, mode: 'overwrite' })
    expect(imported).toMatchObject({ imported: 1, attachments: { written: 1, missing: 0, removed: 0 }, warnings: [] })
    const downloaded = await ok<{ dataBase64: string; missing: boolean }>(target.runtime, 'downloadAttachment', { noteId: note.id, attachmentId: uploaded.attachment.id })
    expect(Buffer.from(downloaded.dataBase64, 'base64').toString('utf8')).toBe('trip bytes')

    // Re-importing the same metadata with omitted bytes finds the bytes already here.
    const omittedDoc = JSON.parse(exported.json) as { attachments: Record<string, unknown> }
    for (const key of Object.keys(omittedDoc.attachments)) omittedDoc.attachments[key] = { omitted: 'budget' }
    const reimported = await ok<{ attachments: { written: number; missing: number } }>(target.runtime, 'importNotes', { json: JSON.stringify(omittedDoc), mode: 'merge' })
    expect(reimported.attachments).toMatchObject({ written: 0, missing: 0 })

    // Metadata-only attachments are counted missing and read as missing.
    const absent = attachmentMeta({ name: 'absent.txt' })
    const absentNote = noteFixture({}, [absent])
    const missingImport = await ok<{ attachments: { written: number; missing: number } }>(target.runtime, 'importNotes', { json: documentJson([absentNote]), mode: 'merge' })
    expect(missingImport.attachments).toMatchObject({ written: 0, missing: 1 })
    expect(await ok<{ attachments: Array<{ missing: boolean }> }>(target.runtime, 'get', { id: absentNote['id'] })).toMatchObject({ attachments: [{ missing: true }] })

    // An overwrite drops the old note, and its now-unreferenced bytes are collected.
    const fresh = noteFixture({}, [])
    const overwritten = await ok<{ attachments: { removed: number } }>(target.runtime, 'importNotes', { json: documentJson([fresh]), mode: 'overwrite' })
    expect(overwritten.attachments.removed).toBeGreaterThanOrEqual(1)
    expect(readdirSync(target.attachmentsPath)).toEqual([])

    target.store.close()
    await target.ctx.fiber.dispose()
  })

  it('reports a failed collection as a warning without failing the import', async () => {
    const { ctx, runtime, store, attachmentsPath } = await mount()
    mkdirSync(attachmentsPath, { recursive: true })
    chmodSync(attachmentsPath, 0o300)
    const imported = await ok<{ warnings: string[] }>(runtime, 'importNotes', { json: documentJson([noteFixture({}, [])]), mode: 'merge' })
    expect(imported.warnings).toContain('attachment-gc-failed')
    chmodSync(attachmentsPath, 0o700)
    store.close()
    await ctx.fiber.dispose()
  })

  it('refuses malformed, escaped, unreferenced and mismatched import bytes', async () => {
    const { ctx, runtime, store } = await mount()
    const meta = attachmentMeta()
    const note = noteFixture({}, [meta])
    const good = { dataBase64: encoded('imported') }
    const importDoc = async (doc: unknown) => await call(runtime, 'importNotes', { json: JSON.stringify(doc), mode: 'merge' })

    expect(await importDoc({ schemaVersion: 2, notes: [note], attachments: [] })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await importDoc({ schemaVersion: 2, notes: [note], attachments: null })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    // A traversal id can never name a byte file.
    expect(await importDoc({ schemaVersion: 2, notes: [note], attachments: { '../escape': good } })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await importDoc({ schemaVersion: 2, notes: [note], attachments: { [String(meta['id'])]: 5 } })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await importDoc({ schemaVersion: 2, notes: [note], attachments: { [String(meta['id'])]: {} } })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await importDoc({ schemaVersion: 2, notes: [note], attachments: { [attachmentId()]: good } })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    // Bytes that do not match the metadata digest, and a length that does not.
    expect(await importDoc({ schemaVersion: 2, notes: [note], attachments: { [String(meta['id'])]: { dataBase64: encoded('other') } } })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    const wrongSize = attachmentMeta({ size: Buffer.byteLength('imported') + 1 })
    expect(await importDoc({ schemaVersion: 2, notes: [noteFixture({}, [wrongSize])], attachments: { [String(wrongSize['id'])]: good } })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    // Malformed metadata (not an array, missing fields, outside the type whitelist).
    expect(await importDoc({ schemaVersion: 2, notes: [noteFixture({}, 'nope' as never)] })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await importDoc({ schemaVersion: 2, notes: [noteFixture({}, [{ id: 'bad' }])] })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await importDoc({ schemaVersion: 2, notes: [noteFixture({}, [attachmentMeta({ type: 'application/x-msdownload' })])] })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    // The per-note byte quota applies to metadata the same way it does to uploads.
    const overQuota = Array.from({ length: 11 }, () => attachmentMeta({ size: 2 * 1024 * 1024 }))
    expect(await importDoc({ schemaVersion: 2, notes: [noteFixture({}, overQuota)] })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    // The section itself may be absent (an older export) or empty.
    expect(await importDoc({ schemaVersion: 2, notes: [noteFixture({}, [])] })).toMatchObject({ status: 'success' })
    store.close()
    await ctx.fiber.dispose()
  })

  it('keeps attachments closed to the AI and peer callers', async () => {
    const { ctx, runtime, store } = await mount()
    const note = await ok<{ id: string }>(runtime, 'create', { body: 'closed' })
    await runtime.register({
      id: 'peer',
      name: 'peer',
      description: 'peer application',
      version: '0.0.0',
      calls: ['notes'],
      ops: {
        ping: {
          description: 'Trivial peer operation so the declaration is valid',
          params: {},
          result: { type: 'json', description: 'Ping' },
          effect: 'read',
          execute: async () => ({ ok: true }),
        },
      },
    })
    const peer = { kind: 'app' as const, appId: 'peer' }
    expect(await call(runtime, 'uploadAttachment', { noteId: note.id, name: 'x.txt', type: 'text/plain', dataBase64: encoded('x') }, peer)).toMatchObject({ status: 'rejected' })
    const ai = { kind: 'ai' as const, sessionId: 'session' }
    expect(await call(runtime, 'uploadAttachment', { noteId: note.id, name: 'x.txt', type: 'text/plain', dataBase64: encoded('x') }, ai)).toMatchObject({ status: 'rejected' })
    expect(await call(runtime, 'downloadAttachment', { noteId: note.id, attachmentId: attachmentId() }, ai)).toMatchObject({ status: 'rejected' })
    expect(await call(runtime, 'deleteAttachment', { noteId: note.id, attachmentId: attachmentId() }, ai)).toMatchObject({ status: 'rejected' })
    expect(await call(runtime, 'exportNotes', {}, ai)).toMatchObject({ status: 'rejected' })
    store.close()
    await ctx.fiber.dispose()
  })

  it('removes a just-written byte file when the note metadata write fails', async () => {
    const ctx = new Context()
    const store = new AppStore(ctx)
    const dir = tempRoot('notes-rollback-')
    const left = new NotesRepository(store.openForMount('notes'), new AttachmentStore(join(dir, 'left')))
    const right = new NotesRepository(store.openForMount('notes'), new AttachmentStore(join(dir, 'right')))
    left.attach(access as never)
    right.attach(access as never)
    const opCtx = { notifyChanged: (): void => undefined } as never
    await left.ensureLoaded()
    const note = await left.create({ body: 'owned by the left writer' }, opCtx)
    await right.ensureLoaded()
    // A newer write from the left writer makes the right snapshot stale, so its
    // metadata put must fail — after the byte was already written.
    await left.update(note.id, 1, { body: 'newer' }, opCtx)
    await expect(right.uploadAttachment(note.id, { name: 'rollback.txt', type: 'text/plain', dataBase64: encoded('rollback') }, opCtx)).rejects.toThrow(/revision|conflict/u)
    expect(existsSync(join(dir, 'right'))).toBe(true)
    expect(readdirSync(join(dir, 'right'))).toEqual([])

    // When the cleanup unlink also fails, the ORIGINAL metadata failure is
    // still what the caller sees (the swallow must not mask it).
    const secondLeft = new NotesRepository(store.openForMount('notes'), new AttachmentStore(join(dir, 'left2')))
    const failingAttachmentStore = new AttachmentStore(join(dir, 'right2'))
    failingAttachmentStore.remove = async () => { throw new Error('cleanup denied') }
    const secondRight = new NotesRepository(store.openForMount('notes'), failingAttachmentStore)
    secondLeft.attach(access as never)
    secondRight.attach(access as never)
    await secondLeft.ensureLoaded()
    const secondNote = await secondLeft.create({ body: 'second left' }, opCtx)
    await secondRight.ensureLoaded()
    await secondLeft.update(secondNote.id, 1, { body: 'second newer' }, opCtx)
    await expect(secondRight.uploadAttachment(secondNote.id, { name: 'orphan.txt', type: 'text/plain', dataBase64: encoded('orphan') }, opCtx)).rejects.toThrow(/revision|conflict/u)
    expect(readdirSync(join(dir, 'right2'))).toHaveLength(1)

    store.close()
    await ctx.fiber.dispose()
  })
})

interface ModelAsk {
  prompt: string
  capabilities: unknown
  signal: AbortSignal | undefined
  maxOutputTokens: number | undefined
  temperature: number | undefined
}

interface ModelAnswer {
  text: string
  model?: { provider: string; model: string }
  usage?: { inputTokens?: number; outputTokens?: number }
}

/** A deterministic model port that records every request and answers in order. */
function modelPort(answers: ModelAnswer[]): { port: ModelPort; asks: ModelAsk[] } {
  const asks: ModelAsk[] = []
  const port: ModelPort = {
    ask: async <T>(request: ModelAskRequest<T>): Promise<ModelAskResult<T>> => {
      asks.push({
        prompt: request.prompt,
        capabilities: request.capabilities,
        signal: request.signal,
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
      })
      const answer = answers.shift()
      if (answer === undefined) throw new Error('unexpected model call')
      return {
        text: answer.text,
        ...(answer.model === undefined ? {} : { model: answer.model }),
        ...(answer.usage === undefined ? {} : { usage: answer.usage }),
      }
    },
  }
  return { port, asks }
}

/** A repository over its own in-memory store and attachment directory (no runtime mount needed). */
function standaloneRepository(model?: ModelPort) {
  const world = host()
  const repository = new NotesRepository(world.store.openForMount('notes'), new AttachmentStore(world.attachmentsPath), model)
  repository.attach(access as never)
  return { ctx: world.ctx, store: world.store, repository }
}

/** A minimal operation context: the model and resolution paths only read these fields. */
function operationContext(): OperationContext {
  return {
    capabilities: access,
    signal: new AbortController().signal,
    notifyChanged: () => undefined,
  } as unknown as OperationContext
}

describe('notes model summarization and reference resolution', () => {
  it('summarizes with or without a question and reports model/usage only when the platform returns them', async () => {
    const answers: ModelAnswer[] = [
      { text: '短摘要', model: { provider: 'deepseek', model: 'chat' }, usage: { inputTokens: 12, outputTokens: 3 } },
      { text: 'default summary' },
      { text: 'long default summary' },
    ]
    const { port, asks } = modelPort(answers)
    const { ctx, store, repository } = standaloneRepository(port)
    const operation = operationContext()
    const summarize = NotesDeclaration(repository).ops['summarize']!
    const note = await repository.create({ body: 'first line\n\nbody' }, operation)

    const asked = await summarize.execute({ id: note.id, question: ' what is this? ' } as never, operation as never) as {
      summary: string
      model?: unknown
      usage?: unknown
    }
    expect(asked).toEqual({
      summary: '短摘要',
      model: { provider: 'deepseek', model: 'chat' },
      usage: { inputTokens: 12, outputTokens: 3 },
    })
    expect(asks[0]).toMatchObject({ maxOutputTokens: 800, temperature: 0.2, capabilities: operation.capabilities })
    expect(asks[0]?.signal).toBe(operation.signal)
    // The question is trimmed into the prompt, which carries the note body.
    expect(asks[0]?.prompt).toContain('Question: what is this?')
    expect(asks[0]?.prompt).toContain('first line\n\nbody')

    // A blank question falls back to the summarize instruction; the answer's
    // absent model/usage leave those keys off the result.
    expect(await summarize.execute({ id: note.id, question: '   ' } as never, operation as never)).toEqual({ summary: 'default summary' })
    expect(asks[1]?.prompt).toContain('Summarize the following note in a few sentences.')

    // No question at all is the same instruction; a body over the prompt budget
    // is truncated to 60 000 characters plus the ellipsis marker.
    const long = await repository.create({ body: 'x'.repeat(60_001) }, operation)
    expect(await summarize.execute({ id: long.id } as never, operation as never)).toEqual({ summary: 'long default summary' })
    expect(asks[2]?.prompt).toContain('x'.repeat(60_000))
    expect(asks[2]?.prompt).toContain('\n…')
    expect(asks[2]?.prompt).not.toContain('x'.repeat(60_001))

    store.close()
    await ctx.fiber.dispose()
  })

  it('refuses summarization without a model port, for a missing note and for a trashed note', async () => {
    const operation = operationContext()
    const withoutModel = standaloneRepository()
    await expect(withoutModel.repository.summarize('missing', undefined, operation)).rejects.toMatchObject({ code: 'model-unavailable' })
    withoutModel.store.close()
    await withoutModel.ctx.fiber.dispose()

    const { port, asks } = modelPort([{ text: 'never called' }])
    const { ctx, store, repository } = standaloneRepository(port)
    await expect(repository.summarize('missing', undefined, operation)).rejects.toMatchObject({ code: 'not-found' })
    const trashed = await repository.create({ body: 'trashed' }, operation)
    await repository.remove(trashed.id, operation)
    await expect(repository.summarize(trashed.id, 'question', operation)).rejects.toMatchObject({ code: 'not-found' })
    expect(asks).toHaveLength(0)

    store.close()
    await ctx.fiber.dispose()
  })

  it('resolves a live note reference through the declaration and refuses a trashed or missing one', async () => {
    const { ctx, store, repository } = standaloneRepository()
    const operation = operationContext()
    const resolve = NotesDeclaration(repository).ops['resolveNote']!
    const note = await repository.create({ body: 'resolvable', tags: ['b', 'a'] }, operation)

    expect(await resolve.execute({ id: note.id } as never, operation as never)).toEqual({
      ref: { appId: 'notes', type: 'note', id: note.id },
      title: 'resolvable',
      summary: 'a · b',
    })

    await repository.remove(note.id, operation)
    await expect(resolve.execute({ id: note.id } as never, operation as never)).rejects.toMatchObject({ code: 'not-found' })
    await expect(resolve.execute({ id: 'missing' } as never, operation as never)).rejects.toMatchObject({ code: 'not-found' })

    store.close()
    await ctx.fiber.dispose()
  })

  it('reports degraded health with the load-failure reason for error and non-error throws', async () => {
    const { ctx, store, repository } = standaloneRepository()
    const declaration = NotesDeclaration(repository)

    repository.ensureLoaded = async () => { throw new Error('数据目录不可读') }
    expect(await declaration.health!({} as never)).toEqual({
      status: 'degraded',
      reason: 'notes data could not be loaded: 数据目录不可读',
    })

    repository.ensureLoaded = async () => { throw 'plain failure' as never }
    expect(await declaration.health!({} as never)).toEqual({
      status: 'degraded',
      reason: 'notes data could not be loaded: plain failure',
    })

    store.close()
    await ctx.fiber.dispose()
  })
})
