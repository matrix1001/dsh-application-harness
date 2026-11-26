/**
 * The todo Cordis plugin: one row, one application, one gated SQLite
 * namespace. Note lookup is a peer call, never a shared store.
 * @module @matrix1001/dsh-application-harness-todo
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GatedStore } from '@matrix1001/dsh-application-harness-store'
import { mountApplication } from '@matrix1001/dsh-application-harness-runtime'
import { TodoDeclaration, TodoRepository } from './app.ts'

/** The plugin name. */
export const name = 'todo'

/** Required runtime and storage services. */
export const inject = ['applications', 'applicationStore']

/** Mount the application. */
export async function apply(ctx: Context): Promise<void> {
  await mountApplication<GatedStore>(ctx, (store) => {
    const repository = new TodoRepository(store('todo'))
    return TodoDeclaration(repository)
  })
}

export { TodoDeclaration, TodoRepository } from './app.ts'
export type { Task, TaskSource, TodoDocument } from './app.ts'
