import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ApplicationRuntime } from '@matrix1001/dsh-application-harness-runtime'
import { AppStore } from '@matrix1001/dsh-application-harness-store'
import * as NotesPlugin from '../../notes/src/index.ts'
import * as TasksPlugin from '../src/index.ts'

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

describe('tasks application', () => {
  it('creates a project and task and completes it', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'tasks' }, capabilities: ['capability:storage'], grantedAt: at })
    await TasksPlugin.apply(ctx)
    await ready(runtime, 'tasks')
    const project = await runtime.call({ kind: 'human' }, 'tasks', 'createProject', { name: 'App Harness' })
    expect(project).toMatchObject({ status: 'success' })
    const projectId = project.status === 'success' ? (project.result as { id: string }).id : ''
    const created = await runtime.call({ kind: 'human' }, 'tasks', 'createTask', { title: 'Ship it', projectId, dueDate: '2026-11-05', priority: 1 })
    expect(created).toMatchObject({ status: 'success' })
    const task = created.status === 'success' ? created.result as { id: string; version: number } : undefined
    expect(await runtime.call({ kind: 'human' }, 'tasks', 'today', { date: '2026-11-05' })).toMatchObject({ status: 'success' })
    expect(await runtime.call({ kind: 'human' }, 'tasks', 'updateTask', { id: task!.id, expectedVersion: task!.version, completed: true })).toMatchObject({ status: 'success' })
    expect(await runtime.call({ kind: 'human' }, 'tasks', 'updateTask', { id: task!.id, expectedVersion: task!.version, completed: false })).toMatchObject({ status: 'failed', error: { code: 'app.stale-version' } })
    expect(runtime.list().find(entry => entry.declaration.id === 'tasks')?.declaration.data).toMatchObject({ namespace: 'tasks' })
    store.close()
    await ctx.fiber.dispose()
  })

  it('replays a task by requestId, records its source and filters a due range', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'tasks' }, capabilities: ['capability:storage'], grantedAt: at })
    await TasksPlugin.apply(ctx)
    await ready(runtime, 'tasks')
    const first = await runtime.call({ kind: 'human' }, 'tasks', 'createTask', {
      title: 'from inbox', dueDate: '2026-11-05', requestId: 'inbox:1', source: { app: 'inbox', id: 'entry-1' },
    })
    const second = await runtime.call({ kind: 'human' }, 'tasks', 'createTask', {
      title: 'different', dueDate: '2026-11-06', requestId: 'inbox:1',
    })
    if (first.status !== 'success' || second.status !== 'success') throw new Error('create failed')
    expect((second.result as { id: string }).id).toBe((first.result as { id: string }).id)
    expect((first.result as { source: { id: string } }).source.id).toBe('entry-1')
    const range = await runtime.call({ kind: 'human' }, 'tasks', 'listTasks', { dueFrom: '2026-11-05', dueTo: '2026-11-05' })
    if (range.status !== 'success') throw new Error('list failed')
    expect(range.result).toHaveLength(1)
    store.close()
    await ctx.fiber.dispose()
  })

  it('reads page-citation state for tasks and projects', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'tasks' }, capabilities: ['capability:storage'], grantedAt: at })
    await TasksPlugin.apply(ctx)
    await ready(runtime, 'tasks')
    const project = await runtime.call({ kind: 'human' }, 'tasks', 'createProject', { name: 'cited' })
    if (project.status !== 'success') throw new Error('project failed')
    await runtime.call({ kind: 'human' }, 'tasks', 'createTask', { title: 'cited task', projectId: (project.result as { id: string }).id })
    expect(await runtime.call({ kind: 'human' }, 'tasks', 'contextState', {})).toMatchObject({
      status: 'success',
      result: { tasks: [{ title: 'cited task' }], projects: [{ name: 'cited' }] },
    })
    store.close()
    await ctx.fiber.dispose()
  })

  it('resolves linked notes through the peer declaration', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'notes' }, capabilities: ['capability:storage'], grantedAt: at })
    await runtime.grant({ caller: { kind: 'app', appId: 'tasks' }, capabilities: ['capability:storage'], grantedAt: at })
    await runtime.grant({ caller: { kind: 'app', appId: 'tasks' }, capabilities: ['notes#resolveNotes'], grantedAt: at })
    await NotesPlugin.apply(ctx)
    await ready(runtime, 'notes')
    const note = await runtime.call({ kind: 'human' }, 'notes', 'create', { body: 'linked note' })
    const noteId = note.status === 'success' ? (note.result as { id: string }).id : ''
    await TasksPlugin.apply(ctx)
    await ready(runtime, 'tasks')
    expect(await runtime.call({ kind: 'human' }, 'tasks', 'resolveNotes', { ids: [noteId] })).toMatchObject({ status: 'success' })
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('tasks validation and edge paths', () => {
  it('covers task and project validation, filtering, restore and peer degradation', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'tasks' }, capabilities: ['capability:storage'], grantedAt: at })
    await TasksPlugin.apply(ctx)
    await ready(runtime, 'tasks')
    const call = async (op: string, args: unknown) => await runtime.call({ kind: 'human' }, 'tasks', op, args as never)
    expect(await call('createProject', { name: '' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    const project = await call('createProject', { name: 'Ops' })
    if (project.status !== 'success') throw new Error('project')
    const projectId = (project.result as { id: string }).id
    expect(await call('updateProject', { id: projectId, expectedVersion: 99, name: 'x' })).toMatchObject({ status: 'failed', error: { code: 'app.stale-version' } })
    expect(await call('updateProject', { id: 'missing', expectedVersion: 1, name: 'x' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call('updateProject', { id: projectId, expectedVersion: 1, name: 'Renamed' })).toMatchObject({ status: 'success' })
    expect(await call('listProjects', {})).toMatchObject({ status: 'success', result: [{ name: 'Renamed' }] })
    expect(await call('createTask', { title: '' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('createTask', { title: 'x', notes: 'n'.repeat(20_001) })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('createTask', { title: 'x', dueDate: 'soon' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('createTask', { title: 'x', priority: 4 })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('createTask', { title: 'x', assignee: 'nobody' })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('createTask', { title: 'x', noteIds: Array.from({ length: 11 }, () => 'n') })).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    expect(await call('createTask', { title: 'x', projectId: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    const task = await call('createTask', { title: '  One  ', notes: 'body', projectId, dueDate: '2026-11-05', priority: 1, assignee: 'agent', noteIds: ['n1', 'n1'] })
    if (task.status !== 'success') throw new Error('task')
    const taskId = (task.result as { id: string }).id
    expect(await call('getTask', { id: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call('today', { date: '2026-11-05' })).toMatchObject({ status: 'success', result: { date: '2026-11-05', tasks: [{ id: taskId }] } })
    expect(await call('listTasks', { projectId, includeCompleted: true, dueFrom: '2026-11-01', dueTo: '2026-11-30', assignee: 'agent' })).toMatchObject({ status: 'success' })
    expect(await call('updateTask', { id: taskId, expectedVersion: 1, title: 'Two', notes: '', projectId: null, dueDate: null, assignee: 'me', priority: 3, completed: true, noteIds: [] })).toMatchObject({ status: 'success' })
    expect(await call('updateTask', { id: taskId, expectedVersion: 1, title: 'stale' })).toMatchObject({ status: 'failed', error: { code: 'app.stale-version' } })
    expect(await call('updateTask', { id: 'missing', expectedVersion: 1 })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call('deleteTask', { id: taskId })).toMatchObject({ status: 'success' })
    expect(await call('deleteTask', { id: taskId })).toMatchObject({ status: 'success' })
    expect(await call('deleteTask', { id: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call('restoreTask', { id: taskId })).toMatchObject({ status: 'success' })
    expect(await call('restoreTask', { id: taskId })).toMatchObject({ status: 'success' })
    expect(await call('restoreTask', { id: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call('resolveNotes', { ids: ['n1'] })).toMatchObject({ status: 'success', result: { notes: [], unavailable: true } })
    expect(await call('searchNotes', { query: 'x' })).toMatchObject({ status: 'success', result: { notes: [], unavailable: true } })
    const reload = runtime.list().find(entry => entry.declaration.id === 'tasks')?.declaration.reload
    await reload?.({} as never)
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('tasks plugin mount', () => {
  it('fails loudly without the application store', async () => {
    const ctx = new Context()
    await expect(TasksPlugin.apply(ctx)).rejects.toThrow(/application store/u)
    await ctx.fiber.dispose()
  })
})

describe('tasks sorting and guarded updates', () => {
  it('sorts dated/undated tasks and refuses updates of deleted tasks or missing projects', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'tasks' }, capabilities: ['capability:storage'], grantedAt: at })
    await TasksPlugin.apply(ctx)
    await ready(runtime, 'tasks')
    const call = async (op: string, args: unknown) => await runtime.call({ kind: 'human' }, 'tasks', op, args as never)
    const first = await call('createTask', { title: 'undated' })
    const second = await call('createTask', { title: 'dated', dueDate: '2026-11-05' })
    const third = await call('createTask', { title: 'same', dueDate: '2026-11-05', priority: 3 })
    if (first.status !== 'success' || second.status !== 'success' || third.status !== 'success') throw new Error('create')
    const listed = await call('listTasks', { includeCompleted: true })
    if (listed.status !== 'success') throw new Error('list')
    expect((listed.result as Array<{ title: string }>).map(task => task.title)).toEqual(['dated', 'same', 'undated'])
    const deleted = await call('deleteTask', { id: (second.result as { id: string }).id })
    if (deleted.status !== 'success') throw new Error('delete')
    expect(await call('updateTask', { id: (second.result as { id: string }).id, expectedVersion: 1, title: 'x' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    expect(await call('updateTask', { id: (first.result as { id: string }).id, expectedVersion: 1, projectId: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('tasks project listing and update guards', () => {
  it('sorts multiple projects, reads a task and refuses an update with a missing project', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'tasks' }, capabilities: ['capability:storage'], grantedAt: at })
    await TasksPlugin.apply(ctx)
    await ready(runtime, 'tasks')
    const call = async (op: string, args: unknown) => await runtime.call({ kind: 'human' }, 'tasks', op, args as never)
    await call('createProject', { name: 'Zulu' })
    await call('createProject', { name: 'Alpha' })
    const projects = await call('listProjects', {})
    if (projects.status !== 'success') throw new Error('projects')
    expect((projects.result as Array<{ name: string }>).map(project => project.name)).toEqual(['Alpha', 'Zulu'])
    const task = await call('createTask', { title: 'one' })
    if (task.status !== 'success') throw new Error('task')
    const id = (task.result as { id: string }).id
    expect(await call('getTask', { id })).toMatchObject({ status: 'success', result: { title: 'one' } })
    expect(await call('updateTask', { id, expectedVersion: 1, projectId: 'missing' })).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('tasks branches', () => {
  it('sorts equal due/priority by creation, updates without a title and replays a create', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'tasks' }, capabilities: ['capability:storage'], grantedAt: at })
    await TasksPlugin.apply(ctx)
    await ready(runtime, 'tasks')
    const call = async (op: string, args: unknown) => await runtime.call({ kind: 'human' }, 'tasks', op, args as never)
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

describe('tasks completion and note search branches', () => {
  it('toggles completed both ways and searches notes when notes is mounted', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant({ caller: { kind: 'app', appId: 'notes' }, capabilities: ['capability:storage'], grantedAt: at })
    await runtime.grant({ caller: { kind: 'app', appId: 'tasks' }, capabilities: ['capability:storage', 'notes#searchNotes'], grantedAt: at })
    await NotesPlugin.apply(ctx)
    await ready(runtime, 'notes')
    await runtime.call({ kind: 'human' }, 'notes', 'create', { body: 'searchable note' })
    await TasksPlugin.apply(ctx)
    await ready(runtime, 'tasks')
    const call = async (op: string, args: unknown) => await runtime.call({ kind: 'human' }, 'tasks', op, args as never)
    const task = await call('createTask', { title: 'x' })
    if (task.status !== 'success') throw new Error('task')
    expect(await call('updateTask', { id: (task.result as { id: string }).id, expectedVersion: 1, completed: true })).toMatchObject({ status: 'success' })
    expect(await call('updateTask', { id: (task.result as { id: string }).id, expectedVersion: 2, completed: false })).toMatchObject({ status: 'success' })
    expect(await call('searchNotes', { query: 'searchable' })).toMatchObject({ status: 'success', result: [{ title: 'searchable note' }] })
    store.close()
    await ctx.fiber.dispose()
  })
})
