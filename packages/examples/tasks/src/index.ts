/**
 * The tasks Cordis plugin: one row, one application, one gated SQLite
 * namespace. Note lookup is a peer call, never a shared store.
 * @module @matrix1001/dsh-application-harness-tasks
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@matrix1001/dsh-application-harness-store'
import { mountApplication } from '@matrix1001/dsh-application-harness-runtime'
import { TasksDeclaration, TasksRepository } from './app.ts'

/** The plugin name. */
export const name = 'tasks'

/** Required runtime and storage services. */
export const inject = ['applications', 'applicationStore']

/** Mount the application. */
export async function apply(ctx: Context): Promise<void> {
  const store = ctx.applicationStore
  if (store === undefined) throw new Error('tasks requires the application store (ctx.applicationStore)')
  const repository = new TasksRepository(store.gatedNamespace('tasks'))
  await mountApplication(ctx, TasksDeclaration(repository))
}

export { TasksDeclaration, TasksRepository } from './app.ts'
export type { Task, TaskProject, TasksDocument } from './app.ts'
