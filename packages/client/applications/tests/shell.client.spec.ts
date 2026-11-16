/**
 * The applications shell: the list and its readiness, calls with their
 * in-flight bookkeeping and the runtime's own four-way outcome, the local
 * refusal of an unavailable application, cancellation, the watch fan
 * (changed / progress / confirmations), reconnect convergence, the three reads
 * and their writes, and the transport failures that must stay distinguishable
 * from business outcomes.
 *
 * The shell is Context-free, so every case here drives a plain Remote double:
 * the wire is the only thing faked, the state machine is the production one.
 */
import { describe, expect, it, vi } from 'vitest'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AppInfo, AppStatus, CallOutcome, Caller, CapabilityGrant, HistoryRecord, JsonValue, OnboardingState, PendingConfirmation,
  TaskSnapshot, WatchEvent,
} from '@matrix1001/dsh-application-harness-host-bridge/client'
import {
  ApplicationsShell, PROGRESS_LIMIT, describeError, type ApplicationsRemote,
} from '../src/client/shell.ts'

/** One successful Remote answer. */
function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** One carrier-level Remote failure (an outcome that never arrived). */
function carrierFailure(): RemoteResult<never> {
  return { ok: false, error: new RemoteError('gateway/internal', 'the carrier is gone', {}) }
}

/** One application row. */
function app(id: string, status: AppStatus = 'available'): AppInfo {
  return { id, name: `${id} title`, description: `${id} description`, version: '1.2.3', status, health: 'ok', activation: 'enabled', runtime: 'ready', needs: [], ops: [] }
}

/** One settled history record. */
function record(callId: string): HistoryRecord {
  return {
    callId,
    caller: { kind: 'human' },
    target: 'workbook',
    op: 'write',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    status: 'success',
  }
}

/** One pending confirmation. */
function confirmation(id: string): PendingConfirmation {
  return {
    id,
    caller: { kind: 'ai', sessionId: 'session-1' },
    capability: 'workbook#delete',
    reason: 'the agent wants to delete a task',
    at: '2026-01-01T00:00:02.000Z',
  }
}

/** One capability grant. */
function grant(caller: Caller): CapabilityGrant {
  return { caller, capabilities: ['workbook#write'], grantedAt: '2026-01-01T00:00:03.000Z' }
}

/**
 * One controllable watch stream: the spec pushes frames, ends the stream, or
 * makes it throw. The uplink members exist to satisfy the handle type; the
 * shell never sends.
 */
class FakeWatch {
  readonly frames: WatchEvent[] = []
  disposed = false
  private ended = false
  private failure: unknown
  private wake: (() => void) | undefined

  push(event: WatchEvent): void {
    this.frames.push(event)
    this.wakeUp()
  }

  end(): void {
    this.ended = true
    this.wakeUp()
  }

  fail(error: unknown): void {
    this.failure = error
    this.wakeUp()
  }

  dispose(): void {
    this.disposed = true
    this.end()
  }

  send(): void {}

  async *[Symbol.asyncIterator](): AsyncGenerator<WatchEvent> {
    while (true) {
      const next = this.frames.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.failure !== undefined) throw this.failure
      if (this.ended) return
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  private wakeUp(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/** The Remote double every case drives. */
function fakeRemote() {
  return {
    list: vi.fn(async () => ok<readonly AppInfo[]>([app('workbook'), app('disk-analysis', 'stopped')])),
    call: vi.fn(async (
      _appId: string, _op: string, _args: JsonValue, _requestId?: string,
    ): Promise<RemoteResult<CallOutcome>> => ok<CallOutcome>({ callId: 'runtime-1', status: 'success', result: { ok: true } })),
    cancel: vi.fn(async () => ok(true)),
    dataInfo: vi.fn(async (appId: string) => ok({ appId, path: '/tmp/app-data.sqlite', byteSize: 1, schemaVersion: 1, documentCount: 1, collections: {}, backups: [], backupCount: 0, legacyImports: {} })),
    dataExport: vi.fn(async () => ok({ fileName: 'app.json', json: '{}' })),
    dataImportPreview: vi.fn(async (appId: string) => ok({ appId, apps: 1, documents: 1, collections: 0, newDocuments: 1, overwrittenDocuments: 0, removedDocuments: 0, newCollectionItems: 0, overwrittenCollectionItems: 0, removedCollectionItems: 0 })),
    dataImport: vi.fn(async (appId: string) => ok({ appId, apps: 1, documents: 1, collections: 0, backupPath: '/tmp/backup.sqlite', reload: 'ok' as const })),
    dataReload: vi.fn(async () => ok(undefined)),
    dataPruneBackups: vi.fn(async () => ok({ removed: 2 })),
    history: vi.fn(async () => ok<readonly HistoryRecord[]>([record('call-1')])),
    tasks: vi.fn(async () => ok<readonly TaskSnapshot[]>([])),
    cancelTask: vi.fn(async () => ok('accepted' as const)),
    policies: vi.fn(async () => ok([])),
    setActivation: vi.fn(async () => ok([])),
    setAppModel: vi.fn(async () => ok(true)),
    modelCatalog: vi.fn(async () => ok({ providers: [] })),
    modelUsage: vi.fn(async () => ok({ calls: 0, succeeded: 0, failed: 0, cancelled: 0, usageMissing: 0, totalDurationMs: 0 })),
    modelLimits: vi.fn(async () => ok({ background: true })),
    setModelLimits: vi.fn(async () => ok(true)),
    credentials: vi.fn(async () => ok([{ name: 'token', set: true }])),
    setCredential: vi.fn(async () => ok(true)),
    deleteCredential: vi.fn(async () => ok(true)),
    resolveObject: vi.fn(async () => ok({ ref: { appId: 'objects', type: 'task', id: '1' }, title: 'Task 1' })),
    completePageCommand: vi.fn(async () => ok(true)),
    setPolicy: vi.fn(async () => ok([])),
    grants: vi.fn(async () => ok<readonly CapabilityGrant[]>([grant({ kind: 'human' })])),
    onboarding: vi.fn(async () => ok<OnboardingState>({ apps: {} })),
    markOnboardingSeen: vi.fn(async () => ok<OnboardingState>({ apps: {} })),
    pendingConfirmations: vi.fn(async () => ok<readonly PendingConfirmation[]>([confirmation('confirmation-1')])),
    answerConfirmation: vi.fn(async () => ok(true)),
    grant: vi.fn(async () => ok(undefined)),
    revoke: vi.fn(async () => ok(undefined)),
    watch: vi.fn(() => new FakeWatch()),
  }
}

type RemoteDouble = ReturnType<typeof fakeRemote>

/** Build one shell over a fresh double. */
function shellOf(remote: RemoteDouble): ApplicationsShell {
  return new ApplicationsShell(remote as unknown as ApplicationsRemote)
}

/** The FakeWatch a shell opened (the last one, for reconnect cases). */
function streamOf(remote: RemoteDouble, index = -1): FakeWatch {
  const results = remote.watch.mock.results
  const entry = index < 0 ? results.at(index) : results[index]
  return entry?.value as FakeWatch
}

/** Let the shell's asynchronous consumption run. */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** A promise plus its resolver, for observing a call while it is in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

const demoTask: TaskSnapshot = {
  taskId: 'task-1', traceId: 'task-1', appId: 'workbook', kind: 'scan', title: 'Scan', origin: { kind: 'background' },
  state: 'running', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('applications shell: start, list and watch', () => {
  it('reads task projections, applies live task frames and sends cancellation', async () => {
    const remote = fakeRemote()
    const second = { ...demoTask, taskId: 'task-2', startedAt: '2026-01-01T00:00:02.000Z' }
    remote.tasks.mockResolvedValueOnce(ok<readonly TaskSnapshot[]>([second, demoTask]))
    const shell = shellOf(remote)
    await shell.loadTasks()
    expect(shell.state.getSnapshot().tasks.map(task => task.taskId)).toEqual(['task-2', 'task-1'])
    expect(shell.state.getSnapshot().tasksLoaded).toBe(true)
    shell.start()
    await tick()
    const cancelled = { ...demoTask, state: 'cancelling' as const, updatedAt: '2026-01-01T00:00:01.000Z' }
    streamOf(remote).push({ kind: 'task', appId: 'workbook', task: cancelled })
    await tick()
    expect(shell.state.getSnapshot().tasks.find(task => task.taskId === 'task-1')?.state).toBe('cancelling')
    shell.cancelTask('workbook', 'task-1')
    await tick()
    expect(remote.cancelTask).toHaveBeenCalledWith('workbook', 'task-1')
    remote.cancelTask.mockResolvedValueOnce(carrierFailure())
    shell.cancelTask('workbook', 'task-1')
    await tick()
    expect(shell.state.getSnapshot().error).toBeDefined()
    remote.tasks.mockResolvedValueOnce(carrierFailure())
    await shell.loadTasks()
    expect(shell.state.getSnapshot().tasksFailed).toBe(true)
    // A live frame during a slower read invalidates that read.
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.tasks>>>()
    remote.tasks.mockReturnValueOnce(pending.promise)
    const loading = shell.loadTasks()
    const late = { ...demoTask, taskId: 'task-3', startedAt: '2026-01-01T00:00:03.000Z' }
    streamOf(remote).push({ kind: 'task', appId: 'workbook', task: late })
    await tick()
    pending.reject(new Error('carrier gone'))
    await loading
    expect(shell.state.getSnapshot().tasks[0]?.taskId).toBe('task-3')
    shell.dispose()
  })


  it('keeps unresolved permission failures when unrelated reads succeed', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    const refuse = (code: string) => remote.call.mockResolvedValueOnce(ok<CallOutcome>({
      callId: 'refused', status: 'failed', error: { code, message: 'permission failure' },
    }))
    refuse('app.capability-not-approved')
    await shell.call('workbook', 'listFilters', {})
    refuse('app.capability-undeclared')
    await shell.call('workbook', 'settings', {})
    await shell.call('workbook', 'list', {})
    expect(shell.state.getSnapshot().refusals.get('workbook')).toBe('capability-not-approved')
    refuse('app.capability-not-approved')
    await shell.call('workbook', 'listFilters', {})
    await shell.call('workbook', 'listFilters', {})
    expect(shell.state.getSnapshot().refusals.get('workbook')).toBe('capability-undeclared')
    await shell.call('workbook', 'settings', {})
    expect(shell.state.getSnapshot().refusals.size).toBe(0)
    shell.dispose()
  })

  it('does not let an old list overwrite a streamed lifecycle snapshot', async () => {
    const remote = fakeRemote()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.list>>>()
    remote.list.mockReturnValueOnce(pending.promise)
    const shell = shellOf(remote)
    shell.start()
    streamOf(remote).push({ kind: 'lifecycle', appId: 'workbook', apps: [app('workbook')] })
    await tick()
    pending.resolve(ok([{ ...app('workbook'), status: 'starting' }]))
    await tick()
    expect(shell.state.getSnapshot().apps?.[0]?.status).toBe('available')
    shell.dispose()
  })

  it('updates lifecycle rows and refreshes the application only when it becomes available', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    shell.start()
    await tick()
    const refresh = vi.fn()
    shell.onChanged('workbook', refresh)
    const stream = streamOf(remote)
    stream.push({ kind: 'lifecycle', appId: 'workbook', apps: [app('disk-analysis'), { ...app('workbook'), status: 'starting' }] })
    await tick()
    expect(shell.state.getSnapshot().apps?.[1]?.status).toBe('starting')
    expect(refresh).not.toHaveBeenCalled()
    stream.push({ kind: 'lifecycle', appId: 'workbook', apps: [app('workbook')] })
    await tick()
    expect(shell.state.getSnapshot().apps?.[0]?.status).toBe('available')
    expect(refresh).toHaveBeenCalledTimes(1)
    stream.push({ kind: 'lifecycle', appId: 'workbook', apps: [] })
    await tick()
    expect(shell.state.getSnapshot().apps).toEqual([])
    expect(refresh).toHaveBeenCalledTimes(1)
    shell.dispose()
  })

  it('reads the rows and opens one watch stream', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    const seen: number[] = []
    const off = shell.state.subscribe(() => { seen.push(shell.state.getSnapshot().running.size) })
    shell.start()
    expect(shell.state.getSnapshot().watching).toBe(true)
    expect(remote.watch).toHaveBeenCalledTimes(1)
    await tick()
    expect(remote.list).toHaveBeenCalledTimes(1)
    expect(shell.state.getSnapshot().apps?.map(row => row.id)).toEqual(['workbook', 'disk-analysis'])
    expect(seen.length).toBeGreaterThan(0)
    off()
    shell.dispose()
  })

  it('takes the watch ready frame as the list', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    shell.start()
    await tick()
    streamOf(remote).push({ kind: 'ready', apps: [app('info-hub')] })
    await tick()
    expect(shell.state.getSnapshot().apps?.map(row => row.id)).toEqual(['info-hub'])
    shell.dispose()
  })

  it('reports a list failure without throwing and keeps the rows unread', async () => {
    const remote = fakeRemote()
    remote.list.mockResolvedValue(carrierFailure())
    const shell = shellOf(remote)
    shell.start()
    await tick()
    expect(shell.state.getSnapshot().error).toBe('gateway/internal: the carrier is gone')
    expect(shell.state.getSnapshot().apps).toBeUndefined()
    shell.dispose()
  })

  it('fans changed frames to the app that changed only, and stops on unsubscribe', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    shell.start()
    await tick()
    const workbook = vi.fn()
    const disk = vi.fn()
    const offWorkbook = shell.onChanged('workbook', workbook)
    const offDisk = shell.onChanged('disk-analysis', disk)
    // A change for an application nobody listens to is a no-op, not a throw.
    streamOf(remote).push({ kind: 'changed', appId: 'info-hub' })
    await tick()
    expect(workbook).not.toHaveBeenCalled()
    streamOf(remote).push({ kind: 'changed', appId: 'workbook' })
    await tick()
    expect(workbook).toHaveBeenCalledTimes(1)
    expect(disk).not.toHaveBeenCalled()
    offWorkbook()
    streamOf(remote).push({ kind: 'changed', appId: 'workbook' })
    await tick()
    expect(workbook).toHaveBeenCalledTimes(1)
    offDisk()
    shell.dispose()
  })

  it('keeps progress notices newest first, bounded, and drops confirmations once settled', async () => {
    const remote = fakeRemote()
    // Nothing pending at start: the frames below are the only source here.
    remote.pendingConfirmations.mockResolvedValue(ok<readonly PendingConfirmation[]>([]))
    const shell = shellOf(remote)
    shell.start()
    await tick()
    const stream = streamOf(remote)
    for (let index = 0; index < PROGRESS_LIMIT + 1; index += 1) {
      stream.push({
        kind: 'progress',
        notice: { appId: 'workbook', op: 'write', callId: 'call-1', message: `step ${String(index)}` },
      })
    }
    await tick()
    const progress = shell.state.getSnapshot().progress
    expect(progress).toHaveLength(PROGRESS_LIMIT)
    expect(progress[0]?.message).toBe(`step ${String(PROGRESS_LIMIT)}`)
    stream.push({ kind: 'confirmation', action: 'asked', request: confirmation('confirmation-1') })
    stream.push({ kind: 'confirmation', action: 'asked', request: confirmation('confirmation-2') })
    await tick()
    expect(shell.state.getSnapshot().confirmations.map(item => item.id)).toEqual(['confirmation-1', 'confirmation-2'])
    stream.push({ kind: 'confirmation', action: 'settled', id: 'confirmation-1', outcome: 'allowed-once' })
    await tick()
    expect(shell.state.getSnapshot().confirmations.map(item => item.id)).toEqual(['confirmation-2'])
    shell.dispose()
  })

  it('marks the stream down when it ends or throws', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    shell.start()
    await tick()
    streamOf(remote).end()
    await tick()
    expect(shell.state.getSnapshot().watching).toBe(false)

    const failing = fakeRemote()
    const other = shellOf(failing)
    other.start()
    await tick()
    streamOf(failing).fail(new Error('socket closed'))
    await tick()
    expect(other.state.getSnapshot().watching).toBe(false)
    expect(other.state.getSnapshot().connectionError).toBe('socket closed')
    expect(other.state.getSnapshot().error).toBeUndefined()
    shell.dispose()
    other.dispose()
  })

  it('stops applying frames once disposed', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    shell.start()
    await tick()
    const stream = streamOf(remote)
    shell.dispose()
    expect(stream.disposed).toBe(true)
    stream.push({ kind: 'ready', apps: [app('info-hub')] })
    await tick()
    expect(shell.state.getSnapshot().apps?.map(row => row.id)).toEqual(['workbook', 'disk-analysis'])
  })
})

describe('applications shell: reconnect', () => {
  it('reopens the stream, re-reads the rows and lets every view re-read', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    shell.start()
    await tick()
    const first = streamOf(remote)
    const workbook = vi.fn()
    shell.onChanged('workbook', workbook)
    remote.list.mockResolvedValue(ok<readonly AppInfo[]>([app('workbook', 'failed')]))
    shell.reconnect()
    expect(first.disposed).toBe(true)
    expect(remote.watch).toHaveBeenCalledTimes(2)
    expect(shell.state.getSnapshot().watching).toBe(true)
    await tick()
    expect(remote.list).toHaveBeenCalledTimes(2)
    expect(shell.state.getSnapshot().apps?.[0]?.status).toBe('failed')
    expect(workbook).toHaveBeenCalledTimes(1)
    // A view that never registered a listener is not touched, and the old
    // generation's frames no longer reach anyone.
    first.push({ kind: 'changed', appId: 'workbook' })
    await tick()
    expect(workbook).toHaveBeenCalledTimes(1)
    shell.dispose()
  })

  it('re-syncs derived state on a reset frame without reopening the watch', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    shell.start()
    await tick()
    const stream = streamOf(remote)
    const workbook = vi.fn()
    shell.onChanged('workbook', workbook)
    const lists = remote.list.mock.calls.length
    const grants = remote.grants.mock.calls.length
    const confirmations = remote.pendingConfirmations.mock.calls.length
    stream.push({ kind: 'reset', reason: 'slow-consumer' })
    await tick()
    expect(remote.watch).toHaveBeenCalledTimes(1)
    expect(remote.list.mock.calls.length).toBe(lists + 1)
    expect(remote.grants.mock.calls.length).toBe(grants + 1)
    expect(remote.pendingConfirmations.mock.calls.length).toBe(confirmations + 1)
    expect(workbook).toHaveBeenCalledTimes(1)
    shell.dispose()
  })

  it('does nothing once disposed', () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    shell.start()
    shell.dispose()
    shell.reconnect()
    expect(remote.watch).toHaveBeenCalledTimes(1)
  })
})

describe('applications shell: calls', () => {
  it('calls an available application, records the outcome and clears the in-flight count', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    remote.call.mockResolvedValue(ok<CallOutcome>({ callId: 'runtime-7', status: 'success', result: 42 }))
    const outcome = await shell.call('workbook', 'write', { text: 'hello' }, 'request-7')
    expect(outcome).toEqual({ callId: 'runtime-7', status: 'success', result: 42 })
    expect(remote.call).toHaveBeenCalledWith('workbook', 'write', { text: 'hello' }, 'request-7')
    expect(shell.state.getSnapshot().outcomes.get('workbook')).toEqual(outcome)
    expect(shell.state.getSnapshot().running.size).toBe(0)
  })

  it('mints a requestId when the caller names none', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    await shell.call('workbook', 'write', {})
    const requestId = remote.call.mock.calls[0]?.[3]
    expect(typeof requestId).toBe('string')
    expect(requestId).toMatch(/^applications-[0-9a-f-]{36}$/)
  })

  it('exposes the in-flight state while a call runs', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    const gate = deferred()
    remote.call.mockImplementation(async () => {
      await gate.promise
      return ok<CallOutcome>({ callId: 'runtime-1', status: 'success', result: null })
    })
    const pending = shell.call('workbook', 'write', {})
    await tick()
    expect(shell.state.getSnapshot().running.get('workbook')).toBe(1)
    expect(shell.state.getSnapshot().runningCalls).toMatchObject([{ appId: 'workbook', op: 'write' }])
    expect(Number.isNaN(Date.parse(shell.state.getSnapshot().runningCalls[0]!.startedAt))).toBe(false)
    expect(shell.viewProps('workbook').running).toBe(true)
    gate.resolve()
    await pending
    expect(shell.state.getSnapshot().runningCalls).toEqual([])
    expect(shell.viewProps('workbook').running).toBe(false)
  })

  it('refuses an application the host does not run, without calling it', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    const outcome = await shell.call('ghost', 'write', {}, 'request-1')
    expect(outcome).toMatchObject({ callId: 'request-1', status: 'rejected', error: { code: 'platform.unknown-app' } })
    expect(remote.call).not.toHaveBeenCalled()
    expect(shell.state.getSnapshot().outcomes.get('ghost')).toEqual(outcome)
  })

  it('refuses an application that is not available, with the runtime code for its state', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    const stopped = await shell.call('disk-analysis', 'scan', {}, 'request-2')
    expect(stopped).toMatchObject({ status: 'rejected', error: { code: 'platform.unavailable' } })
    remote.list.mockResolvedValue(ok<readonly AppInfo[]>([app('disk-analysis', 'stopping')]))
    const stopping = await shell.call('disk-analysis', 'scan', {}, 'request-3')
    expect(stopping).toMatchObject({ status: 'rejected', error: { code: 'platform.stopping' } })
  })

  it('hands a rejected and a failed outcome back unchanged', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    remote.call.mockResolvedValue(ok<CallOutcome>({
      callId: 'runtime-1', status: 'rejected', error: { code: 'platform.denied', message: 'the user refused', }
    }))
    expect(await shell.call('workbook', 'write', {})).toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })
    remote.call.mockResolvedValue(ok<CallOutcome>({
      callId: 'runtime-2', status: 'failed', error: { code: 'app.disk_full', message: 'no space left', }
    }))
    expect(await shell.call('workbook', 'write', {})).toMatchObject({ status: 'failed', error: { code: 'app.disk_full' } })
    remote.call.mockResolvedValue(ok<CallOutcome>({ callId: 'runtime-3', status: 'cancelled' }))
    expect(await shell.call('workbook', 'write', {})).toMatchObject({ status: 'cancelled' })
  })

  it('rejects with the Remote error when no outcome arrived, clearing the in-flight count', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    remote.call.mockResolvedValue(carrierFailure())
    await expect(shell.call('workbook', 'write', {})).rejects.toThrow('the carrier is gone')
    expect(shell.state.getSnapshot().running.size).toBe(0)
    expect(shell.state.getSnapshot().outcomes.size).toBe(0)
  })

  it('rejects when the confirming list read itself fails', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    remote.list.mockResolvedValue(carrierFailure())
    await expect(shell.call('workbook', 'write', {})).rejects.toThrow('the carrier is gone')
    expect(remote.call).not.toHaveBeenCalled()
  })

  it('cancels by requestId, and records a failed cancellation on the error line', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    await expect(shell.cancel('request-9')).resolves.toBe(true)
    remote.cancel.mockResolvedValue(carrierFailure())
    await expect(shell.cancel('request-9')).rejects.toThrow('the carrier is gone')
    shell.requestCancel('request-9')
    await tick()
    expect(shell.state.getSnapshot().error).toBe('gateway/internal: the carrier is gone')
    expect(shell.viewProps('workbook').cancel).toBeTypeOf('function')
  })
})

describe('applications shell: history, grants and confirmations', () => {
  it('reads the three ledgers', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    await shell.loadHistory()
    await shell.loadGrants()
    await shell.loadConfirmations()
    expect(remote.history).toHaveBeenCalledWith(50, undefined)
    expect(shell.state.getSnapshot().history.map(item => item.callId)).toEqual(['call-1'])
    expect(shell.state.getSnapshot().grants).toHaveLength(1)
    expect(shell.state.getSnapshot().confirmations.map(item => item.id)).toEqual(['confirmation-1'])
  })

  it('asks for one application’s records — the filter rides the wire, never a client-side pass', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    await shell.loadHistory('workbook')
    expect(remote.history).toHaveBeenCalledWith(50, 'workbook')
    expect(shell.state.getSnapshot().history.map(item => item.callId)).toEqual(['call-1'])
  })

  it('drops a late history answer for a target the dialog already left', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    let resolveA: (value: Awaited<ReturnType<typeof remote.history>>) => void = () => {}
    remote.history.mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve }))
    const readingA = shell.loadHistory('slow-app')
    remote.history.mockResolvedValueOnce(ok<readonly HistoryRecord[]>([record('call-b')]))
    await shell.loadHistory('fast-app')
    resolveA(ok<readonly HistoryRecord[]>([record('call-a')]))
    await readingA
    // `fast-app` is the target that is still current; A's late answer is gone.
    expect(shell.state.getSnapshot().history.map(item => item.callId)).toEqual(['call-b'])
    expect(shell.state.getSnapshot().historyTarget).toBe('fast-app')
    expect(shell.state.getSnapshot().historyLoaded).toBe(true)
    expect(shell.state.getSnapshot().historyReading).toBe(false)
  })

  it('exposes reading/failed flags instead of turning a failed read into an empty ledger', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    remote.history.mockResolvedValue(carrierFailure())
    await shell.loadHistory('workbook')
    expect(shell.state.getSnapshot()).toMatchObject({
      historyTarget: 'workbook', historyLoaded: false, historyReading: false, historyFailed: true,
    })
    remote.grants.mockResolvedValue(carrierFailure())
    await shell.loadGrants()
    expect(shell.state.getSnapshot()).toMatchObject({ grantsLoaded: false, grantsReading: false, grantsFailed: true })
    remote.pendingConfirmations.mockResolvedValue(carrierFailure())
    await shell.loadConfirmations()
    expect(shell.state.getSnapshot()).toMatchObject({
      confirmationsLoaded: false, confirmationsReading: false, confirmationsFailed: true,
    })
  })

  it('ignores a late failure for a target the dialog already left', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    let rejectA: (error: unknown) => void = () => {}
    remote.history.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectA = reject }))
    const readingA = shell.loadHistory('slow-app')
    remote.history.mockResolvedValueOnce(ok<readonly HistoryRecord[]>([record('call-b')]))
    await shell.loadHistory('fast-app')
    rejectA(new Error('late carrier failure'))
    await readingA
    expect(shell.state.getSnapshot()).toMatchObject({
      historyTarget: 'fast-app', historyLoaded: true, historyFailed: false, error: undefined,
    })
    expect(shell.state.getSnapshot().history.map(item => item.callId)).toEqual(['call-b'])
  })

  it('records a failed read on the error line, and a later successful read refreshes the data without clearing it', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    remote.history.mockResolvedValue(carrierFailure())
    await shell.loadHistory()
    expect(shell.state.getSnapshot().error).toBe('gateway/internal: the carrier is gone')
    expect(shell.state.getSnapshot().history).toHaveLength(0)
    remote.history.mockResolvedValue(ok<readonly HistoryRecord[]>([record('call-2')]))
    await shell.loadHistory()
    // The data lands; the failure stays visible until a command really succeeds
    // (a read that worked says nothing about the action that did not).
    expect(shell.state.getSnapshot().history.map(item => item.callId)).toEqual(['call-2'])
    expect(shell.state.getSnapshot().error).toBe('gateway/internal: the carrier is gone')
    await shell.revoke({ kind: 'app', appId: 'git-read' }, 'workbook#write')
    expect(shell.state.getSnapshot().error).toBeUndefined()
  })

  it('shows a grant the host refused, and keeps it visible through later reads', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    const caller: Caller = { kind: 'app', appId: 'workbook' }
    // A Remote failure may arrive as `ok: false` instead of a rejection: the
    // approval did not happen, and the panel must say so.
    remote.grant.mockResolvedValue(carrierFailure())
    await shell.grant(caller, ['capability:storage'])
    expect(remote.grant).toHaveBeenCalledWith(caller, ['capability:storage'])
    expect(shell.state.getSnapshot().error).toBe('gateway/internal: the carrier is gone')
    // No re-read happened, so no stale "approved" state was shown either.
    expect(remote.grants).not.toHaveBeenCalled()
    await shell.loadGrants()
    expect(shell.state.getSnapshot().error).toBe('gateway/internal: the carrier is gone')
    // The retry that really saves is the one that clears the line.
    remote.grant.mockResolvedValue(ok(undefined))
    await shell.grant(caller, ['capability:storage'])
    expect(remote.grants).toHaveBeenCalledTimes(2)
    expect(shell.state.getSnapshot().error).toBeUndefined()
  })

  it('answers every command with whether it really took effect', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    const caller: Caller = { kind: 'app', appId: 'workbook' }
    // The row that asked owns its own pending/error state, so each command's
    // answer says whether the write landed — the error line alone cannot say
    // WHICH row finished.
    await expect(shell.grant(caller, ['capability:storage'])).resolves.toBe(true)
    remote.grant.mockResolvedValue(carrierFailure())
    await expect(shell.grant(caller, ['capability:storage'])).resolves.toBe(false)
    remote.grant.mockRejectedValue(new Error('the carrier is gone'))
    await expect(shell.grant(caller, ['capability:storage'])).resolves.toBe(false)
    await expect(shell.revoke(caller, 'capability:storage')).resolves.toBe(true)
    remote.revoke.mockResolvedValue(carrierFailure())
    await expect(shell.revoke(caller, 'capability:storage')).resolves.toBe(false)
    await expect(shell.answer('confirmation-1', 'allowed-once')).resolves.toBe(true)
    remote.answerConfirmation.mockResolvedValue(carrierFailure())
    await expect(shell.answer('confirmation-1', 'denied')).resolves.toBe(false)
  })

  it('drops a call’s progress notices when the call settles', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    shell.start()
    await tick()
    const gate = deferred()
    remote.call.mockImplementation(async () => {
      await gate.promise
      return ok<CallOutcome>({ callId: 'runtime-1', status: 'success', result: null })
    })
    const pending = shell.call('workbook', 'write', {}, 'request-9')
    await tick()
    streamOf(remote).push({ kind: 'progress', notice: { appId: 'workbook', op: 'write', callId: 'request-9', message: 'scanning' } })
    await tick()
    expect(shell.state.getSnapshot().progress.map(notice => notice.message)).toEqual(['scanning'])
    gate.resolve()
    await pending
    // Nothing is still running: a settled call's notices are history, and a
    // standing list of them would present finished work as in flight.
    expect(shell.state.getSnapshot().progress).toHaveLength(0)
    shell.dispose()
  })

  it('shows a re-read that failed after the command landed, without inventing the state it could not read', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    const caller: Caller = { kind: 'app', appId: 'workbook' }
    // The approval itself was saved (the host answered ok); the read that shows
    // the grants never arrived. The panel says THAT, and keeps the grants it
    // last really saw instead of presenting an empty table as the new truth.
    remote.grants.mockResolvedValue(carrierFailure())
    await shell.grant(caller, ['capability:storage'])
    expect(shell.state.getSnapshot().error).toBe('gateway/internal: the carrier is gone')
    expect(shell.state.getSnapshot().grants).toHaveLength(0)
    remote.grants.mockResolvedValue(ok<readonly CapabilityGrant[]>([grant(caller)]))
    await shell.loadGrants()
    expect(shell.state.getSnapshot().grants).toHaveLength(1)
  })

  it('shows a rejected grant and a refused revoke, and a refused answer', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    const caller: Caller = { kind: 'app', appId: 'workbook' }
    remote.grant.mockRejectedValue(new Error('the carrier is gone'))
    await shell.grant(caller, ['capability:storage'])
    expect(shell.state.getSnapshot().error).toBe('the carrier is gone')
    remote.grant.mockResolvedValue(ok(undefined))
    await shell.revoke(caller, 'capability:storage')
    remote.revoke.mockResolvedValue(carrierFailure())
    await shell.revoke(caller, 'capability:storage')
    expect(shell.state.getSnapshot().error).toBe('gateway/internal: the carrier is gone')
    // The same rule for the confirmation answer: a refused answer is reported,
    // never read away by the pending list that follows it.
    remote.answerConfirmation.mockResolvedValue(carrierFailure())
    await shell.answer('confirmation-1', 'allowed-once')
    expect(shell.state.getSnapshot().error).toBe('gateway/internal: the carrier is gone')
    expect(remote.pendingConfirmations).not.toHaveBeenCalled()
  })

  it('revokes then re-reads the grants', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    const caller: Caller = { kind: 'app', appId: 'git-read' }
    await shell.revoke(caller, 'workbook#write')
    expect(remote.revoke).toHaveBeenCalledWith(caller, 'workbook#write')
    expect(remote.grants).toHaveBeenCalledTimes(1)
    expect(shell.state.getSnapshot().grants).toHaveLength(1)
    await shell.revoke(caller)
    expect(remote.revoke).toHaveBeenLastCalledWith(caller, undefined)
  })

  it('answers a confirmation then re-reads the pending list', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    remote.pendingConfirmations.mockResolvedValue(ok<readonly PendingConfirmation[]>([]))
    await shell.answer('confirmation-1', 'allowed-once')
    expect(remote.answerConfirmation).toHaveBeenCalledWith('confirmation-1', 'allowed-once')
    expect(shell.state.getSnapshot().confirmations).toEqual([])
  })
})

describe('applications shell: selection and view props', () => {
  it('selects the active application', () => {
    const shell = shellOf(fakeRemote())
    shell.select('workbook')
    expect(shell.state.getSnapshot().activeAppId).toBe('workbook')
  })

  it('hands the same function identities back on every call, and drops them with the shell', () => {
    const shell = shellOf(fakeRemote())
    const first = shell.viewProps('workbook')
    const second = shell.viewProps('workbook')
    // The props OBJECT is rebuilt (its `running` is a snapshot fact), but the
    // four functions are one per application: a view may key an effect on them
    // and read once per mount instead of once per repaint.
    expect(second).not.toBe(first)
    expect(second.call).toBe(first.call)
    expect(second.cancel).toBe(first.cancel)
    expect(second.onChanged).toBe(first.onChanged)
    expect(second.claimProgress).toBe(first.claimProgress)
    expect(shell.viewProps('disk-analysis').call).not.toBe(first.call)
    shell.dispose()
    expect(shell.viewProps('workbook').call).not.toBe(first.call)
  })

  it('builds view props that call, cancel and subscribe for that application', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    const props = shell.viewProps('workbook')
    expect(props.running).toBe(false)
    await props.call('write', { text: 'hi' }, 'request-4')
    expect(remote.call).toHaveBeenCalledWith('workbook', 'write', { text: 'hi' }, 'request-4')
    const listener = vi.fn()
    const off = props.onChanged(listener)
    shell.onChanged('workbook', vi.fn())
    shell.reconnect()
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    props.cancel('request-4')
    await tick()
    expect(remote.cancel).toHaveBeenCalledWith('request-4')
  })
})

describe('applications shell: progress take-over', () => {
  it('claims one call’s row for the application that made it, and hands it back on release', () => {
    const shell = shellOf(fakeRemote())
    const release = shell.viewProps('workbook').claimProgress('request-9')
    expect([...(shell.state.getSnapshot().claims.get('workbook') ?? [])]).toEqual(['request-9'])
    // The claim is the APPLICATION’s: no other application is named by it.
    expect(shell.state.getSnapshot().claims.has('disk-analysis')).toBe(false)
    release()
    expect(shell.state.getSnapshot().claims.size).toBe(0)
    // Idempotent: a page that cleaned up twice changes nothing the second time.
    release()
    expect(shell.state.getSnapshot().claims.size).toBe(0)
    shell.dispose()
  })

  it('keeps every application’s claims apart, and drops them a page at a time', () => {
    const shell = shellOf(fakeRemote())
    // Two applications may legitimately use the same call id (ids are per
    // application), so a claim is namespaced by the application that made it.
    const workbook = shell.viewProps('workbook').claimProgress('call-1')
    shell.viewProps('disk-analysis').claimProgress('call-1')
    expect([...(shell.state.getSnapshot().claims.get('workbook') ?? [])]).toEqual(['call-1'])
    expect([...(shell.state.getSnapshot().claims.get('disk-analysis') ?? [])]).toEqual(['call-1'])
    shell.releaseClaims('workbook')
    expect(shell.state.getSnapshot().claims.has('workbook')).toBe(false)
    expect([...(shell.state.getSnapshot().claims.get('disk-analysis') ?? [])]).toEqual(['call-1'])
    // The late release of a dropped claim reaches nothing — the other
    // application’s take-over is not its to undo.
    workbook()
    expect([...(shell.state.getSnapshot().claims.get('disk-analysis') ?? [])]).toEqual(['call-1'])
    shell.releaseClaims('disk-analysis')
    expect(shell.state.getSnapshot().claims.size).toBe(0)
    shell.dispose()
  })

  it('drops only the claim it names, and releases nothing for an application that holds none', () => {
    const shell = shellOf(fakeRemote())
    const first = shell.viewProps('workbook').claimProgress('call-1')
    shell.viewProps('workbook').claimProgress('call-2')
    first()
    // The other call of the same application is still taken over.
    expect([...(shell.state.getSnapshot().claims.get('workbook') ?? [])]).toEqual(['call-2'])
    // An application nobody claimed under is not a release the shell owes.
    shell.releaseClaims('disk-analysis')
    expect([...(shell.state.getSnapshot().claims.get('workbook') ?? [])]).toEqual(['call-2'])
    shell.dispose()
  })

  it('keeps the raw notice: a take-over changes what the surface draws, not what the shell holds', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    shell.start()
    await tick()
    streamOf(remote).push({
      kind: 'progress',
      notice: { appId: 'workbook', op: 'write', callId: 'request-9', message: 'scanning' },
    })
    await tick()
    const release = shell.viewProps('workbook').claimProgress('request-9')
    expect(shell.state.getSnapshot().progress.map(notice => notice.callId)).toEqual(['request-9'])
    expect([...(shell.state.getSnapshot().claims.get('workbook') ?? [])]).toEqual(['request-9'])
    release()
    shell.dispose()
  })

  it('drops a claim when the call settles, and a late release cannot touch a newer claim', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    remote.call.mockResolvedValue(ok<CallOutcome>({ callId: 'runtime-1', status: 'success', result: null }))
    const first = shell.viewProps('workbook').claimProgress('request-9')
    await shell.call('workbook', 'write', {}, 'request-9')
    // The call is over: its take-over dies with it, so nothing lingers for the
    // next call that reuses the id.
    expect(shell.state.getSnapshot().claims.size).toBe(0)
    const second = shell.viewProps('workbook').claimProgress('request-9')
    // The late release belongs to the finished call, not to this one.
    first()
    expect([...(shell.state.getSnapshot().claims.get('workbook') ?? [])]).toEqual(['request-9'])
    second()
    expect(shell.state.getSnapshot().claims.size).toBe(0)
    shell.dispose()
  })

  it('drops a claim however the call ends — a local refusal, a failed confirming read', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    const refused = shell.viewProps('ghost').claimProgress('request-1')
    await shell.call('ghost', 'write', {}, 'request-1')
    expect(shell.state.getSnapshot().claims.size).toBe(0)
    // …including the ending that never got to begin: the read that confirms the
    // application failed, so the call rejected before it started.
    remote.list.mockResolvedValue(carrierFailure())
    const unbegun = shell.viewProps('workbook').claimProgress('request-2')
    await expect(shell.call('workbook', 'write', {}, 'request-2')).rejects.toThrow('the carrier is gone')
    expect(shell.state.getSnapshot().claims.size).toBe(0)
    // The late releases of both are no-ops.
    refused()
    unbegun()
    expect(shell.state.getSnapshot().claims.size).toBe(0)
    shell.dispose()
  })
})

describe('describeError', () => {
  it('prints a code and message when the failure carries a code', () => {
    expect(describeError(new RemoteError('gateway/bad-request', 'nope', {}))).toBe('gateway/bad-request: nope')
  })

  it('falls back to the message, then to the string form', () => {
    expect(describeError(new Error('plain'))).toBe('plain')
    expect(describeError('a thrown string')).toBe('a thrown string')
    expect(describeError({ message: 42 })).toBe('[object Object]')
  })
})


describe('application data reads', () => {
  it('returns the data face and turns a Remote failure into a rejection', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    await expect(shell.dataInfo('workbook')).resolves.toMatchObject({ appId: 'workbook', path: '/tmp/app-data.sqlite' })
    await expect(shell.dataExport('workbook')).resolves.toMatchObject({ fileName: 'app.json' })
    remote.dataInfo.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'data down', {}) })
    await expect(shell.dataInfo('workbook')).rejects.toThrow('data down')
    await expect(shell.previewDataImport('workbook', '{}')).resolves.toMatchObject({ documents: 1 })
    await expect(shell.importData('workbook', '{}')).resolves.toMatchObject({ backupPath: '/tmp/backup.sqlite' })
    remote.dataImport.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'import down', {}) })
    await expect(shell.importData('workbook', '{}')).rejects.toThrow('import down')
    await expect(shell.dataReload('workbook')).resolves.toBeUndefined()
    remote.dataReload.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'reload down', {}) })
    await expect(shell.dataReload('workbook')).rejects.toThrow('reload down')
    await expect(shell.pruneBackups(5)).resolves.toMatchObject({ removed: 2 })
    remote.dataPruneBackups.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'prune down', {}) })
    await expect(shell.pruneBackups(5)).rejects.toThrow('prune down')
  })
})

describe('operation policies', () => {
  it('reads the policy table and reports a failed read without inventing an empty state', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    remote.policies.mockResolvedValueOnce(carrierFailure())
    await shell.loadPolicies()
    expect(shell.state.getSnapshot()).toMatchObject({ policiesFailed: true, policiesLoaded: false, policiesReading: false })
    expect(shell.state.getSnapshot().error).toBe('gateway/internal: the carrier is gone')
    await shell.loadPolicies()
    expect(shell.state.getSnapshot()).toMatchObject({ policiesFailed: false, policiesLoaded: true, policiesReading: false })
  })

  it('checks a policy save before showing it, and re-reads only after success', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    remote.setPolicy.mockResolvedValueOnce(carrierFailure())
    expect(await shell.setPolicy('workbook', 'write', 'allow')).toBe(false)
    expect(remote.setPolicy).toHaveBeenCalledWith('workbook', 'write', 'allow')
    expect(remote.policies).not.toHaveBeenCalled()
    expect(shell.state.getSnapshot().error).toBe('gateway/internal: the carrier is gone')

    remote.setPolicy.mockResolvedValue(ok([]))
    expect(await shell.setPolicy('workbook', 'write', 'allow')).toBe(true)
    expect(remote.policies).toHaveBeenCalledTimes(1)
    expect(shell.state.getSnapshot()).toMatchObject({ policies: [], policiesLoaded: true })
    expect(shell.state.getSnapshot().error).toBeUndefined()
  })
})

describe('model selection command', () => {
  it('reports the remote answer and fails closed on transport errors', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    remote.setAppModel.mockRejectedValueOnce(new Error('offline'))
    expect(await shell.setAppModel('workbook', { provider: 'p', model: 'm' })).toBe(false)
    remote.setAppModel.mockResolvedValueOnce(ok(false))
    expect(await shell.setAppModel('workbook', null)).toBe(false)
    remote.setAppModel.mockResolvedValueOnce(ok(true))
    expect(await shell.setAppModel('workbook', { provider: 'p', model: 'm' })).toBe(true)
    expect(remote.setAppModel).toHaveBeenCalledWith('workbook', { provider: 'p', model: 'm' })
    expect(await shell.modelCatalog()).toEqual({ providers: [] })
    remote.modelCatalog.mockRejectedValueOnce(new Error('offline'))
    await expect(shell.modelCatalog()).rejects.toThrow(/offline/u)
    remote.modelCatalog.mockResolvedValueOnce(carrierFailure())
    await expect(shell.modelCatalog()).rejects.toBeDefined()
    expect(await shell.modelUsage('workbook')).toMatchObject({ calls: 0 })
    remote.modelUsage.mockRejectedValueOnce(new Error('offline'))
    await expect(shell.modelUsage('workbook')).rejects.toThrow(/offline/u)
    remote.modelUsage.mockResolvedValueOnce(carrierFailure())
    await expect(shell.modelUsage('workbook')).rejects.toBeDefined()
    expect(await shell.modelLimits('workbook')).toEqual({ background: true })
    remote.modelLimits.mockResolvedValueOnce(carrierFailure())
    await expect(shell.modelLimits('workbook')).rejects.toBeDefined()
    expect(await shell.setModelLimits('workbook', { background: false, maxConcurrent: 2 })).toBe(true)
    remote.setModelLimits.mockResolvedValueOnce(ok(false))
    expect(await shell.setModelLimits('workbook', { background: true })).toBe(false)
    remote.setModelLimits.mockRejectedValueOnce(new Error('offline'))
    expect(await shell.setModelLimits('workbook', { background: true })).toBe(false)
    expect(await shell.credentials('workbook')).toEqual([{ name: 'token', set: true }])
    expect(await shell.setCredential('workbook', 'token', 'x')).toBe(true)
    expect(await shell.deleteCredential('workbook', 'token')).toBe(true)
    remote.credentials.mockRejectedValueOnce(new Error('offline'))
    await expect(shell.credentials('workbook')).rejects.toThrow(/offline/u)
    remote.credentials.mockResolvedValueOnce(carrierFailure())
    await expect(shell.credentials('workbook')).rejects.toBeDefined()
    remote.setCredential.mockResolvedValueOnce(ok(false))
    expect(await shell.setCredential('workbook', 'token', 'x')).toBe(false)
    remote.setCredential.mockRejectedValueOnce(new Error('offline'))
    expect(await shell.setCredential('workbook', 'token', 'x')).toBe(false)
    remote.deleteCredential.mockResolvedValueOnce(ok(false))
    expect(await shell.deleteCredential('workbook', 'token')).toBe(false)
    remote.deleteCredential.mockRejectedValueOnce(new Error('offline'))
    expect(await shell.deleteCredential('workbook', 'token')).toBe(false)
    shell.dispose()
  })
})

describe('activation commands', () => {
  it('checks the activation write before re-reading the rows', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    remote.setActivation.mockResolvedValueOnce(carrierFailure())
    expect(await shell.setActivation('workbook', 'disabled')).toBe(false)
    expect(remote.setActivation).toHaveBeenCalledWith('workbook', 'disabled')
    expect(remote.list).not.toHaveBeenCalled()

    remote.setActivation.mockResolvedValue(ok([]))
    expect(await shell.setActivation('workbook', 'enabled')).toBe(true)
    expect(remote.list).toHaveBeenCalled()
    expect(shell.state.getSnapshot().error).toBeUndefined()
  })
})

describe('object references', () => {
  it('resolves through the host and rejects a failed resolution', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    const ref = { appId: 'objects', type: 'task', id: '1' }
    const resolve = shell.viewProps('objects').resolveObject!
    expect(await resolve(ref)).toEqual({ ref, title: 'Task 1' })
    remote.resolveObject.mockResolvedValueOnce(carrierFailure())
    await expect(resolve(ref)).rejects.toThrow(/carrier is gone/u)
  })
})


describe('page commands', () => {
  it('asks the first interested listener and answers the host', async () => {
    const remote = fakeRemote()
    const shell = shellOf(remote)
    shell.start()
    await tick()
    const command = { commandId: 'page-command-1', sessionId: 's-app', action: 'open' as const, appId: 'workbook', view: 'list' }
    const calls: string[] = []
    shell.onPageCommand((value) => { calls.push(value.commandId); return undefined })
    shell.onPageCommand((value) => { calls.push(`${value.commandId}:second`); return true })
    streamOf(remote).push({ kind: 'page-command', command })
    await tick()
    expect(calls).toEqual(['page-command-1', 'page-command-1:second'])
    expect(remote.completePageCommand).toHaveBeenCalledWith('page-command-1', true)

    // A listener that throws answers false for its own client.
    const secondRemote = fakeRemote()
    const broken = shellOf(secondRemote)
    broken.start()
    await tick()
    broken.onPageCommand(() => { throw new Error('listener broke') })
    streamOf(secondRemote).push({ kind: 'page-command', command: { ...command, commandId: 'page-command-2' } })
    await tick()
    expect(secondRemote.completePageCommand).toHaveBeenCalledWith('page-command-2', false)
    broken.dispose()
    shell.dispose()
  })
})
