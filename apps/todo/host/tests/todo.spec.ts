import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ApplicationRuntime } from '@matrix1001/dsh-application-harness-runtime'
import { AppStore } from '@matrix1001/dsh-application-harness-store'
import * as NotesPlugin from '../../../notes/host/src/index.ts'
import * as TodoPlugin from '../src/index.ts'

async function ready(runtime: ApplicationRuntime, id: string): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (runtime.list().find(entry => entry.declaration.id === id)?.status() === 'available') return
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  }
  throw new Error(`${id} did not become available`)
}

function host() {
  const ctx = new Context()
  const runtime = new ApplicationRuntime()
  const store = new AppStore(ctx)
  ctx.reflect.provide('applications', runtime)
  return { ctx, runtime, store }
}

const at = '2026-01-01T00:00:00.000Z'

describe('todo application', () => {
  it('creates a task and completes it', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'todo' }, capabilities: ['capability:storage'], grantedAt: at })
    await TodoPlugin.apply(ctx)
    await ready(runtime, 'todo')
    const created = await runtime.call({ kind: 'human' }, 'todo', 'createTask', { title: 'Ship it', dueDate: '2026-11-05', priority: 1 })
    expect(created).toMatchObject({ status: 'success' })
    const id = created.status === 'success' ? (created.result as { id: string }).id : ''
    const task = await runtime.call({ kind: 'human' }, 'todo', 'getTask', { id })
    expect(task).toMatchObject({ status: 'success', result: { title: 'Ship it', priority: 1, version: 1 } })
    const version = task.status === 'success' ? (task.result as { version: number }).version : 0
    expect(await runtime.call({ kind: 'human' }, 'todo', 'updateTask', { id, expectedVersion: version, completed: true })).toMatchObject({ status: 'success' })
    expect(await runtime.call({ kind: 'human' }, 'todo', 'updateTask', { id, expectedVersion: version, completed: false })).toMatchObject({ status: 'failed', error: { code: 'app.stale-version' } })
    expect(runtime.list().find(entry => entry.declaration.id === 'todo')?.declaration.data).toMatchObject({ kind: 'unified', namespace: 'todo', schemaVersion: 1 })
    store.close()
    await ctx.fiber.dispose()
  })

  it('replays a task by requestId, records its source and filters a due range', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'todo' }, capabilities: ['capability:storage'], grantedAt: at })
    await TodoPlugin.apply(ctx)
    await ready(runtime, 'todo')
    const first = await runtime.call({ kind: 'human' }, 'todo', 'createTask', {
      title: 'from inbox', dueDate: '2026-11-05', requestId: 'inbox:1', source: { app: 'inbox', id: 'entry-1' },
    })
    const second = await runtime.call({ kind: 'human' }, 'todo', 'createTask', {
      title: 'different', dueDate: '2026-11-06', requestId: 'inbox:1',
    })
    if (first.status !== 'success' || second.status !== 'success') throw new Error('create failed')
    expect((second.result as { id: string }).id).toBe((first.result as { id: string }).id)
    const fetched = await runtime.call({ kind: 'human' }, 'todo', 'getTask', { id: (first.result as { id: string }).id })
    if (fetched.status !== 'success') throw new Error('get failed')
    expect((fetched.result as { source: { id: string } }).source.id).toBe('entry-1')
    const range = await runtime.call({ kind: 'human' }, 'todo', 'listTasks', { dueFrom: '2026-11-05', dueTo: '2026-11-05' })
    if (range.status !== 'success') throw new Error('list failed')
    expect(range.result).toHaveLength(1)
    store.close()
    await ctx.fiber.dispose()
  })

  it('reads page-citation state for tasks', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'todo' }, capabilities: ['capability:storage'], grantedAt: at })
    await TodoPlugin.apply(ctx)
    await ready(runtime, 'todo')
    await runtime.call({ kind: 'human' }, 'todo', 'createTask', { title: 'cited task' })
    expect(await runtime.call({ kind: 'human' }, 'todo', 'contextState', {})).toMatchObject({
      status: 'success',
      result: { tasks: [{ title: 'cited task' }] },
    })
    store.close()
    await ctx.fiber.dispose()
  })

  it('resolves linked notes through the peer declaration', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'notes' }, capabilities: ['capability:storage'], grantedAt: at })
    await runtime.grant({ caller: { kind: 'app', appId: 'todo' }, capabilities: ['capability:storage'], grantedAt: at })
    await NotesPlugin.apply(ctx)
    await ready(runtime, 'notes')
    const note = await runtime.call({ kind: 'human' }, 'notes', 'create', { body: 'linked note' })
    const noteId = note.status === 'success' ? (note.result as { id: string }).id : ''
    await TodoPlugin.apply(ctx)
    await ready(runtime, 'todo')
    expect(await runtime.call({ kind: 'human' }, 'todo', 'resolveNotes', { ids: [noteId] })).toMatchObject({ status: 'success' })
    store.close()
    await ctx.fiber.dispose()
  })

  it('declares identity, data, capabilities, calls and operations without projects', async () => {
    const { ctx, runtime, store } = host()
    await TodoPlugin.apply(ctx)
    await ready(runtime, 'todo')
    const declaration = runtime.list().find(entry => entry.declaration.id === 'todo')!.declaration
    expect(declaration).toMatchObject({
      id: 'todo',
      name: '待办',
      description: '待办、截止日与优先级。',
      version: '0.1.1-dev.0',
      generation: 2,
      data: { kind: 'unified', namespace: 'todo', schemaVersion: 1 },
      capabilities: ['storage', 'delegate'],
      calls: [{ app: 'notes', ops: ['resolveNotes', 'searchNotes'] }],
    })
    expect(Object.keys(declaration.ops).sort()).toEqual([
      'applyDelegationResult', 'contextState', 'createDelegation', 'createTask', 'deleteTask', 'getTask', 'listTasks', 'resolveNotes', 'resolveTask', 'restoreTask', 'searchNotes', 'taskDelegation', 'updateTask',
    ])
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('todo validation and edge paths', () => {
  it('covers task validation, filtering, restore and peer degradation', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'todo' }, capabilities: ['capability:storage'], grantedAt: at })
    await TodoPlugin.apply(ctx)
    await ready(runtime, 'todo')
    const call = async (op: string, args: unknown) => await runtime.call({ kind: 'human' }, 'todo', op, args as never)
    expect(await call('createTask', { title: '' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('createTask', { title: 'x', notes: 'n'.repeat(20_001) })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('createTask', { title: 'x', dueDate: 'soon' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('createTask', { title: 'x', priority: 4 })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('createTask', { title: 'x', assignee: 'nobody' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('createTask', { title: 'x', noteIds: Array.from({ length: 11 }, () => 'n') })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    const task = await call('createTask', { title: '  One  ', notes: 'body', dueDate: '2026-11-05', priority: 1, assignee: 'agent', noteIds: ['n1', 'n1'] })
    if (task.status !== 'success') throw new Error('task')
    const taskId = (task.result as { id: string }).id
    expect(await call('getTask', { id: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call('listTasks', { includeCompleted: true, dueFrom: '2026-11-01', dueTo: '2026-11-30', assignee: 'agent' })).toMatchObject({ status: 'success' })
    expect(await call('listTasks', { dueDate: '2026-11-05' })).toMatchObject({ status: 'success', result: [{ id: taskId }] })
    expect(await call('updateTask', { id: taskId, expectedVersion: 1, title: 'Two', notes: '', dueDate: null, assignee: 'me', priority: 3, completed: true, noteIds: [] })).toMatchObject({ status: 'success' })
    expect(await call('updateTask', { id: taskId, expectedVersion: 1, title: 'stale' })).toMatchObject({ status: 'failed', error: { code: 'app.stale-version' } })
    expect(await call('updateTask', { id: 'missing', expectedVersion: 1 })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call('deleteTask', { id: taskId })).toMatchObject({ status: 'success' })
    expect(await call('deleteTask', { id: taskId })).toMatchObject({ status: 'success' })
    expect(await call('deleteTask', { id: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call('listTasks', { includeCompleted: true })).toMatchObject({ status: 'success', result: [] })
    expect(await call('restoreTask', { id: taskId })).toMatchObject({ status: 'success' })
    expect(await call('restoreTask', { id: taskId })).toMatchObject({ status: 'success' })
    expect(await call('restoreTask', { id: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call('resolveNotes', { ids: ['n1'] })).toMatchObject({ status: 'success', result: { notes: [], unavailable: true } })
    expect(await call('searchNotes', { query: 'x' })).toMatchObject({ status: 'success', result: { notes: [], unavailable: true } })
    const reload = runtime.list().find(entry => entry.declaration.id === 'todo')?.declaration.reload
    await reload?.({} as never)
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('todo plugin mount', () => {
  it('fails loudly without the application store', async () => {
    const ctx = new Context()
    await expect(TodoPlugin.apply(ctx)).rejects.toThrow(/application store/u)
    await ctx.fiber.dispose()
  })
})

describe('todo sorting and guarded updates', () => {
  it('sorts dated/undated tasks and refuses updates of deleted tasks', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'todo' }, capabilities: ['capability:storage'], grantedAt: at })
    await TodoPlugin.apply(ctx)
    await ready(runtime, 'todo')
    const call = async (op: string, args: unknown) => await runtime.call({ kind: 'human' }, 'todo', op, args as never)
    const first = await call('createTask', { title: 'undated' })
    const second = await call('createTask', { title: 'dated', dueDate: '2026-11-05' })
    const third = await call('createTask', { title: 'same', dueDate: '2026-11-05', priority: 3 })
    if (first.status !== 'success' || second.status !== 'success' || third.status !== 'success') throw new Error('create')
    const listed = await call('listTasks', { includeCompleted: true })
    if (listed.status !== 'success') throw new Error('list')
    expect((listed.result as Array<{ title: string }>).map(task => task.title)).toEqual(['dated', 'same', 'undated'])
    const secondId = (second.result as { id: string }).id
    const deleted = await call('deleteTask', { id: secondId })
    if (deleted.status !== 'success') throw new Error('delete')
    expect(await call('updateTask', { id: secondId, expectedVersion: 1, title: 'x' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('todo branches', () => {
  it('sorts equal due/priority by creation, updates without a title and replays a create', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'todo' }, capabilities: ['capability:storage'], grantedAt: at })
    await TodoPlugin.apply(ctx)
    await ready(runtime, 'todo')
    const call = async (op: string, args: unknown) => await runtime.call({ kind: 'human' }, 'todo', op, args as never)
    const first = await call('createTask', { title: 'first', requestId: 'r1' })
    const replay = await call('createTask', { title: 'ignored', requestId: 'r1' })
    if (first.status !== 'success' || replay.status !== 'success') throw new Error('create')
    expect((replay.result as { id: string }).id).toBe((first.result as { id: string }).id)
    const second = await call('createTask', { title: 'second' })
    if (second.status !== 'success') throw new Error('second')
    const listed = await call('listTasks', { includeCompleted: true })
    if (listed.status !== 'success') throw new Error('list')
    expect((listed.result as Array<{ title: string }>).map(task => task.title)).toEqual(['first', 'second'])
    expect(await call('updateTask', { id: (first.result as { id: string }).id, expectedVersion: 1 })).toMatchObject({ status: 'success', result: { title: 'first' } })
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('todo completion and note search branches', () => {
  it('toggles completed both ways and searches notes when notes is mounted', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'notes' }, capabilities: ['capability:storage'], grantedAt: at })
    await runtime.grant({ caller: { kind: 'app', appId: 'todo' }, capabilities: ['capability:storage'], grantedAt: at })
    await NotesPlugin.apply(ctx)
    await ready(runtime, 'notes')
    await runtime.call({ kind: 'human' }, 'notes', 'create', { body: 'searchable note' })
    await TodoPlugin.apply(ctx)
    await ready(runtime, 'todo')
    const call = async (op: string, args: unknown) => await runtime.call({ kind: 'human' }, 'todo', op, args as never)
    const task = await call('createTask', { title: 'x' })
    if (task.status !== 'success') throw new Error('task')
    const id = (task.result as { id: string }).id
    expect(await call('updateTask', { id, expectedVersion: 1, completed: true })).toMatchObject({ status: 'success' })
    expect(await call('updateTask', { id, expectedVersion: 2, completed: false })).toMatchObject({ status: 'success' })
    expect(await call('searchNotes', { query: 'searchable' })).toMatchObject({ status: 'success', result: [{ title: 'searchable note' }] })
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('todo delegation (WP4b)', () => {
  /** One in-memory platform delegation store. */
  function delegationPort() {
    const records = new Map<string, import('@matrix1001/dsh-application-harness-runtime').AppDelegation>()
    let serial = 0
    const port: import('@matrix1001/dsh-application-harness-runtime').DelegationPort = {
      create: async (appId, input) => {
        const created = {
          id: `delegation-${String(++serial)}`,
          appId,
          title: input.title,
          instructions: input.instructions,
          status: 'pending' as const,
          createdAt: at,
          updatedAt: at,
        }
        records.set(created.id, created)
        return created
      },
      list: async appId => [...records.values()].filter(record => record.appId === appId),
      read: async (appId, id) => {
        const found = records.get(id)
        return found !== undefined && found.appId === appId ? found : undefined
      },
      cancel: async (appId, id) => {
        const found = records.get(id)
        if (found === undefined || found.appId !== appId) throw new Error(`no delegation ${id}`)
        const ended = { ...found, status: 'ended' as const, outcome: 'cancelled' as const }
        records.set(id, ended)
        return ended
      },
    }
    return { port, records }
  }

  async function delegationHost() {
    const { ctx, runtime, store } = host()
    const { port, records } = delegationPort()
    runtime.useDelegationStore(port)
    await runtime.grant({ caller: { kind: 'app', appId: 'todo' }, capabilities: ['capability:storage', 'capability:delegate'], grantedAt: at })
    await TodoPlugin.apply(ctx)
    await ready(runtime, 'todo')
    const call = async (op: string, args: unknown) => await runtime.call({ kind: 'human' }, 'todo', op, args as never)
    return { ctx, runtime, store, records, call }
  }

  it('prepares a pending delegation from the todo without touching the task version', async () => {
    const { ctx, store, records, call } = await delegationHost()
    const created = await call('createTask', { title: '写周报', notes: '包含本周进展', dueDate: '2026-11-20' })
    if (created.status !== 'success') throw new Error('create')
    const taskId = (created.result as { id: string }).id
    const outcome = await call('createDelegation', { taskId })
    if (outcome.status !== 'success') throw new Error(JSON.stringify(outcome))
    const delegation = (outcome.result as { delegation: { id: string; title: string; instructions: string; status: string } }).delegation
    expect(delegation.status).toBe('pending')
    expect(delegation.title).toContain('写周报')
    expect(delegation.instructions).toContain('包含本周进展')
    expect(delegation.instructions).toContain('2026-11-20')
    expect(records.get(delegation.id)).toMatchObject({ appId: 'todo', status: 'pending' })
    // The task document is untouched: an open editor's version stays valid.
    expect(await call('getTask', { id: taskId })).toMatchObject({ status: 'success', result: { version: 1 } })
    // The link itself is readable through the application's own operation.
    expect(await call('taskDelegation', { taskId })).toMatchObject({
      status: 'success',
      result: { delegation: { id: delegation.id, status: 'pending' }, applied: false },
    })
    store.close()
    await ctx.fiber.dispose()
  })

  it('keeps one live delegation per todo and allows a new one after it ends', async () => {
    const { ctx, store, records, call } = await delegationHost()
    const created = await call('createTask', { title: 'x' })
    if (created.status !== 'success') throw new Error('create')
    const taskId = (created.result as { id: string }).id
    const first = await call('createDelegation', { taskId })
    if (first.status !== 'success') throw new Error('first')
    const firstId = (first.result as { delegation: { id: string } }).delegation.id
    expect(await call('createDelegation', { taskId })).toMatchObject({ status: 'failed', error: { code: 'app.delegation-active' } })
    // A blocked (needs-person) delegation is live too.
    records.set(firstId, { ...records.get(firstId)!, status: 'needs-person', latestReport: { outcome: 'blocked', summary: 'need', question: 'which?' } })
    expect(await call('createDelegation', { taskId })).toMatchObject({ status: 'failed', error: { code: 'app.delegation-active' } })
    // Ended: a retry creates a NEW delegation and the todo points at it.
    records.set(firstId, { ...records.get(firstId)!, status: 'ended', outcome: 'failed', latestReport: { outcome: 'failed', summary: 'boom' } })
    const retry = await call('createDelegation', { taskId })
    if (retry.status !== 'success') throw new Error('retry')
    const retryId = (retry.result as { delegation: { id: string } }).delegation.id
    expect(retryId).not.toBe(firstId)
    expect(await call('taskDelegation', { taskId })).toMatchObject({
      status: 'success',
      result: { delegation: { id: retryId, status: 'pending' }, applied: false },
    })
    store.close()
    await ctx.fiber.dispose()
  })

  it('appends an ended report only on the user request, idempotently, and never completes the todo', async () => {
    const { ctx, store, records, call } = await delegationHost()
    const created = await call('createTask', { title: '写总结', notes: '原始备注' })
    if (created.status !== 'success') throw new Error('create')
    const taskId = (created.result as { id: string }).id
    const prepared = await call('createDelegation', { taskId })
    if (prepared.status !== 'success') throw new Error('prepare')
    const delegationId = (prepared.result as { delegation: { id: string } }).delegation.id
    // Still pending: nothing to append yet.
    expect(await call('applyDelegationResult', { taskId, expectedVersion: 1, delegationId }))
      .toMatchObject({ status: 'failed', error: { code: 'app.delegation-not-ended' } })
    records.set(delegationId, {
      ...records.get(delegationId)!,
      status: 'ended',
      outcome: 'completed',
      latestReport: { outcome: 'completed', summary: '已完成总结', details: { link: 'note-1' } },
    })
    const applied = await call('applyDelegationResult', { taskId, expectedVersion: 1, delegationId })
    if (applied.status !== 'success') throw new Error(JSON.stringify(applied))
    const task = applied.result as { notes: string; completedAt: number | null; version: number }
    expect(task.notes).toBe('原始备注\n\n[委托结果 · 完成]\n已完成总结')
    expect(task.completedAt).toBeNull()
    expect(task.version).toBe(2)
    // The result is not appended twice (a retried click returns the current task).
    const replay = await call('applyDelegationResult', { taskId, expectedVersion: 1, delegationId })
    expect(replay).toMatchObject({ status: 'success', result: { notes: '原始备注\n\n[委托结果 · 完成]\n已完成总结', version: 2 } })
    expect(await call('taskDelegation', { taskId })).toMatchObject({ status: 'success', result: { applied: true } })
    // An ended delegation without a report cannot be applied.
    const { latestReport: _latestReport, ...cancelledRecord } = records.get(delegationId)!
    records.set(delegationId, { ...cancelledRecord, status: 'ended', outcome: 'cancelled' })
    const cancelled = await call('createDelegation', { taskId })
    if (cancelled.status !== 'success') throw new Error('retry')
    const cancelledId = (cancelled.result as { delegation: { id: string } }).delegation.id
    records.set(cancelledId, { ...records.get(cancelledId)!, status: 'ended', outcome: 'cancelled' })
    expect(await call('applyDelegationResult', { taskId, expectedVersion: 2, delegationId: cancelledId }))
      .toMatchObject({ status: 'failed', error: { code: 'app.delegation-no-result' } })
    store.close()
    await ctx.fiber.dispose()
  })
})
