import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationRuntime } from '@matrix1001/dsh-application-harness-runtime'
import type { OperationContext } from '@matrix1001/dsh-application-harness-runtime'
import { AppStore } from '@matrix1001/dsh-application-harness-store'
import * as TasksPlugin from '../../tasks/src/index.ts'
import * as CalendarPlugin from '../src/index.ts'
import type { CalendarEvent, CalendarDocument, EventTime, TaskDeadlinesResult } from '../src/index.ts'

const at = '2026-01-01T00:00:00.000Z'

function host() {
  const ctx = new Context()
  const runtime = new ApplicationRuntime()
  const store = new AppStore(ctx)
  ctx.reflect.provide('applications', runtime)
  return { ctx, runtime, store }
}

function grant(appId: string, capabilities: string[]) {
  return { caller: { kind: 'app' as const, appId }, capabilities, grantedAt: at }
}

async function ready(runtime: ApplicationRuntime, id: string): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (runtime.list().find(entry => entry.declaration.id === id)?.status() === 'available') return
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  }
  throw new Error(`${id} did not become available`)
}

type Outcome = Awaited<ReturnType<ApplicationRuntime['call']>>

function valueOf<T>(outcome: Outcome): T {
  if (outcome.status !== 'success') throw new Error(`expected ok, received ${outcome.status}: ${'message' in outcome ? outcome.error?.message : ''}`)
  return outcome.result as T
}

const timed: EventTime = {
  kind: 'timed',
  start: '2026-11-05T01:00:00.000Z',
  end: '2026-11-05T02:00:00.000Z',
  timeZone: 'Asia/Shanghai',
}

const allDay: EventTime = { kind: 'allDay', startDate: '2026-11-07', endDateExclusive: '2026-11-09' }

async function mountCalendar(appId = 'calendar', capabilities = ['capability:storage']) {
  const environment = host()
  await environment.runtime.grant(grant(appId, capabilities))
  await CalendarPlugin.apply(environment.ctx)
  await ready(environment.runtime, 'calendar')
  return environment
}

describe('calendar application', () => {
  it('declares the unified document, storage capability and the tasks call', async () => {
    const { ctx, runtime, store } = await mountCalendar()
    const declaration = runtime.list().find(entry => entry.declaration.id === 'calendar')!.declaration
    expect(declaration).toMatchObject({
      id: 'calendar',
      generation: 2,
      data: { kind: 'unified', namespace: 'calendar', schemaVersion: 1 },
      capabilities: ['storage'],
      calls: [{ app: 'tasks', ops: ['listTasks'] }],
    })
    expect(declaration.ops.deleteEvent?.exposure).toEqual({ ai: 'closed', peers: 'open' })
    expect(declaration.ops.createEvent?.exposure).toEqual({ ai: 'confirm', peers: 'open' })
    await declaration.reload?.({} as never)
    expect(valueOf<{ events: CalendarEvent[] }>(await runtime.call({ kind: 'human' }, 'calendar', 'contextState', {}))).toEqual({ events: [] })
    store.close()
    await ctx.fiber.dispose()
  })

  it('creates, lists, reads, updates, soft-deletes, restores and rejects stale versions', async () => {
    const { ctx, runtime, store } = await mountCalendar()
    const created = valueOf<CalendarEvent>(await runtime.call({ kind: 'human' }, 'calendar', 'createEvent', {
      title: '  产品评审  ',
      description: '确认边界。',
      location: '  会议室 A  ',
      color: 'green',
      time: timed,
    }))
    expect(created).toMatchObject({
      title: '产品评审',
      description: '确认边界。',
      location: '会议室 A',
      color: 'green',
      version: 1,
      time: { kind: 'timed', start: '2026-11-05T01:00:00.000Z', end: '2026-11-05T02:00:00.000Z', timeZone: 'Asia/Shanghai' },
    })
    expect(valueOf<{ events: CalendarEvent[]; total: number }>(await runtime.call({ kind: 'human' }, 'calendar', 'listEvents', {
      fromDate: '2026-11-05', toDate: '2026-11-06', timeZone: 'Asia/Shanghai',
    }))).toMatchObject({ total: 1, events: [{ id: created.id }] })
    expect(valueOf<CalendarEvent>(await runtime.call({ kind: 'human' }, 'calendar', 'getEvent', { id: created.id }))).toMatchObject({ id: created.id })

    const partial = valueOf<CalendarEvent>(await runtime.call({ kind: 'human' }, 'calendar', 'updateEvent', {
      id: created.id, expectedVersion: 1, title: '产品评审（改）',
    }))
    expect(partial).toMatchObject({ title: '产品评审（改）', description: '确认边界。', color: 'green', version: 2 })
    const full = valueOf<CalendarEvent>(await runtime.call({ kind: 'human' }, 'calendar', 'updateEvent', {
      id: created.id,
      expectedVersion: 2,
      description: '新的描述',
      location: '会议室 B',
      color: 'amber',
      time: allDay,
    }))
    expect(full).toMatchObject({ description: '新的描述', location: '会议室 B', color: 'amber', version: 3, time: allDay })
    expect(await runtime.call({ kind: 'human' }, 'calendar', 'updateEvent', { id: created.id, expectedVersion: 2, title: 'again' }))
      .toMatchObject({ status: 'failed', error: { code: 'app.stale-version' } })

    const removed = valueOf<CalendarEvent>(await runtime.call({ kind: 'human' }, 'calendar', 'deleteEvent', { id: created.id }))
    expect(removed.deletedAt).toBeTypeOf('number')
    expect(valueOf<{ total: number }>(await runtime.call({ kind: 'human' }, 'calendar', 'listEvents', {
      fromDate: '2026-11-05', toDate: '2026-11-10', timeZone: 'Asia/Shanghai',
    }))).toMatchObject({ total: 0 })
    expect(valueOf<CalendarEvent>(await runtime.call({ kind: 'human' }, 'calendar', 'getEvent', { id: created.id }))).toMatchObject({ id: created.id, version: 4 })
    expect(valueOf<CalendarEvent>(await runtime.call({ kind: 'human' }, 'calendar', 'deleteEvent', { id: created.id }))).toMatchObject({ version: 4 })
    expect(await runtime.call({ kind: 'human' }, 'calendar', 'updateEvent', { id: created.id, expectedVersion: 4, title: 'no' }))
      .toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })

    const restored = valueOf<CalendarEvent>(await runtime.call({ kind: 'human' }, 'calendar', 'restoreEvent', { id: created.id }))
    expect(restored).toMatchObject({ id: created.id, version: 5 })
    expect(restored.deletedAt).toBeUndefined()
    expect(valueOf<CalendarEvent>(await runtime.call({ kind: 'human' }, 'calendar', 'restoreEvent', { id: created.id }))).toMatchObject({ version: 5 })
    expect(valueOf<{ total: number }>(await runtime.call({ kind: 'human' }, 'calendar', 'listEvents', {
      fromDate: '2026-11-07', toDate: '2026-11-10', timeZone: 'Asia/Shanghai',
    }))).toMatchObject({ total: 1 })

    for (const [op, args] of [
      ['updateEvent', { id: 'e_missing', expectedVersion: 1, title: 'no' }],
      ['deleteEvent', { id: 'e_missing' }],
      ['restoreEvent', { id: 'e_missing' }],
    ] as const) {
      expect(await runtime.call({ kind: 'human' }, 'calendar', op, args)).toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    }
    expect(await runtime.call({ kind: 'human' }, 'calendar', 'getEvent', { id: 'e_missing' }))
      .toMatchObject({ status: 'failed', error: { code: 'app.not-found' } })
    store.close()
    await ctx.fiber.dispose()
  })

  it('filters timed and all-day overlap across time zones and DST', async () => {
    const { ctx, runtime, store } = await mountCalendar()
    const create = async (title: string, time: EventTime, color = 'blue') => valueOf<CalendarEvent>(await runtime.call({ kind: 'human' }, 'calendar', 'createEvent', { title, time, color }))
    await create('all day', { kind: 'allDay', startDate: '2026-11-05', endDateExclusive: '2026-11-07' })
    await create('all day before', { kind: 'allDay', startDate: '2026-11-01', endDateExclusive: '2026-11-05' })
    await create('all day after', { kind: 'allDay', startDate: '2026-12-01', endDateExclusive: '2026-12-03' })
    await create('before shanghai day', { kind: 'timed', start: '2026-11-04T15:30:00.000Z', end: '2026-11-04T16:00:00.000Z', timeZone: 'Asia/Shanghai' })
    await create('shanghai morning', { kind: 'timed', start: '2026-11-04T16:30:00.000Z', end: '2026-11-05T01:00:00.000Z', timeZone: 'Asia/Shanghai' })
    await create('shanghai next midnight', { kind: 'timed', start: '2026-11-05T16:00:00.000Z', end: '2026-11-05T17:00:00.000Z', timeZone: 'Asia/Shanghai' })

    const shanghai = valueOf<{ events: CalendarEvent[]; total: number }>(await runtime.call({ kind: 'human' }, 'calendar', 'listEvents', {
      fromDate: '2026-11-05', toDate: '2026-11-06', timeZone: 'Asia/Shanghai',
    }))
    expect(shanghai.total).toBe(2)
    expect(shanghai.events.map(event => event.title)).toEqual(['all day', 'shanghai morning'])

    const utc = valueOf<{ events: CalendarEvent[]; total: number }>(await runtime.call({ kind: 'human' }, 'calendar', 'listEvents', {
      fromDate: '2026-11-05', toDate: '2026-11-06', timeZone: 'UTC',
    }))
    expect(utc.events.map(event => event.title)).toEqual(['all day', 'shanghai morning', 'shanghai next midnight'])

    await create('dst late', { kind: 'timed', start: '2026-03-09T03:30:00.000Z', end: '2026-03-09T04:00:00.000Z', timeZone: 'America/New_York' })
    await create('dst boundary', { kind: 'timed', start: '2026-03-09T04:00:00.000Z', end: '2026-03-09T04:30:00.000Z', timeZone: 'America/New_York' })
    const dst = valueOf<{ events: CalendarEvent[] }>(await runtime.call({ kind: 'human' }, 'calendar', 'listEvents', {
      fromDate: '2026-03-08', toDate: '2026-03-09', timeZone: 'America/New_York',
    }))
    expect(dst.events.map(event => event.title)).toEqual(['dst late'])

    for (const input of [
      { fromDate: '2026-11-06', toDate: '2026-11-05', timeZone: 'Asia/Shanghai' },
      { fromDate: '2026-11-05', toDate: '2026-11-06', timeZone: 'Mars/Olympus' },
      { fromDate: '2026-02-30', toDate: '2026-03-02', timeZone: 'UTC' },
      { fromDate: '05/11/2026', toDate: '2026-11-06', timeZone: 'UTC' },
    ]) {
      expect(await runtime.call({ kind: 'human' }, 'calendar', 'listEvents', input)).toMatchObject({ status: 'failed', error: { code: 'app.invalid-args' } })
    }
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('calendar repository validation', () => {
  function repository() {
    const ctx = new Context()
    const store = new AppStore(ctx)
    const repo = new CalendarPlugin.CalendarRepository(store.gatedNamespace('calendar'))
    repo.attach({ appId: 'calendar', use: async <T>(_name: string, work: () => T | Promise<T>) => work() })
    const operation = {
      notifyChanged: vi.fn(),
      call: vi.fn(async () => ({ callId: 'c', status: 'success' as const, value: [] })),
    } as unknown as OperationContext
    const cleanup = async () => { store.close(); await ctx.fiber.dispose() }
    return { repo, operation, cleanup }
  }

  it('rejects malformed fields, times, ranges and colors', async () => {
    const { repo, operation, cleanup } = repository()
    const invalid: Array<() => Promise<unknown>> = [
      () => repo.create({ title: 1 } as never, operation),
      () => repo.create({ title: '   ', time: timed } as never, operation),
      () => repo.create({ title: 'x'.repeat(201), time: timed } as never, operation),
      () => repo.create({ title: 't', description: 1, time: timed } as never, operation),
      () => repo.create({ title: 't', description: 'x'.repeat(10_001), time: timed } as never, operation),
      () => repo.create({ title: 't', location: 1, time: timed } as never, operation),
      () => repo.create({ title: 't', location: 'x'.repeat(201), time: timed } as never, operation),
      () => repo.create({ title: 't', color: 1, time: timed } as never, operation),
      () => repo.create({ title: 't', color: 'red', time: timed } as never, operation),
      () => repo.create({ title: 't', time: 1 } as never, operation),
      () => repo.create({ title: 't', time: null } as never, operation),
      () => repo.create({ title: 't', time: { kind: 'other' } } as never, operation),
      () => repo.create({ title: 't', time: { kind: 'timed', start: 1, end: 2, timeZone: 'UTC' } } as never, operation),
      () => repo.create({ title: 't', time: { kind: 'timed', start: '2026-11-05T01:00:00Z', end: '2026-11-05T02:00:00Z', timeZone: 1 } } as never, operation),
      () => repo.create({ title: 't', time: { kind: 'timed', start: 'not-an-instant', end: '2026-11-05T02:00:00Z', timeZone: 'UTC' } } as never, operation),
      () => repo.create({ title: 't', time: { kind: 'timed', start: '2026-13-05T01:00:00Z', end: '2026-11-05T02:00:00Z', timeZone: 'UTC' } } as never, operation),
      () => repo.create({ title: 't', time: { kind: 'timed', start: '2026-02-30T01:00:00Z', end: '2026-03-01T02:00:00Z', timeZone: 'UTC' } } as never, operation),
      () => repo.create({ title: 't', time: { kind: 'timed', start: '2026-11-05T02:00:00Z', end: '2026-11-05T01:00:00Z', timeZone: 'UTC' } } as never, operation),
      () => repo.create({ title: 't', time: { kind: 'allDay', startDate: 1, endDateExclusive: '2026-11-06' } } as never, operation),
      () => repo.create({ title: 't', time: { kind: 'allDay', startDate: '2026-11-05', endDateExclusive: '2026-11-05' } } as never, operation),
      () => repo.create({ title: 't', time: { kind: 'allDay', startDate: '2026-11-05', endDateExclusive: 'not-a-date' } } as never, operation),
      async () => repo.list({ fromDate: '2026-11-05', toDate: '2026-11-06', timeZone: '' }),
      async () => repo.list({ fromDate: '2026-11-05', toDate: '2026-11-06', timeZone: 'Not/AZone' }),
      async () => repo.list({ fromDate: '2026-11-06', toDate: '2026-11-06', timeZone: 'UTC' }),
      () => repo.listTaskDeadlines({ fromDate: '2026-11-06', toDate: '2026-11-05' }, operation),
      () => repo.listTaskDeadlines({ fromDate: 'nope', toDate: '2026-11-05' }, operation),
    ]
    for (const run of invalid) await expect(run()).rejects.toMatchObject({ code: 'invalid-args' })
    await cleanup()
  })

  it('defaults optional fields and persists through a second repository', async () => {
    const ctx = new Context()
    const store = new AppStore(ctx)
    const access = { appId: 'calendar', use: async <T>(_name: string, work: () => T | Promise<T>) => work() }
    const first = new CalendarPlugin.CalendarRepository(store.gatedNamespace('calendar'))
    first.attach(access)
    const operation = { notifyChanged: vi.fn(), call: vi.fn() } as unknown as OperationContext
    const created = await first.create({ title: 't', time: { kind: 'allDay', startDate: '2026-11-05', endDateExclusive: '2026-11-06' } }, operation)
    expect(created).toMatchObject({ description: '', location: '', color: 'blue', version: 1 })
    expect(created.time).toEqual({ kind: 'allDay', startDate: '2026-11-05', endDateExclusive: '2026-11-06' })

    const second = new CalendarPlugin.CalendarRepository(store.gatedNamespace('calendar'))
    second.attach(access)
    await second.ensureLoaded()
    expect(second.list({ fromDate: '2026-11-01', toDate: '2026-11-10', timeZone: 'UTC' })).toHaveLength(1)
    expect(operation.notifyChanged).toHaveBeenCalled()
    store.close()
    await ctx.fiber.dispose()
  })

  it('rejects a full document at the capacity limit', async () => {
    const ctx = new Context()
    const store = new AppStore(ctx)
    const namespace = store.gatedNamespace('calendar')
    const access = { appId: 'calendar', use: async <T>(_name: string, work: () => T | Promise<T>) => work() }
    namespace.attach(access)
    const events = Array.from({ length: 4000 }, (_, index) => ({
      id: `e_${String(index)}`, title: 't', description: '', location: '', color: 'blue' as const,
      time: { kind: 'allDay' as const, startDate: '2026-11-05', endDateExclusive: '2026-11-06' },
      createdAt: 1, updatedAt: 1, version: 1,
    }))
    await namespace.documents.put('document', { schemaVersion: 1, events } satisfies CalendarDocument)
    const repo = new CalendarPlugin.CalendarRepository(namespace)
    repo.attach(access)
    const operation = { notifyChanged: vi.fn(), call: vi.fn() } as unknown as OperationContext
    await expect(repo.create({ title: 'overflow', time: timed }, operation)).rejects.toMatchObject({ code: 'limit-reached' })
    store.close()
    await ctx.fiber.dispose()
  })

  it('reports corrupt documents and reloads a missing document as empty', async () => {
    const ctx = new Context()
    const store = new AppStore(ctx)
    const namespace = store.gatedNamespace('calendar')
    const access = { appId: 'calendar', use: async <T>(_name: string, work: () => T | Promise<T>) => work() }
    namespace.attach(access)
    const repo = new CalendarPlugin.CalendarRepository(namespace)
    repo.attach(access)
    await repo.ensureLoaded()
    expect(repo.list({ fromDate: '2026-11-01', toDate: '2026-11-02', timeZone: 'UTC' })).toEqual([])

    await namespace.documents.put('document', { schemaVersion: 2, events: [] } as never)
    await expect(repo.load()).rejects.toMatchObject({ code: 'storage-corrupt' })
    await namespace.documents.put('document', { schemaVersion: 1, events: 'nope' } as never)
    await expect(repo.load()).rejects.toMatchObject({ code: 'storage-corrupt' })
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('calendar task deadline overlay', () => {
  it('proxies live tasks through the declared peer call', async () => {
    const { ctx, runtime, store } = host()
    await runtime.grant(grant('tasks', ['capability:storage']))
    await runtime.grant(grant('calendar', ['capability:storage', 'tasks#listTasks']))
    await TasksPlugin.apply(ctx)
    await ready(runtime, 'tasks')
    await runtime.call({ kind: 'human' }, 'tasks', 'createTask', { title: 'due in range', dueDate: '2026-11-06', priority: 1 })
    await runtime.call({ kind: 'human' }, 'tasks', 'createTask', { title: 'out of range', dueDate: '2026-12-01', priority: 1 })
    await runtime.call({ kind: 'human' }, 'tasks', 'createTask', { title: 'no due date', priority: 1 })
    await CalendarPlugin.apply(ctx)
    await ready(runtime, 'calendar')
    expect(valueOf<TaskDeadlinesResult>(await runtime.call({ kind: 'human' }, 'calendar', 'listTaskDeadlines', {
      fromDate: '2026-11-05', toDate: '2026-11-07',
    }))).toEqual({ tasks: [{ id: expect.any(String), title: 'due in range', dueDate: '2026-11-06' }], available: true })
    store.close()
    await ctx.fiber.dispose()
  })

  it('degrades to an empty overlay when tasks is unavailable or refuses', async () => {
    const { ctx, runtime, store } = await mountCalendar()
    expect(valueOf<TaskDeadlinesResult>(await runtime.call({ kind: 'human' }, 'calendar', 'listTaskDeadlines', {
      fromDate: '2026-11-05', toDate: '2026-11-07',
    }))).toEqual({ tasks: [], available: false })

    const denied = await mountCalendar('calendar', ['capability:storage'])
    expect(valueOf<TaskDeadlinesResult>(await denied.runtime.call({ kind: 'human' }, 'calendar', 'listTaskDeadlines', {
      fromDate: '2026-11-05', toDate: '2026-11-07',
    }))).toEqual({ tasks: [], available: false })
    denied.store.close()
    await denied.ctx.fiber.dispose()
    store.close()
    await ctx.fiber.dispose()
  })

  it('maps malformed task rows, non-array results and peer errors to the overlay contract', async () => {
    const ctx = new Context()
    const store = new AppStore(ctx)
    const repo = new CalendarPlugin.CalendarRepository(store.gatedNamespace('calendar'))
    repo.attach({ appId: 'calendar', use: async <T>(_name: string, work: () => T | Promise<T>) => work() })
    const call = vi.fn()
    const operation = { notifyChanged: vi.fn(), call } as unknown as OperationContext

    call.mockResolvedValueOnce({ callId: 'c', status: 'rejected', error: { code: 'denied', message: 'no'  }})
    expect(await repo.listTaskDeadlines({ fromDate: '2026-11-05', toDate: '2026-11-05' }, operation)).toEqual({ tasks: [], available: false })

    call.mockResolvedValueOnce({ callId: 'c', status: 'success', result: { not: 'an array' } })
    expect(await repo.listTaskDeadlines({ fromDate: '2026-11-05', toDate: '2026-11-05' }, operation)).toEqual({ tasks: [], available: false })

    call.mockResolvedValueOnce({
      callId: 'c',
      status: 'success',
      result: [
        42,
        null,
        { id: 1, title: 'bad id', dueDate: '2026-11-05' },
        { id: 't2', title: 'bad due date', dueDate: null },
        { id: 't3', title: 'bad due', dueDate: 4 },
        { id: 't5', title: 5, dueDate: '2026-11-05' },
        { id: 't4', title: 'valid', dueDate: '2026-11-05', extra: true },
      ],
    })
    expect(await repo.listTaskDeadlines({ fromDate: '2026-11-05', toDate: '2026-11-05' }, operation)).toEqual({
      tasks: [{ id: 't4', title: 'valid', dueDate: '2026-11-05' }],
      available: true,
    })

    call.mockRejectedValueOnce(new Error('transport down'))
    expect(await repo.listTaskDeadlines({ fromDate: '2026-11-05', toDate: '2026-11-05' }, operation)).toEqual({ tasks: [], available: false })
    store.close()
    await ctx.fiber.dispose()
  })
})

describe('calendar plugin mount', () => {
  it('fails loudly without the application store', async () => {
    const ctx = new Context()
    await expect(CalendarPlugin.apply(ctx)).rejects.toThrow(/application store/u)
    await ctx.fiber.dispose()
  })
})
