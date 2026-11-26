/**
 * The durable delegation store's own rule book, driven directly over temp files
 * (the bridge/harness suite proves the integrated port; this one pins the
 * primitives it cannot reach: malformed persisted records, the recovery
 * rewrite failure, the serialized mutation queue, validation bounds and the
 * report idempotency rules).
 *
 * Every case builds its own file so a corrupt record can never leak into
 * another host's state, and the store is the production class — nothing here
 * fakes persistence.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DelegationInfo } from '../src/types.ts'
import {
  DELEGATIONS_SCHEMA_VERSION, DelegationStore, MAX_REPORT_DETAILS_CHARS, delegationContextMessage, normalizeReport,
} from '../src/delegations.ts'
import type { DelegationStoreOptions } from '../src/delegations.ts'

/**
 * One persisted path whose rewrite throws a NON-Error, so the recovery failure
 * report must fall back to the raw thrown value rather than read `.message`.
 */
const rawWriteFailures = vi.hoisted(() => new Map<string, unknown>())

vi.mock('../src/platform-files.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/platform-files.ts')>()
  return {
    ...actual,
    writeVersionedJson: async (path: string, version: number, body: Record<string, unknown>): Promise<void> => {
      if (rawWriteFailures.has(path)) throw rawWriteFailures.get(path)
      await actual.writeVersionedJson(path, version, body)
    },
  }
})

/** Every temp directory this file created, removed after each case. */
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A fresh temp directory that the case's store file lives in. */
function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'delegation-store-'))
  directories.push(directory)
  return directory
}

/** A fresh store file path (the parent directory exists, the file does not). */
function tempPath(): string {
  return join(tempDir(), 'delegations.json')
}

/** Stage one persisted document body at the path before a store loads it. */
function stage(path: string, body: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ schemaVersion: DELEGATIONS_SCHEMA_VERSION, ...body }))
}

/** One persisted record, valid unless the case overrides it. */
function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'delegation-1',
    appId: 'todo',
    title: '写总结',
    instructions: '总结本周进展',
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

/** Build a store over a fresh file (the caller may pass a prepared directory). */
function storeWith(path = tempPath(), options: Partial<DelegationStoreOptions> = {}): DelegationStore {
  return new DelegationStore({ path, ...options })
}

/** Load one staged document and expect its refusal. */
async function loadFailure(body: Record<string, unknown>, pattern: RegExp): Promise<void> {
  const path = tempPath()
  stage(path, body)
  const store = storeWith(path)
  await expect(store.whenReady()).rejects.toThrow(pattern)
}

/** One committed pending record, read straight from the store. */
async function pending(store: DelegationStore, appId = 'todo'): Promise<DelegationInfo> {
  const created = await store.create(appId, { title: '标题', instructions: '指令' })
  return await recordOf(store, created.id)
}

/** Read one record or fail the case (the row must exist). */
async function recordOf(store: DelegationStore, id: string): Promise<DelegationInfo> {
  const found = await store.get(id)
  if (found === undefined) throw new Error(`test setup: no delegation ${id}`)
  return found
}

describe('the delegation store document', () => {
  it('creates, lists and reads records and survives a reload', async () => {
    const path = tempPath()
    const store = storeWith(path)
    const created = await store.create('todo', { title: ' 写总结 ', instructions: ' 总结本周进展 ' })
    expect(created).toMatchObject({ appId: 'todo', title: '写总结', instructions: '总结本周进展', status: 'pending' })
    const listed = await store.list('todo')
    expect(listed.map(one => one.id)).toEqual([created.id])
    expect(await store.list('other')).toEqual([])
    expect(await store.read('other', created.id)).toBeUndefined()
    expect(await store.read('todo', created.id)).toMatchObject({ id: created.id })
    expect(await store.all()).toHaveLength(1)
    expect(await store.all('other')).toEqual([])
    expect(await store.get(created.id)).toMatchObject({ id: created.id })
    expect(await store.get('delegation-missing')).toBeUndefined()

    // The document is the versioned envelope: a reload reads the very same row.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      schemaVersion: DELEGATIONS_SCHEMA_VERSION,
      delegations: [{ id: created.id, status: 'pending' }],
    })
    const reloaded = storeWith(path)
    await reloaded.whenReady()
    expect(await reloaded.all()).toMatchObject([{ id: created.id, status: 'pending' }])
  })

  it('validates the creation bounds before writing anything', async () => {
    const path = tempPath()
    const store = storeWith(path)
    await expect(store.create('todo', { title: 42 as never, instructions: 'i' }))
      .rejects.toThrow(/title must be a string/u)
    await expect(store.create('todo', { title: '   ', instructions: 'i' }))
      .rejects.toThrow(/title must not be empty/u)
    await expect(store.create('todo', { title: 't'.repeat(201), instructions: 'i' }))
      .rejects.toThrow(/title must be at most 200 characters/u)
    await expect(store.create('todo', { title: 't', instructions: null as never }))
      .rejects.toThrow(/instructions must be a string/u)
    await expect(store.create('todo', { title: 't', instructions: 'i'.repeat(8_001) }))
      .rejects.toThrow(/instructions must be at most 8000 characters/u)
    // A refused creation is never persisted.
    expect(await store.all()).toEqual([])
  })

  it('orders newest first and breaks a creation-time tie by id descending', async () => {
    // One frozen clock makes both records share createdAt; the id tie-break is
    // what makes the order deterministic.
    const store = storeWith(tempPath(), { now: () => new Date('2026-01-01T00:00:00.000Z') })
    const first = await store.create('todo', { title: 'a', instructions: 'a' })
    const second = await store.create('todo', { title: 'b', instructions: 'b' })
    const order = (await store.all()).map(one => one.id)
    expect(order).toEqual([first.id, second.id].sort((left, right) => right.localeCompare(left)))
  })

  it('serializes concurrent mutations: two creations both land, in queue order', async () => {
    const path = tempPath()
    const store = storeWith(path)
    const [first, second] = await Promise.all([
      store.create('todo', { title: '一', instructions: '一' }),
      store.create('todo', { title: '二', instructions: '二' }),
    ])
    expect(first.id).not.toBe(second.id)
    expect((await store.all()).map(one => one.id).sort()).toEqual([first.id, second.id].sort())
    expect(JSON.parse(readFileSync(path, 'utf8')).delegations).toHaveLength(2)
  })
})

describe('the delegation state machine', () => {
  it('binds a pending record once and refuses unknown, non-pending and busy bindings', async () => {
    const store = storeWith()
    await expect(store.bind('delegation-missing', 'area-1')).rejects.toThrow(/no delegation delegation-missing/u)
    const first = await pending(store)
    await expect(store.bind(first.id, 'area-1')).resolves.toMatchObject({ status: 'active', sessionId: 'area-1' })
    // Re-binding an active record is not "waiting to be sent" any more.
    await expect(store.bind(first.id, 'area-2')).rejects.toThrow(/is active, not waiting to be sent/u)
    // One Session executes one live delegation; a second pending record may not
    // be sent into the same Session.
    const second = await pending(store)
    await expect(store.bind(second.id, 'area-1')).rejects.toThrow(/already runs the delegation/u)
    // A different Session is free.
    await expect(store.bind(second.id, 'area-2')).resolves.toMatchObject({ status: 'active', sessionId: 'area-2' })
  })

  it('ends on a host unavailability, a human cancel and a gone Session, idempotently', async () => {
    const store = storeWith()
    const created = await pending(store)
    await store.bind(created.id, 'area-1')
    await expect(store.unavailable(created.id)).resolves.toMatchObject({ status: 'ended', outcome: 'unavailable' })
    // Idempotent: the final state is what the caller observes.
    await expect(store.unavailable(created.id)).resolves.toMatchObject({ status: 'ended', outcome: 'unavailable' })
    await expect(store.unavailable('delegation-missing')).rejects.toThrow(/could not be delivered/u)

    const gone = await pending(store)
    await store.bind(gone.id, 'area-2')
    await expect(store.sessionGone(gone.id)).resolves.toMatchObject({ status: 'ended', outcome: 'unavailable' })
    await expect(store.sessionGone(gone.id)).resolves.toMatchObject({ status: 'ended', outcome: 'unavailable' })
    await expect(store.sessionGone('delegation-missing')).rejects.toThrow(/no delegation/u)

    const cancelled = await pending(store)
    await expect(store.cancelByHuman(cancelled.id)).resolves.toMatchObject({ status: 'ended', outcome: 'cancelled' })
    await expect(store.cancelByHuman(cancelled.id)).resolves.toMatchObject({ status: 'ended', outcome: 'cancelled' })
    await expect(store.cancelByHuman('delegation-missing')).rejects.toThrow(/no delegation/u)
  })

  it('cancels through the application port only for its own records and idempotently', async () => {
    const store = storeWith()
    const created = await pending(store, 'todo')
    await expect(store.cancel('other', created.id)).rejects.toThrow(/no delegation/u)
    await expect(store.cancel('todo', created.id)).resolves.toMatchObject({ status: 'ended', outcome: 'cancelled' })
    // The port view is idempotent on an already-ended record.
    await expect(store.cancel('todo', created.id)).resolves.toMatchObject({ status: 'ended', outcome: 'cancelled' })
    // The app-facing projection carries no Session handle.
    expect(await store.list('todo')).toMatchObject([{ id: created.id, status: 'ended', outcome: 'cancelled' }])
    expect('sessionId' in (await store.list('todo'))[0]!).toBe(false)
  })

  it('moves active to needs-person on blocked and to ended on completed/failed, idempotently', async () => {
    const store = storeWith()
    const created = await pending(store)
    await store.bind(created.id, 'area-1')
    const blocked = await store.report('area-1', { outcome: 'blocked', summary: '需要用户选择', question: '选哪个？' })
    expect(blocked).toMatchObject({ status: 'needs-person', latestReport: { outcome: 'blocked', question: '选哪个？' } })
    // The identical retry while the record is still live answers the same record
    // instead of rewriting it.
    const retried = await store.report('area-1', { outcome: 'blocked', summary: '需要用户选择', question: '选哪个？' })
    expect(retried.updatedAt).toBe(blocked.updatedAt)
    expect(retried.latestReport).toEqual(blocked.latestReport)
    // A live session is still found by its binding.
    expect(await store.activeForSession('area-1')).toMatchObject({ id: created.id, status: 'needs-person' })
    expect(await store.sessionBusy('area-1')).toBe(true)
    expect(await store.activeForSession('area-2')).toBeUndefined()
    expect(await store.sessionBusy('area-2')).toBe(false)
    // A completed report ends the record.
    const completed = await store.report('area-1', { outcome: 'completed', summary: '做完了' })
    expect(completed).toMatchObject({ status: 'ended', outcome: 'completed' })
    expect(await store.sessionBusy('area-1')).toBe(false)
    // Failed maps to the failed outcome (not completed).
    const second = await pending(store)
    await store.bind(second.id, 'area-2')
    await expect(store.report('area-2', { outcome: 'failed', summary: '做不了' }))
      .resolves.toMatchObject({ status: 'ended', outcome: 'failed', latestReport: { outcome: 'failed' } })
  })

  it('answers a repeated report after the end only when the content is identical', async () => {
    let clock = 0
    const store = storeWith(tempPath(), { now: () => new Date(1_000 + clock++) })
    const created = await pending(store)
    await store.bind(created.id, 'area-1')
    await store.report('area-1', { outcome: 'completed', summary: '完成' })
    // The same envelope (no details on either side) is a tool retry: it answers
    // the ended record instead of refusing.
    await expect(store.report('area-1', { outcome: 'completed', summary: '完成' }))
      .resolves.toMatchObject({ id: created.id, status: 'ended', outcome: 'completed' })
    // Different content for an ended delegation is refused.
    await expect(store.report('area-1', { outcome: 'failed', summary: '完成' }))
      .rejects.toThrow(/not executing a delegation/u)
    // An unbound Session is refused.
    await expect(store.report('area-2', { outcome: 'completed', summary: '完成' }))
      .rejects.toThrow(/not executing a delegation/u)
  })

  it('reads back one recorded report by Session and picks the newest ended match', async () => {
    let clock = 0
    const store = storeWith(tempPath(), { now: () => new Date(1_000 + clock++) })
    const first = await pending(store)
    await store.bind(first.id, 'area-1')
    await store.report('area-1', { outcome: 'completed', summary: '完成' })
    const second = await pending(store)
    await store.bind(second.id, 'area-1')
    await store.report('area-1', { outcome: 'completed', summary: '完成' })
    expect(await store.reportRecorded('area-1', { outcome: 'completed', summary: '完成' }))
      .toMatchObject({ id: second.id })
    expect(await store.reportRecorded('area-1', { outcome: 'failed', summary: '完成' })).toBeUndefined()
    expect(await store.reportRecorded('area-2', { outcome: 'completed', summary: '完成' })).toBeUndefined()
    // The same Session may execute another delegation once the first ended.
    await expect(store.activeForSession('area-1')).resolves.toBeUndefined()
  })

  it('keeps the first matching report when a later record is older', async () => {
    // A decreasing clock inserts the newer record FIRST, so the scan compares an
    // older candidate against it and keeps the newer one.
    let clock = 10
    const store = storeWith(tempPath(), { now: () => new Date(1_000 + clock--) })
    const newer = await pending(store)
    await store.bind(newer.id, 'area-1')
    await store.report('area-1', { outcome: 'completed', summary: '完成' })
    const older = await pending(store)
    await store.bind(older.id, 'area-1')
    await store.report('area-1', { outcome: 'completed', summary: '完成' })
    expect(await store.reportRecorded('area-1', { outcome: 'completed', summary: '完成' }))
      .toMatchObject({ id: newer.id })
  })

  it('selects the newest live record for a Session if two ever share one', () => {
    const store = storeWith()
    const internals = store as unknown as {
      liveIn(records: ReadonlyMap<string, DelegationInfo>, sessionId: string): DelegationInfo | undefined
    }
    const base = {
      appId: 'todo', title: 't', instructions: 'i', status: 'active' as const, sessionId: 'area-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const records = new Map<string, DelegationInfo>([
      ['newer', { ...base, id: 'newer', updatedAt: '2026-01-01T00:00:02.000Z' }],
      ['older', { ...base, id: 'older', updatedAt: '2026-01-01T00:00:01.000Z' }],
    ])
    expect(internals.liveIn(records, 'area-1')).toMatchObject({ id: 'newer' })
    expect(internals.liveIn(records, 'area-2')).toBeUndefined()
  })
})

describe('the persisted record validation', () => {
  it('loads every valid status/outcome combination', async () => {
    const path = tempPath()
    stage(path, {
      delegations: [
        record({ id: 'd-pending', status: 'pending' }),
        record({ id: 'd-active', status: 'active', sessionId: 'area-1' }),
        record({ id: 'd-needs', status: 'needs-person', sessionId: 'area-2', latestReport: { outcome: 'blocked', summary: '问', question: '什么？' } }),
        record({ id: 'd-done', status: 'ended', outcome: 'completed', latestReport: { outcome: 'completed', summary: '完成', details: { ref: 'note-1' } } }),
        record({ id: 'd-failed', status: 'ended', outcome: 'failed' }),
        record({ id: 'd-cancelled', status: 'ended', outcome: 'cancelled' }),
        record({ id: 'd-interrupted', status: 'ended', outcome: 'interrupted' }),
        record({ id: 'd-unavailable', status: 'ended', outcome: 'unavailable' }),
      ],
    })
    const store = storeWith(path)
    await store.whenReady()
    // In-flight records are recovered as interrupted, with one change notice per owner.
    const changed: string[] = []
    const rows = await store.all()
    expect(rows).toHaveLength(8)
    expect(rows.find(one => one.id === 'd-active')).toMatchObject({ status: 'ended', outcome: 'interrupted' })
    expect(rows.find(one => one.id === 'd-needs')).toMatchObject({
      status: 'ended', outcome: 'interrupted', latestReport: { outcome: 'blocked', question: '什么？' },
    })
    expect(rows.find(one => one.id === 'd-pending')).toMatchObject({ status: 'pending' })
    expect(rows.find(one => one.id === 'd-done')).toMatchObject({ status: 'ended', outcome: 'completed' })
    expect(rows.find(one => one.id === 'd-failed')).toMatchObject({ status: 'ended', outcome: 'failed' })
    expect(changed).toEqual([])
    expect((await store.all('todo')).length).toBe(8)
    // The recovery is persisted: a second load no longer recovers anything.
    const second = storeWith(path, { onChange: (appId) => { changed.push(appId) } })
    await second.whenReady()
    expect(changed).toEqual([])
    expect((await second.all()).find(one => one.id === 'd-active')).toMatchObject({ status: 'ended', outcome: 'interrupted' })
  })

  it('reports the applications whose in-flight records were recovered', async () => {
    const path = tempPath()
    stage(path, { delegations: [record({ id: 'd-active', status: 'active', sessionId: 'area-1' })] })
    const changed: string[] = []
    const store = storeWith(path, { onChange: (appId) => { changed.push(appId) } })
    await store.whenReady()
    expect(changed).toEqual(['todo'])
  })

  it('reports a recovery rewrite failure and still answers the recovered records', async () => {
    const directory = tempDir()
    const path = join(directory, 'delegations.json')
    stage(path, { delegations: [record({ id: 'd-active', status: 'active', sessionId: 'area-1' })] })
    // A read-only directory makes the atomic rewrite (temp file + rename) fail.
    chmodSync(directory, 0o500)
    try {
      const problems: string[] = []
      const store = storeWith(path, { onProblem: (problem) => { problems.push(problem) } })
      await store.whenReady()
      expect(problems.join('\n')).toContain('could not be rewritten after the restart recovery')
      expect(await store.get('d-active')).toMatchObject({ status: 'ended', outcome: 'interrupted' })
    } finally {
      chmodSync(directory, 0o700)
    }
    // Without an onProblem callback the default is a silent no-op.
    chmodSync(directory, 0o500)
    try {
      const store = storeWith(path)
      await store.whenReady()
      expect(await store.get('d-active')).toMatchObject({ status: 'ended', outcome: 'interrupted' })
    } finally {
      chmodSync(directory, 0o700)
    }
  })

  it('renders a non-Error recovery write failure without reading .message', async () => {
    const path = tempPath()
    stage(path, { delegations: [record({ id: 'd-active', status: 'active', sessionId: 'area-1' })] })
    rawWriteFailures.set(path, 'raw recovery failure')
    try {
      const problems: string[] = []
      const store = storeWith(path, { onProblem: (problem) => { problems.push(problem) } })
      await store.whenReady()
      expect(problems.join('\n')).toContain('raw recovery failure')
      expect(await store.get('d-active')).toMatchObject({ status: 'ended', outcome: 'interrupted' })
    } finally {
      rawWriteFailures.delete(path)
    }
  })

  it('refuses a document whose delegations field is not an array', async () => {
    await loadFailure({ delegations: {} }, /must carry a delegations array/u)
    await loadFailure({}, /must carry a delegations array/u)
  })

  it('refuses a row that is not an object', async () => {
    await loadFailure({ delegations: [42] }, /every application delegation record must be an object/u)
    await loadFailure({ delegations: [null] }, /every application delegation record must be an object/u)
  })

  it('refuses a duplicate or empty id', async () => {
    await loadFailure({ delegations: [record(), record()] }, /needs a unique non-empty id/u)
    await loadFailure({ delegations: [record({ id: '' })] }, /needs a unique non-empty id/u)
    await loadFailure({ delegations: [record({ id: 7 })] }, /needs a unique non-empty id/u)
  })

  it('refuses a row missing its identity fields', async () => {
    await loadFailure({ delegations: [record({ appId: undefined })] }, /needs an appId/u)
    await loadFailure({ delegations: [record({ appId: '' })] }, /needs an appId/u)
    await loadFailure({ delegations: [record({ title: undefined })] }, /needs a title/u)
    await loadFailure({ delegations: [record({ title: '' })] }, /needs a title/u)
    await loadFailure({ delegations: [record({ instructions: 5 })] }, /needs instructions/u)
  })

  it('refuses an unknown status and a missing timestamp', async () => {
    await loadFailure({ delegations: [record({ status: 'weird' })] }, /has an unknown status/u)
    await loadFailure({ delegations: [record({ createdAt: 1 })] }, /needs timestamps/u)
    await loadFailure({ delegations: [record({ updatedAt: undefined })] }, /needs timestamps/u)
  })

  it('refuses an unknown outcome and an ended row without one', async () => {
    await loadFailure({ delegations: [record({ status: 'ended', outcome: 'weird' })] }, /has an unknown outcome/u)
    await loadFailure({ delegations: [record({ status: 'ended' })] }, /ended without an outcome/u)
  })

  it('refuses a malformed sessionId', async () => {
    await loadFailure({ delegations: [record({ sessionId: '' })] }, /has a malformed sessionId/u)
    await loadFailure({ delegations: [record({ sessionId: 9 })] }, /has a malformed sessionId/u)
  })

  it('refuses an invalid latest report', async () => {
    await loadFailure(
      { delegations: [record({ status: 'ended', outcome: 'failed', latestReport: { outcome: 'done', summary: 'x' } })] },
      /carries an invalid report/u,
    )
    await loadFailure(
      { delegations: [record({ latestReport: { outcome: 'completed', summary: '' } })] },
      /carries an invalid report/u,
    )
  })
})

describe('the report envelope validation', () => {
  it('normalizes the accepted envelope and drops absent optional fields', () => {
    expect(normalizeReport({ outcome: 'completed', summary: ' 完成 ', question: undefined, details: undefined }))
      .toEqual({ outcome: 'completed', summary: '完成' })
    expect(normalizeReport({ outcome: 'completed', summary: '完成', question: null }))
      .toEqual({ outcome: 'completed', summary: '完成' })
    expect(normalizeReport({ outcome: 'completed', summary: '完成', question: '' }))
      .toEqual({ outcome: 'completed', summary: '完成' })
    expect(normalizeReport({ outcome: 'blocked', summary: '等', question: ' 哪个？ ', details: { a: 1 } }))
      .toEqual({ outcome: 'blocked', summary: '等', question: '哪个？', details: { a: 1 } })
  })

  it('refuses a non-object envelope, an unknown outcome and an absent blocked question', () => {
    expect(() => normalizeReport(null)).toThrow(/must be an object/u)
    expect(() => normalizeReport('done')).toThrow(/must be an object/u)
    expect(() => normalizeReport([])).toThrow(/must be an object/u)
    expect(() => normalizeReport({ outcome: 'done', summary: 'x' })).toThrow(/outcome must be/u)
    expect(() => normalizeReport({ outcome: 'blocked', summary: 'x' })).toThrow(/concrete question/u)
  })

  it('bounds the summary, question and details payloads', () => {
    expect(() => normalizeReport({ outcome: 'failed', summary: 'x'.repeat(4_001) })).toThrow(/summary must be at most 4000/u)
    expect(() => normalizeReport({ outcome: 'blocked', summary: 'x', question: 'q'.repeat(2_001) }))
      .toThrow(/question must be at most 2000/u)
    expect(() => normalizeReport({ outcome: 'failed', summary: 'x', details: { big: 'x'.repeat(MAX_REPORT_DETAILS_CHARS) } }))
      .toThrow(/JSON characters/u)
  })

  it('refuses details that cannot be serialized', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => normalizeReport({ outcome: 'failed', summary: 'x', details: circular })).toThrow(/not serializable/u)
    // A toJSON that throws a non-Error is reported by its raw value too.
    const hostile = { toJSON: (): never => { throw 'raw details failure' } }
    expect(() => normalizeReport({ outcome: 'failed', summary: 'x', details: hostile }))
      .toThrow(/not serializable: raw details failure/u)
  })
})

describe('the trusted execution context bounds', () => {
  it('keeps the application instructions out of the platform context', () => {
    const instructions = 'x'.repeat(2_000)
    const message = delegationContextMessage({
      id: 'delegation-1',
      appId: 'todo',
      title: '长指令',
      instructions,
      status: 'active',
      sessionId: 'area-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const text = message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    expect(text).not.toContain(instructions)
    expect(text).not.toContain('x'.repeat(100))
    expect(text).toContain('delegation_report')
    expect(text.length).toBeLessThan(1_200)
  })
})
