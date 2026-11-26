/**
 * The inbox row's Cordis face: one row, one application, one gated SQLite
 * namespace. The repository is built here, the gated store's capability door is
 * attached in the application's start hook, and the declaration is handed to the
 * runtime (`mountApplication`), which ties the application's life to this row.
 * @module @matrix1001/dsh-application-harness-inbox
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { mountApplication } from '@matrix1001/dsh-application-harness-runtime'
import type { GatedStore } from '@matrix1001/dsh-application-harness-store'
import { InboxApp, inboxDeclaration } from './app.ts'
import { INBOX_NAMESPACE } from './model.ts'
import { InboxRepository } from './repository.ts'
import type { ApplicationHttpLike, FetchImpl } from './refresh.ts'

/** The inbox row's tunables (tests inject the transport; deployments take the defaults). */
export interface InboxConfig {
  /** The outbound transport; the host fetch when absent. */
  fetchImpl?: FetchImpl
  /** The host's bounded network service; absent in unit tests. */
  http?: ApplicationHttpLike
  /** The scheduler tick in ms (0 disables the automatic timer). */
  tickMs?: number
}

/** The row config schema: validated before the plugin starts (fail loud). */
export const Config = Schema.object({
  fetchImpl: Schema.function(),
  tickMs: Schema.number(),
})

/** The plugin name (the row id in a composition). */
export const name = 'inbox'

/** The inbox needs the application runtime: without it there is no registry to join. */
export const inject = ['applications', 'applicationStore']

/**
 * Mount the application.
 * @param ctx - the Cordis context (with the runtime injected).
 * @param config - the validated row config.
 */
export async function apply(ctx: Context, config: InboxConfig = {}): Promise<void> {
  const applicationHttp = ctx.get('applicationHttp') as ApplicationHttpLike | undefined
  const http = config.http ?? applicationHttp
  await mountApplication<GatedStore>(ctx, (store) => {
    const gated = store(INBOX_NAMESPACE)
    const app = new InboxApp({
      repository: new InboxRepository(gated),
      attach: access => { gated.attach(access) },
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
      ...(http === undefined ? {} : { http }),
      ...(config.tickMs === undefined ? {} : { tickMs: config.tickMs }),
    })
    return inboxDeclaration(app)
  })
}

export { InboxApp, inboxDeclaration, INBOX_CALLS, INBOX_CAPABILITIES, buildSource, selectTargets, applySourcePatch } from './app.ts'
export type {
  AddManualLinkArgs, AddSourceArgs, ClearEntriesArgs, FavoriteArgs, InboxAppOptions, ListEntriesArgs, ListGroupsArgs,
  MarkArgs, MarkSourceReadArgs, RefreshArgs, RefreshSummary, SaveToNoteArgs, SaveToTaskArgs, SetSettingsArgs, SourcePatch,
  StartTask, UpdateSourceArgs,
} from './app.ts'
export { InboxRepository, DOCUMENT_SCOPE } from './repository.ts'
export type { InboxStorePort } from './repository.ts'
export { fetchPageMeta, fetchText, pullSource } from './refresh.ts'
export type { FetchImpl, FetchResponseLike, PullOptions, PullResult } from './refresh.ts'
export {
  DEFAULT_GROUP_SIZE, DEFAULT_SETTINGS, emptyDocument, groupEntries, MAX_GROUP_SIZE, parseFeed, parseGitHubReleasesHtml,
  parseOpml, queryEntries, applyRetention,
} from './model.ts'
export type {
  Entry, EntryCounts, EntryGroup, EntrySummary, InboxDocument, InboxSettings, InboxView, ListEntriesResult,
  ListGroupsResult, OpmlResult, RefreshResult, RefreshScope, Source, SourceConfig, SourceKind, SourceView, SourcesResult,
} from './model.ts'
