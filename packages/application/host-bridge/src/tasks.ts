/**
 * The durable background-task projection: one JSONL file under the harness
 * home.
 *
 * This file is a CONTROL-PLANE record, not business state: the application's
 * own durable record remains the truth. It keeps the latest snapshot per task,
 * appends only state changes (progress is transient), rotates at 2 MB, and on
 * startup marks tasks still `running`/`cancelling` as `interrupted`. A task is
 * never restarted from this file; the application decides whether to resume or
 * retry its own record.
 * @module @matrix1001/dsh-application-harness-host-bridge/tasks
 */

import type {
  JsonValue, TaskError, TaskOrigin, TaskProgress, TaskSnapshot, TaskState,
} from './types.ts'
import { reasonOf } from '@matrix1001/dsh-application-harness-store/atomic'
import { appendRotated, callerOf, isRecord, readJsonl } from './jsonl.ts'

/** The soft per-file ceiling: the next state append rotates first once this is exceeded. */
export const TASK_FILE_LIMIT = 2 * 1024 * 1024

/** How many task projections the read window keeps (the oldest settled ones are dropped). */
export const TASK_WINDOW = 500

/** The durable task projection store/reader. */
export class FileTasks {
  /** Resolves when the startup load and its interrupted rewrite are done. */
  readonly ready: Promise<void>
  private readonly path: string
  private readonly report: (problem: string) => void
  private readonly map = new Map<string, TaskSnapshot>()
  private readonly buffered: TaskSnapshot[] = []
  private loaded = false
  private chain: Promise<void> = Promise.resolve()

  /**
   * @param path - the `tasks.jsonl` path.
   * @param report - where read/rotation/write problems are reported.
   */
  constructor(path: string, report: (problem: string) => void) {
    this.path = path
    this.report = report
    this.ready = this.start()
  }

  private async start(): Promise<void> {
    const loaded = await this.read()
    for (const task of loaded) this.map.set(task.taskId, task)
    const interrupted: TaskSnapshot[] = []
    const now = new Date().toISOString()
    for (const task of this.map.values()) {
      if (task.state !== 'running' && task.state !== 'cancelling') continue
      const next: TaskSnapshot = { ...task, state: 'interrupted', updatedAt: now, endedAt: now }
      this.map.set(next.taskId, next)
      interrupted.push(next)
    }
    this.loaded = true
    for (const task of interrupted) this.appendState(task)
    for (const task of this.buffered.splice(0)) this.record(task)
    this.prune()
    await this.chain
  }

  /**
   * Record one snapshot. The map always takes the latest value; the file only
   * receives a row when the lifecycle state changes (progress is transient).
   */
  record(task: TaskSnapshot): void {
    if (!this.loaded) {
      this.buffered.push(task)
      if (this.buffered.length > TASK_WINDOW) this.buffered.shift()
      return
    }
    const previous = this.map.get(task.taskId)
    this.map.set(task.taskId, task)
    this.prune()
    if (previous === undefined || previous.state !== task.state) this.appendState(task)
  }

  /** Read the task projections after the startup load, newest first. */
  async list(): Promise<readonly TaskSnapshot[]> {
    await this.ready
    return [...this.map.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /** Read one projection after load, or undefined when unknown. */
  async task(appId: string, taskId: string): Promise<TaskSnapshot | undefined> {
    await this.ready
    const task = this.map.get(taskId)
    return task?.appId === appId ? task : undefined
  }

  /** Wait for the startup load and every queued append (tests/shutdown). */
  async flush(): Promise<void> {
    await this.ready
    await this.chain
  }

  private appendState(task: TaskSnapshot): void {
    const text = `${JSON.stringify(task)}\n`
    const run = async (): Promise<void> => {
      await appendRotated(this.path, text, TASK_FILE_LIMIT)
    }
    const attempt = this.chain.then(run, run)
    this.chain = attempt.catch((error: unknown) => {
      this.report(`tasks: cannot append ${task.taskId}: ${reasonOf(error)}`)
    })
  }

  private prune(): void {
    if (this.map.size <= TASK_WINDOW) return
    const settled = [...this.map.values()]
      .filter(task => task.state !== 'running' && task.state !== 'cancelling')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    for (const task of settled) {
      if (this.map.size <= TASK_WINDOW) break
      this.map.delete(task.taskId)
    }
  }

  private async read(): Promise<readonly TaskSnapshot[]> {
    const records = new Map<string, TaskSnapshot>()
    for (const path of [`${this.path}.1`, this.path]) {
      const { records: tasks, bad } = await readJsonl(path, taskOf, this.report, 'tasks')
      for (const task of tasks) records.set(task.taskId, task)
      if (bad > 0) this.report(`tasks: skipped ${String(bad)} malformed line(s) in ${path}`)
    }
    return [...records.values()]
  }

}

const TASK_STATES: readonly TaskState[] = ['running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted']

/** Validate one stored task row; `undefined` when it is not one. */
function taskOf(value: unknown): TaskSnapshot | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.taskId !== 'string' || value.taskId === '') return undefined
  if (typeof value.traceId !== 'string' || value.traceId === '') return undefined
  if (typeof value.appId !== 'string' || value.appId === '') return undefined
  if (typeof value.kind !== 'string' || typeof value.title !== 'string') return undefined
  if (typeof value.startedAt !== 'string' || typeof value.updatedAt !== 'string') return undefined
  if (typeof value.state !== 'string' || !TASK_STATES.includes(value.state as TaskState)) return undefined
  const origin = originOf(value.origin)
  if (origin === undefined) return undefined
  if (value.externalId !== undefined && typeof value.externalId !== 'string') return undefined
  if (value.requestId !== undefined && typeof value.requestId !== 'string') return undefined
  if (value.endedAt !== undefined && typeof value.endedAt !== 'string') return undefined
  const progress = progressOf(value.progress)
  if (value.progress !== undefined && progress === undefined) return undefined
  const error = errorOf(value.error)
  if (value.error !== undefined && error === undefined) return undefined
  return {
    taskId: value.taskId,
    traceId: value.traceId,
    appId: value.appId,
    kind: value.kind,
    title: value.title,
    ...(value.externalId === undefined ? {} : { externalId: value.externalId }),
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
    origin,
    state: value.state as TaskState,
    ...(progress === undefined ? {} : { progress }),
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt }),
    ...(error === undefined ? {} : { error }),
    ...(value.resultSummary === undefined ? {} : { resultSummary: value.resultSummary as JsonValue }),
  }
}

function originOf(value: unknown): TaskOrigin | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'background') return { kind: 'background' }
  if (value.kind !== 'operation' || typeof value.callId !== 'string') return undefined
  const caller = callerOf(value.caller)
  return caller === undefined ? undefined : { kind: 'operation', callId: value.callId, caller }
}

function progressOf(value: unknown): TaskProgress | undefined {
  if (!isRecord(value) || typeof value.message !== 'string' || typeof value.updatedAt !== 'string') return undefined
  return {
    message: value.message,
    ...(value.data === undefined ? {} : { data: value.data as JsonValue }),
    updatedAt: value.updatedAt,
  }
}

function errorOf(value: unknown): TaskError | undefined {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') return undefined
  return { code: value.code, message: value.message }
}
