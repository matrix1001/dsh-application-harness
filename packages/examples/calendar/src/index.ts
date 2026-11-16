/**
 * The calendar Cordis plugin: one row, one application, one gated SQLite
 * namespace. Task deadlines are a peer call, never a shared store.
 * @module @matrix1001/dsh-application-harness-calendar
 */

import type { Context } from '@deepseek-ai/cordis'
import { mountApplication } from '@matrix1001/dsh-application-harness-runtime'
import type {} from '@matrix1001/dsh-application-harness-store'
import { CalendarDeclaration, CalendarRepository } from './app.ts'

/** The plugin name. */
export const name = 'calendar'

/** Required runtime and storage services. */
export const inject = ['applications', 'applicationStore']

/** Mount the application. */
export async function apply(ctx: Context): Promise<void> {
  const store = ctx.applicationStore
  if (store === undefined) throw new Error('calendar requires the application store (ctx.applicationStore)')
  const repository = new CalendarRepository(store.gatedNamespace('calendar'))
  await mountApplication(ctx, CalendarDeclaration(repository))
}

export { CalendarDeclaration, CalendarRepository } from './app.ts'
export type { CalendarDocument, CalendarEvent, EventColor, EventTime, TaskDeadline, TaskDeadlinesResult } from './app.ts'
