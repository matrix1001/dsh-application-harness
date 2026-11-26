/**
 * The background task protocol: identity, origin, idempotency, progress,
 * cancellation, failure and stop coordination. The task record is a
 * control-plane projection; the application's own record is not modeled here.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AppError, ApplicationRuntime, MAX_RUNNING_TASKS_PER_APP, MAX_TASK_RECORDS_PER_APP,
} from '../src/runtime.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  AppDeclaration, Caller, OperationContext, OperationDeclaration, TaskContext, TaskDescriptor, TaskSnapshot, TaskWork,
} from '../src/types.ts'

const asUser: Caller = { kind: 'human' }

function app(overrides: Partial<AppDeclaration> = {}): AppDeclaration {
  return {
    id: 'tasks',
    name: 'Tasks',
    description: 'task protocol probe',
    version: '1.0.0',
    ops: {},
    ...overrides,
  }
}

function startOp(
  work: TaskWork,
  descriptor: TaskDescriptor = { kind: 'scan', title: 'Scan' },
): OperationDeclaration {
  return {
    description: 'start one task and return its id',
    params: {},
    result: { type: 'string' },
    execute: (_args, ctx) => ctx.startTask(descriptor, async (task) => await work(task)).taskId,
  }
}

async function waitForState(runtime: ApplicationRuntime, appId: string, taskId: string, state: TaskSnapshot['state']): Promise<TaskSnapshot> {
  await vi.waitFor(() => {
    expect(runtime.task(appId, taskId)?.state).toBe(state)
  })
  return runtime.task(appId, taskId) as TaskSnapshot
}

describe('background tasks', () => {
  it('starts from an operation, reports latest progress, and settles with a bounded summary', async () => {
    const notices: TaskSnapshot[] = []
    const runtime = new ApplicationRuntime({ taskIdFactory: () => 'task-1' })
    runtime.onTask(notice => { notices.push(notice.task) })
    await runtime.register(app({ events: { refreshed: { description: 'refreshed' } }, ops: { start: startOp((task) => {
      task.reportProgress('halfway', { done: 1 })
      task.publishEvent('refreshed')
      return { done: true }
    }) } }))

    const outcome = await runtime.call(asUser, 'tasks', 'start', {})
    expect(outcome).toMatchObject({ status: 'success', result: 'task-1' })
    const task = await waitForState(runtime, 'tasks', 'task-1', 'succeeded')
    expect(task).toMatchObject({
      taskId: 'task-1', appId: 'tasks', kind: 'scan', title: 'Scan',
      origin: { kind: 'operation', callId: outcome.callId, caller: asUser },
      progress: { message: 'halfway', data: { done: 1 } },
      resultSummary: { done: true },
    })
    expect(notices.map(notice => notice.state)).toEqual(['running', 'running', 'succeeded'])
    expect(runtime.tasks('tasks')).toHaveLength(1)
    expect(runtime.tasks('other')).toEqual([])
  })

  it('records lifecycle/background origin and keeps the app-owned business id', async () => {
    const runtime = new ApplicationRuntime({ taskIdFactory: () => 'task-1' })
    let started: string | undefined
    await runtime.register(app({
      ops: {
        noop: {
          description: 'no-op', params: {}, result: { type: 'string' }, execute: () => 'ok',
        },
      },
      start: (ctx) => {
        started = ctx.startTask(
          { kind: 'refresh', title: 'Refresh', externalId: 'record-1', requestId: 'refresh-1' },
          async () => 'ok',
        ).taskId
      },
    }))
    await vi.waitFor(() => { expect(started).toBeDefined() })
    const task = await waitForState(runtime, 'tasks', 'task-1', 'succeeded')
    expect(task).toMatchObject({
      origin: { kind: 'background' }, externalId: 'record-1', requestId: 'refresh-1', resultSummary: 'ok',
    })
  })

  it('fails with a stable code and reports the controlled error, not the thrown payload', async () => {
    const runtime = new ApplicationRuntime({ taskIdFactory: () => 'task-1' })
    await runtime.register(app({ ops: { start: startOp(() => { throw new AppError('scan-failed', 'the scan failed') }) } }))
    const outcome = await runtime.call(asUser, 'tasks', 'start', {})
    const task = await waitForState(runtime, 'tasks', 'task-1', 'failed')
    expect(task.error).toEqual({ code: 'scan-failed', message: 'the scan failed' })
    expect(outcome.status).toBe('success')
  })

  it('maps a plain thrown error and a thrown string to the threw failure code', async () => {
    const runtime = new ApplicationRuntime({ taskIdFactory: () => 'task-1' })
    await runtime.register(app({ ops: {
      plain: startOp(() => { throw new Error('plain boom') }),
      raw: startOp(() => { throw 'raw boom' }),
    } }))
    await runtime.call(asUser, 'tasks', 'plain', {})
    await waitForState(runtime, 'tasks', 'task-1', 'failed')
    // A second runtime id avoids sharing the first record's id.
    const rawRuntime = new ApplicationRuntime({ taskIdFactory: () => 'task-2' })
    await rawRuntime.register(app({ ops: { raw: startOp(() => { throw 'raw boom' }) } }))
    await rawRuntime.call(asUser, 'tasks', 'raw', {})
    const rawTask = await waitForState(rawRuntime, 'tasks', 'task-2', 'failed')
    expect(rawTask.error).toEqual({ code: 'threw', message: 'raw boom' })
  })

  it('cancels cooperatively: cancelling first, then cancelled, and terminal cancels are settled', async () => {
    const runtime = new ApplicationRuntime({ taskIdFactory: () => 'task-1' })
    const states: string[] = []
    runtime.onTask(notice => { states.push(notice.task.state) })
    await runtime.register(app({ ops: { start: startOp(async (task) => {
      await new Promise<void>((_resolve, reject) => {
        task.signal.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
      })
    }) } }))
    await runtime.call(asUser, 'tasks', 'start', {})
    expect(runtime.cancelTask('tasks', 'task-1')).toBe('accepted')
    expect(runtime.task('tasks', 'task-1')?.state).toBe('cancelling')
    await waitForState(runtime, 'tasks', 'task-1', 'cancelled')
    expect(runtime.cancelTask('tasks', 'task-1')).toBe('settled')
    expect(runtime.cancelTask('tasks', 'missing')).toBe('not-found')
    expect(states).toContain('cancelling')
    expect(states.at(-1)).toBe('cancelled')
  })

  it('replays the same request id and refuses a different descriptor for it', async () => {
    const runtime = new ApplicationRuntime({ taskIdFactory: () => 'task-1' })
    let runs = 0
    const descriptor: TaskDescriptor = { kind: 'scan', title: 'Scan', requestId: 'request-1', externalId: 'scan-1' }
    await runtime.register(app({ ops: {
      start: startOp(() => { runs += 1; return 'ok' }, descriptor),
      conflicting: startOp(() => 'ok', { ...descriptor, title: 'Another title' }),
    } }))
    const first = await runtime.call(asUser, 'tasks', 'start', {})
    const second = await runtime.call(asUser, 'tasks', 'start', {})
    expect(first).toMatchObject({ status: 'success', result: 'task-1' })
    expect(second).toMatchObject({ status: 'success', result: 'task-1' })
    expect(runs).toBe(1)
    const conflict = await runtime.call(asUser, 'tasks', 'conflicting', {})
    expect(conflict).toMatchObject({ status: 'failed', error: { code: 'app.task-request-conflict' } })
  })

  it('bounds running tasks and rejects an invalid descriptor', async () => {
    let taskSerial = 0
    const runtime = new ApplicationRuntime({ taskIdFactory: () => `task-${String(++taskSerial)}` })
    let release: (() => void) | undefined
    const work = async (): Promise<void> => {
      await new Promise<void>((resolve) => { release = resolve })
    }
    await runtime.register(app({ ops: {
      start: startOp(work),
      invalid: startOp(() => 'ok', { kind: '', title: 'Scan' }),
    } }))
    for (let index = 0; index < MAX_RUNNING_TASKS_PER_APP; index += 1) {
      expect(await runtime.call(asUser, 'tasks', 'start', {})).toMatchObject({ status: 'success' })
    }
    const overflow = await runtime.call(asUser, 'tasks', 'start', {})
    expect(overflow).toMatchObject({ status: 'failed', error: { code: 'app.task-limit' } })
    const invalid = await runtime.call(asUser, 'tasks', 'invalid', {})
    expect(invalid).toMatchObject({ status: 'failed', error: { code: 'app.task-invalid' } })
    release?.()
  })

  it('ties tasks to the application stop: cancel, wait, and report the real state', async () => {
    const runtime = new ApplicationRuntime({ taskIdFactory: () => 'task-1', stopBudgetMs: 100 })
    let release: (() => void) | undefined
    await runtime.register(app({ ops: { start: startOp(async (task) => {
      await new Promise<void>((_resolve, reject) => {
        task.signal.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
        release = () => { _resolve() }
      })
    }) } }))
    await runtime.call(asUser, 'tasks', 'start', {})
    expect(runtime.cancelTask('tasks', 'task-1')).toBe('accepted')
    // The task's abort listener rejects promptly; the stop sees it settle.
    const status = await runtime.stop('tasks')
    expect(status).toBe('stopped')
    await waitForState(runtime, 'tasks', 'task-1', 'cancelled')
    release?.()
  })
})


describe('background task edges', () => {
  it('answers all-app queries, missing rows, default ids and an unsubscribed listener', async () => {
    const runtime = new ApplicationRuntime()
    const listener = vi.fn()
    const off = runtime.onTask(listener)
    off()
    await runtime.register(app({ ops: { start: startOp(() => 'ok') } }))
    const outcome = await runtime.call(asUser, 'tasks', 'start', {})
    expect(outcome.status).toBe('success')
    const taskId = (outcome as { result: string }).result
    expect(taskId).toMatch(/^task-/u)
    await waitForState(runtime, 'tasks', taskId, 'succeeded')
    expect(runtime.tasks()).toHaveLength(1)
    expect(runtime.task('tasks', 'missing')).toBeUndefined()
    expect(runtime.task('other', taskId)).toBeUndefined()
    expect(runtime.tasks('other')).toEqual([])
    expect(listener).not.toHaveBeenCalled()
  })

  it('accepts a second cancel while the first request is still cancelling', async () => {
    const runtime = new ApplicationRuntime({ taskIdFactory: () => 'task-1' })
    await runtime.register(app({ ops: { start: startOp(async (task) => {
      await new Promise<void>((_resolve, reject) => {
        task.signal.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
      })
    }) } }))
    await runtime.call(asUser, 'tasks', 'start', {})
    expect(runtime.cancelTask('tasks', 'task-1')).toBe('accepted')
    expect(runtime.cancelTask('tasks', 'task-1')).toBe('accepted')
    await waitForState(runtime, 'tasks', 'task-1', 'cancelled')
  })

  it('refuses a new task after stop and while an import hold is active', async () => {
    let captured: OperationContext | undefined
    const runtime = new ApplicationRuntime({ stopBudgetMs: 50 })
    await runtime.register(app({ ops: {
      capture: {
        description: 'capture the ctx', params: {}, result: { type: 'string' },
        execute: (_args, ctx) => { captured = ctx; return 'ok' },
      },
    } }))
    await runtime.call(asUser, 'tasks', 'capture', {})
    await runtime.stop('tasks')
    expect(() => captured!.startTask({ kind: 'late', title: 'Late' }, async () => {})).toThrow(/cannot start/u)

    let live: OperationContext | undefined
    const importing = new ApplicationRuntime({ stopBudgetMs: 50 })
    await importing.register(app({ ops: {
      capture: {
        description: 'capture the ctx', params: {}, result: { type: 'string' },
        execute: (_args, ctx) => { live = ctx; return 'ok' },
      },
    } }))
    await importing.call(asUser, 'tasks', 'capture', {})
    const lease = await importing.beginMaintenance('tasks')
    expect(() => live!.startTask({ kind: 'late', title: 'Late' }, async () => {})).toThrow(/paused for an import/u)
    await lease.release()
  })

  it('runs task calls as the application and delivers notifyChanged', async () => {
    const runtime = new ApplicationRuntime({ taskIdFactory: () => 'task-1' })
    const changes: string[] = []
    runtime.onChange(notice => { changes.push(notice.appId) })
    await runtime.register({
      id: 'target', name: 'Target', description: 'target', version: '1.0.0',
      ops: {
        echo: {
          description: 'echo', params: { text: { type: 'string', required: true } }, result: { type: 'string' },
          exposure: { peers: 'open' },
          execute: (args) => (args as { text: string }).text,
        },
      },
    })
    await runtime.register(app({
      calls: ['target'],
      ops: { start: startOp(async (task) => {
        task.notifyChanged()
        const outcome = await task.call('target', 'echo', { text: 'hello' })
        return { status: outcome.status, result: 'hello' }
      }) },
    }))
    await runtime.call(asUser, 'tasks', 'start', {})
    const task = await waitForState(runtime, 'tasks', 'task-1', 'succeeded')
    expect(task.resultSummary).toMatchObject({ status: 'success', result: 'hello' })
    expect(changes).toContain('tasks')
  })

  it('drops oversized/unserializable progress, ignores late progress, and omits an undefined summary', async () => {
    let captured: TaskContext | undefined
    let serial = 0
    const problems: string[] = []
    const runtime = new ApplicationRuntime({
      taskIdFactory: () => `task-${String(++serial)}`,
      onProblem: problem => { problems.push(problem) },
    })
    await runtime.register(app({ ops: {
      start: startOp((task) => {
        captured = task
        task.reportProgress('no data')
        task.reportProgress('big', 'x'.repeat(9000))
        const circular: Record<string, unknown> = {}
        circular.self = circular
        task.reportProgress('circular', circular as JsonValue)
        task.reportProgress('toJSON', { toJSON: () => { throw 'raw failure' } } as unknown as JsonValue)
        return 'ok'
      }),
      startVoid: startOp(() => undefined),
    } }))
    const outcome = await runtime.call(asUser, 'tasks', 'start', {})
    const first = (outcome as { result: string }).result
    await waitForState(runtime, 'tasks', first, 'succeeded')
    captured!.reportProgress('late')
    const task = runtime.task('tasks', first) as TaskSnapshot
    expect(task.progress?.message).toBe('toJSON')
    expect(task.progress?.data).toBeUndefined()
    expect(task.resultSummary).toBe('ok')
    expect(problems.join(' ')).toMatch(/exceeds/u)
    expect(problems.join(' ')).toMatch(/not serializable/u)
    expect(problems.join(' ')).toMatch(/raw failure/u)
    await runtime.call(asUser, 'tasks', 'startVoid', {})
  })

  it('reports a throwing task listener without changing the task', async () => {
    const problems: string[] = []
    const runtime = new ApplicationRuntime({ taskIdFactory: () => 'task-1', onProblem: problem => { problems.push(problem) } })
    runtime.onTask(() => { throw 'bad listener string' })
    await runtime.register(app({ ops: { start: startOp(() => 'ok') } }))
    await runtime.call(asUser, 'tasks', 'start', {})
    await waitForState(runtime, 'tasks', 'task-1', 'succeeded')
    expect(problems.join(' ')).toContain('task listener threw')
  })

  it('prunes the oldest settled task when the per-app record cap is reached', async () => {
    let serial = 0
    const runtime = new ApplicationRuntime({ taskIdFactory: () => `task-${String(++serial)}` })
    await runtime.register(app({ ops: { start: startOp(() => 'ok') } }))
    for (let index = 0; index < MAX_TASK_RECORDS_PER_APP + 1; index += 1) {
      const outcome = await runtime.call(asUser, 'tasks', 'start', {})
      await waitForState(runtime, 'tasks', (outcome as { result: string }).result, 'succeeded')
    }
    expect(runtime.tasks('tasks')).toHaveLength(MAX_TASK_RECORDS_PER_APP)
    expect(runtime.task('tasks', 'task-1')).toBeUndefined()
    expect(runtime.task('tasks', `task-${String(MAX_TASK_RECORDS_PER_APP + 1)}`)).toBeDefined()
  })

  it('validates every task descriptor field', async () => {
    const runtime = new ApplicationRuntime({ taskIdFactory: () => 'task-1' })
    await runtime.register(app({ ops: {
      start: {
        description: 'start', params: {}, result: { type: 'string' },
        execute: (args, ctx) => ctx.startTask(args as unknown as TaskDescriptor, async () => 'ok').taskId,
      },
    } }))
    const invalid: TaskDescriptor[] = [
      { kind: 'k', title: '' },
      { kind: 'k', title: 'x'.repeat(201) },
      { kind: 'k', title: 't', externalId: 'e'.repeat(201) },
      { kind: 'k', title: 't', requestId: 'r'.repeat(201) },
    ]
    for (const descriptor of invalid) {
      const outcome = await runtime.call(asUser, 'tasks', 'start', descriptor as unknown as JsonValue)
      expect(outcome).toMatchObject({ status: 'failed', error: { code: 'app.task-invalid' } })
    }
  })
})
