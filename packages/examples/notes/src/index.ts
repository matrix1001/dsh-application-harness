/**
 * The notes Cordis plugin: one row, one application, one gated SQLite
 * namespace. The repository is constructed here and its capability door is
 * attached in the application's start hook.
 * @module @matrix1001/dsh-application-harness-notes
 */

import type { Context } from '@deepseek-ai/cordis'
import { mountApplication } from '@matrix1001/dsh-application-harness-runtime'
import type {} from '@matrix1001/dsh-application-harness-store'
import { NotesDeclaration, NotesRepository } from './app.ts'

/** The plugin name. */
export const name = 'notes'

/** Required runtime and storage services. */
export const inject = ['applications', 'applicationStore']

/** Mount the application. */
export async function apply(ctx: Context): Promise<void> {
  const store = ctx.applicationStore
  if (store === undefined) throw new Error('notes requires the application store (ctx.applicationStore)')
  const repository = new NotesRepository(store.gatedNamespace('notes'))
  await mountApplication(ctx, NotesDeclaration(repository))
}

export { NotesDeclaration, NotesRepository } from './app.ts'
export type { Note, NoteSummary, NotesDocument } from './app.ts'
