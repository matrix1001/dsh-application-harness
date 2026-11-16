/**
 * The durable task projection and the bridge's task surface: state-only
 * append, startup interruption, filtering, cancel, watch and persistence.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileTasks, TASK_FILE_LIMIT, TASK_WINDOW } from '../src/tasks.ts'
import { host } from './harness.ts'
import type { AppDeclaration } from '@matrix1001/dsh-application-harness-runtime/types'
import type { TaskSnapshot } from '../src/types.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'application-harness-tasks-'))
  dirs.push(dir)
  return dir
}

function snapshot(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: 'task-1', traceId: 'task-1', appId: 'demo', kind: 'scan', title: 'Scan', origin: { kind: 'background' },
    state: 'running', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function taskApp(): AppDeclaration {
  return {
    id: 'task-app',
    name: 'Task app',
    description: 'starts a hanging task',
    version: '1.0.0',
    ops: {
      start: {
        description: 'start', params: {}, result: { type: 'string' },
        execute: (_args, ctx) => ctx.startTask(
          { kind: 'scan', title: 'Scan', externalId: 'scan-1', requestId: 'req-1' },
          async (task) => {
            await new Promise<void>((_resolve, reject) => {
              task.signal.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
            })
            return 'done'
          },
        ).taskId,
      },
    },
  }
}

describe('FileTasks', () => {
  it('appends state changes only and answers the latest snapshot after a reload', async () => {
    const path = join(temp(), 'tasks.jsonl')
    const store = new FileTasks(path, () => {})
    store.record(snapshot())
    store.record(snapshot({ progress: { message: 'half', updatedAt: '2026-01-01T00:00:01.000Z' } }))
    store.record(snapshot({ state: 'succeeded', updatedAt: '2026-01-01T00:00:02.000Z', endedAt: '2026-01-01T00:00:02.000Z' }))
    await store.flush()
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
    const reloaded = new FileTasks(path, () => {})
    expect((await reloaded.list()).map(task => task.state)).toEqual(['succeeded'])
    expect((await reloaded.task('demo', 'task-1'))?.state).toBe('succeeded')
    expect(await reloaded.task('other', 'task-1')).toBeUndefined()
  })

  it('marks unfinished tasks interrupted on load and persists that state', async () => {
    const path = join(temp(), 'tasks.jsonl')
    const store = new FileTasks(path, () => {})
    store.record(snapshot())
    await store.flush()
    const reloaded = new FileTasks(path, () => {})
    const task = await reloaded.task('demo', 'task-1')
    expect(task).toMatchObject({ state: 'interrupted', taskId: 'task-1' })
    expect(task?.endedAt).toBeDefined()
    const third = new FileTasks(path, () => {})
    expect((await third.list())[0]?.state).toBe('interrupted')
  })

  it('skips malformed rows, reports once, and prunes the window', async () => {
    const path = join(temp(), 'tasks.jsonl')
    const problems: string[] = []
    writeFileSync(path, `${JSON.stringify(snapshot())}\nnot json\n${JSON.stringify({ taskId: 'bad' })}\n`)
    const store = new FileTasks(path, problem => { problems.push(problem) })
    expect(await store.list()).toHaveLength(1)
    expect(problems.join(' ')).toMatch(/malformed/u)
    expect(problems.join(' ')).toMatch(/malformed/u)
    const many = new FileTasks(join(temp(), 'many.jsonl'), () => {})
    for (let index = 0; index < TASK_WINDOW + 1; index += 1) {
      many.record(snapshot({
        taskId: `task-${String(index)}`,
        state: 'succeeded',
        startedAt: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        updatedAt: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      }))
    }
    await many.flush()
    expect((await many.list())).toHaveLength(TASK_WINDOW)
  })
})

describe('the bridge task surface', () => {
  it('lists live tasks, filters by app, cancels, and broadcasts task frames', async () => {
    const h = await host([taskApp()])
    try {
      const watch = h.bridge.watch()[Symbol.asyncIterator]()
      expect((await watch.next()).value).toMatchObject({ kind: 'ready' })
      const outcome = await h.runtime.call({ kind: 'human' }, 'task-app', 'start', {})
      const taskId = (outcome as { result: string }).result
      await vi.waitFor(async () => { expect((await h.bridge.tasks()).length).toBe(1) })
      const tasks = await h.bridge.tasks()
      expect(tasks[0]).toMatchObject({ taskId, appId: 'task-app', state: 'running', externalId: 'scan-1' })
      expect(await h.bridge.tasks('other')).toEqual([])
      const frame = await watch.next()
      expect(frame.value).toMatchObject({ kind: 'task', appId: 'task-app', task: { taskId } })
      expect(await h.bridge.cancelTask('task-app', taskId)).toBe('accepted')
      await vi.waitFor(async () => { expect((await h.bridge.tasks())[0]?.state).toBe('cancelled') })
      expect(await h.bridge.cancelTask('task-app', taskId)).toBe('settled')
      expect(await h.bridge.cancelTask('missing', 'missing')).toBe('not-found')
      await watch.return?.()
    } finally {
      await h.dispose()
    }
  })

  it('loads interrupted tasks from the durable projection and rejects their cancellation', async () => {
    const dir = temp()
    const tasksPath = join(dir, 'tasks.jsonl')
    writeFileSync(tasksPath, [
      JSON.stringify(snapshot({ taskId: 'old', state: 'running', startedAt: '2026-01-01T00:00:00.000Z' })),
      'not json',
      JSON.stringify(snapshot({ taskId: 'newer', state: 'succeeded', startedAt: '2026-01-01T00:00:02.000Z' })),
    ].join('\n') + '\n')
    const h = await host([], {}, { tasksPath })
    try {
      const tasks = await h.bridge.tasks()
      expect(tasks).toHaveLength(2)
      expect(tasks[0]).toMatchObject({ taskId: 'newer', state: 'succeeded' })
      expect(tasks[1]).toMatchObject({ taskId: 'old', state: 'interrupted' })
      expect(await h.bridge.tasks('demo')).toHaveLength(2)
      expect(await h.bridge.tasks('other')).toEqual([])
      expect(await h.bridge.cancelTask('demo', 'old')).toBe('settled')
      expect(await h.bridge.cancelTask('demo', 'missing')).toBe('not-found')
    } finally {
      await h.dispose()
    }
  })
})


describe('FileTasks edge handling', () => {
  it('validates every stored field and keeps the valid row', async () => {
    const path = join(temp(), 'tasks.jsonl')
    const valid = {
      taskId: 'valid', traceId: 'valid', appId: 'demo', kind: 'scan', title: 'Scan',
      origin: { kind: 'operation', callId: 'call-1', caller: { kind: 'ai', sessionId: 's1', turnId: 't1' } },
      state: 'succeeded', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:02.000Z',
      endedAt: '2026-01-01T00:00:02.000Z', externalId: 'record-1', requestId: 'request-1',
      progress: { message: 'half', data: { done: 1 }, updatedAt: '2026-01-01T00:00:01.000Z' },
      error: { code: 'x', message: 'y' }, resultSummary: { ok: true },
    }
    const rows: unknown[] = [
      null,
      [],
      { ...valid, taskId: '' },
      { ...valid, appId: '' },
      { ...valid, kind: 1 },
      { ...valid, title: 1 },
      { ...valid, startedAt: 1 },
      { ...valid, updatedAt: 1 },
      { ...valid, state: 'unknown' },
      { ...valid, origin: 'x' },
      { ...valid, origin: { kind: 'operation', callId: 'c', caller: { kind: 'weird' } } },
      { ...valid, origin: { kind: 'operation', callId: 'c', caller: { kind: 'app' } } },
      { ...valid, origin: { kind: 'operation', callId: 'c', caller: { kind: 'background', appId: 'a' } } },
      { ...valid, origin: { kind: 'operation', callId: 'c', caller: { kind: 'ai', sessionId: 's2' } } },
      { ...valid, origin: { kind: 'operation', caller: { kind: 'human' } } },
      { ...valid, origin: { kind: 'unknown' } },
      { ...valid, externalId: 1 },
      { ...valid, requestId: 1 },
      { ...valid, endedAt: 1 },
      { ...valid, progress: 1 },
      { ...valid, progress: { message: 'x' } },
      { ...valid, progress: { message: 'x', updatedAt: 1 } },
      { ...valid, progress: { message: 'x', updatedAt: 't', data: { a: 1 } } },
      { ...valid, error: 1 },
      { ...valid, error: { code: 'c' } },
      { ...valid, error: { code: 'c', message: 1 } },
      { ...valid, error: { code: 'c', message: 'm' } },
    ]
    const validVariants = [
      valid,
      { ...valid, taskId: 'no-data-progress', progress: { message: 'x', updatedAt: 't' } },
      { ...valid, taskId: 'human-caller', origin: { kind: 'operation', callId: 'c', caller: { kind: 'human' } } },
      { ...valid, taskId: 'ai-empty', origin: { kind: 'operation', callId: 'c', caller: { kind: 'ai' } } },
    ]
    writeFileSync(path, [
      ...rows.map(row => JSON.stringify(row)),
      ...validVariants.map(row => JSON.stringify(row)),
      JSON.stringify({ ...valid, taskId: 'invalid-caller', origin: { kind: 'operation', callId: 'c', caller: null } }),
      'not json',
    ].join('\n') + '\n')
    const problems: string[] = []
    const store = new FileTasks(path, problem => { problems.push(problem) })
    const list = await store.list()
    expect(list).toHaveLength(4)
    expect(list.find(task => task.taskId === 'valid')).toMatchObject({ state: 'succeeded', externalId: 'record-1', resultSummary: { ok: true } })
    expect(problems.join(' ')).toMatch(/malformed/u)
  })

  it('rotates a full file before appending a state change', async () => {
    const path = join(temp(), 'tasks.jsonl')
    writeFileSync(path, 'x'.repeat(TASK_FILE_LIMIT + 1))
    const problems: string[] = []
    const store = new FileTasks(path, problem => { problems.push(problem) })
    store.record(snapshot({ taskId: 'after-rotate' }))
    await store.flush()
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('after-rotate')
    expect(problems.length).toBeGreaterThan(0)
  })

  it('reports read and append failures without losing the in-memory task', async () => {
    const directory = temp()
    const problems: string[] = []
    const store = new FileTasks(directory, problem => { problems.push(problem) })
    store.record(snapshot())
    await store.flush()
    expect((await store.list()).map(task => task.taskId)).toEqual(['task-1'])
    expect(problems.join(' ')).toMatch(/cannot be read/u)
    expect(problems.join(' ')).toMatch(/cannot append/u)
  })

  it('prunes after the store is ready, not only while buffering', async () => {
    const store = new FileTasks(join(temp(), 'tasks.jsonl'), () => {})
    await store.ready
    for (let index = 0; index < TASK_WINDOW + 1; index += 1) {
      store.record(snapshot({
        taskId: `ready-${String(index)}`, state: 'succeeded',
        startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }))
    }
    await store.flush()
    expect(await store.list()).toHaveLength(TASK_WINDOW)
  })
})
