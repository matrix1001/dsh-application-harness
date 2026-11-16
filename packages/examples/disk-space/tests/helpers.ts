/**
 * Shared fixtures for the disk-space host suites: a throwaway directory, a
 * controllable operation context whose `startTask` really runs the background
 * work, and the small filesystem builders the scenarios share. Every fixture
 * lives under the OS temporary directory and is removed after the spec — no
 * suite ever scans the real home directory.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { OperationContext, TaskContext, TaskDescriptor, TaskWork } from '@matrix1001/dsh-application-harness-runtime'

/** One background task started through the test context. */
export interface TestTask {
  descriptor: TaskDescriptor
  /** The task's signal (abort it to simulate the shell's cancel action). */
  signal: AbortSignal
  /** Settles after the work settled (errors are collected, never leaked). */
  done: Promise<void>
  /** The controller behind `signal`. */
  controller: AbortController
}

/** The recording test context. */
export interface TestContext {
  ctx: OperationContext
  /** Every started task, in order. */
  tasks: TestTask[]
  /** The errors the work threw, in settle order. */
  errors: unknown[]
  /** How many change notifications were emitted. */
  notifications: () => number
  /** The progress rows reported so far. */
  progress: Array<{ message: string; data: unknown }>
}

/** Build one temporary directory that the caller removes. */
export async function tempDir(prefix = 'dsh-disk-space-'): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

/** Write one file, creating its parent directories. */
export async function putFile(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

/** Remove one temporary tree. */
export async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/** Await every task started so far (the newest last). */
export async function settleTasks(sources: TestContext): Promise<void> {
  for (const task of sources.tasks) await task.done
}

/** The optional behaviours a test context can emulate. */
export interface ContextOptions {
  /** Start every task with an already-aborted signal (the shell cancelled it). */
  abortTasks?: boolean
  /** Throw from `reportProgress` (a progress delivery failure surfaces as a run failure). */
  throwOnProgress?: boolean
  /** Observe every progress report (a test can cancel exactly at the last one). */
  onProgress?: (message: string, data: unknown) => void
}

/**
 * Build a controllable operation context. `startTask` invokes the work on the
 * next microtask with a real `AbortSignal`; the caller can abort it to
 * simulate the platform's task cancellation.
 */
export function makeContext(options: ContextOptions = {}): TestContext {
  const tasks: TestTask[] = []
  const errors: unknown[] = []
  const progress: Array<{ message: string; data: unknown }> = []
  let notifications = 0
  const ctx = {
    appId: 'disk-space',
    op: 'test',
    callId: 'call-1',
    caller: { kind: 'human' },
    signal: new AbortController().signal,
    capabilities: {},
    secrets: {},
    reportProgress: (message: string, data?: unknown) => {
      if (options.throwOnProgress === true) throw new Error('progress channel closed')
      progress.push({ message, data })
      options.onProgress?.(message, data)
    },
    call: async () => ({ callId: 'call-1', status: 'cancelled' }),
    notifyChanged: () => { notifications += 1 },
    startTask: (descriptor: TaskDescriptor, work: TaskWork) => {
      const controller = new AbortController()
      if (options.abortTasks === true) controller.abort()
      const taskCtx = {
        appId: 'disk-space',
        taskId: `task-${String(tasks.length + 1)}`,
        signal: controller.signal,
        capabilities: {},
        secrets: {},
        reportProgress: (message: string, data?: unknown) => {
          if (options.throwOnProgress === true) throw new Error('progress channel closed')
          progress.push({ message, data })
          options.onProgress?.(message, data)
        },
        call: async () => ({ callId: 'call-1', status: 'cancelled' }),
        notifyChanged: () => { notifications += 1 },
      } as unknown as TaskContext
      const done = Promise.resolve()
        .then(async () => await work(taskCtx))
        .then(() => undefined, (error: unknown) => { errors.push(error) })
      tasks.push({ descriptor, signal: controller.signal, done, controller })
      return { taskId: `task-${String(tasks.length)}`, done }
    },
  }
  return {
    ctx: ctx as unknown as OperationContext,
    tasks,
    errors,
    notifications: () => notifications,
    progress,
  }
}
