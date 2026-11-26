/**
 * The home row's Cordis face: one row, one application, one gated SQLite
 * namespace. The repository is built here, the gated store's capability door is
 * attached in the application's start hook, and the declaration is handed to the
 * runtime (`mountApplication`), which ties the application's life to this row.
 * @module @matrix1001/dsh-application-harness-home
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GatedStore } from '@matrix1001/dsh-application-harness-store'
import { mountApplication } from '@matrix1001/dsh-application-harness-runtime'
import { HomeApp, homeDeclaration } from './app.ts'
import { HOME_NAMESPACE } from './model.ts'
import { HomeRepository } from './repository.ts'

/** The plugin name (the row id in a composition). */
export const name = 'home'

/** The home needs the application runtime: without it there is no registry to join. */
export const inject = ['applications', 'applicationStore']

/**
 * Mount the application.
 * @param ctx - the Cordis context (with the runtime injected).
 */
export async function apply(ctx: Context): Promise<void> {
  await mountApplication<GatedStore>(ctx, (store) => {
    const gated = store(HOME_NAMESPACE)
    const app = new HomeApp({
      repository: new HomeRepository(gated),
      attach: access => { gated.attach(access) },
    })
    return homeDeclaration(app)
  })
}

export { HomeApp, homeDeclaration, HOME_CALLS, HOME_EVENT_PUBLISHER, HOME_EVENT_TYPE } from './app.ts'
export type {
  HomeAppOptions, InboxCard, InboxPreview, NotePreview, NotesCard, Overview, TodoCard, TodoPreview,
} from './app.ts'
export {
  activityFrom, appendActivity, cardFailure, cardFailureKindOf, emptyDocument, HOME_APP_ID, HOME_DESCRIPTION, HOME_NAME, HOME_NAMESPACE, HOME_SCHEMA_VERSION, HOME_VERSION,
  isHomeDocument, localDate, MAX_ACTIVITIES, MAX_ACTIVITY_REFS, MAX_CARD_FAILURE_CODE, MAX_CARD_FAILURE_MESSAGE, PREVIEW_ITEMS,
} from './model.ts'
export type { Activity, ActivityRef, CardFailure, CardFailureKind, HomeDocument } from './model.ts'
export { DOCUMENT_SCOPE, HomeRepository } from './repository.ts'
export type { HomeStorePort } from './repository.ts'
