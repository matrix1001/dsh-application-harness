/**
 * The inbox application: one durable document, one serialized writer, a
 * per-source refresh engine and the operations the page, the AI and peer
 * applications call.
 *
 * The class owns the business rules; {@link inboxDeclaration} states the same
 * facts once in the platform's schema DSL. Cross-application effects (creating a
 * task or a note) go through `ctx.call` with a `source` reference and a stable
 * `requestId`, so a retried hand-over returns the first result instead of
 * creating a second item.
 * @module @matrix1001/dsh-application-harness-inbox/app
 */

import {
  AppError,
  SingleFlight,
  runPeriodically,
} from '@matrix1001/dsh-application-harness-runtime'
import type {
  AppCall,
  AppContext,
  AppDeclaration,
  CapabilityAccess,
  ObjectRef,
  OperationContext,
  ParameterSchemaSpec,
  TaskContext,
  TaskDescriptor,
  TaskHandle,
  TaskWork,
  ValueSchemaSpec,
} from '@matrix1001/dsh-application-harness-runtime'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { InboxRepository } from './repository.ts'
import type { ApplicationHttpLike, FetchImpl, PullOptions, PullResult } from './refresh.ts'
import { fetchPageMeta, pullSource } from './refresh.ts'
import {
  applyRetention,
  applySettingsPatch,
  assertEntryKind,
  assertSourceKind,
  backoffMs,
  clampText,
  DEFAULT_PAGE_LIMIT,
  effectiveInterval,
  entryBytes,
  entryTime,
  groupEntries,
  hashText,
  hostOf,
  INBOX_APP_ID,
  INBOX_DESCRIPTION,
  INBOX_NAME,
  INBOX_SCHEMA_VERSION,
  INBOX_VERSION,
  isDue,
  isSourceKind,
  MAX_CONTENT,
  MAX_ERROR,
  MAX_OPML,
  MAX_SOURCE_NAME,
  MAX_SUMMARY,
  MAX_TITLE,
  newEntryId,
  newSourceId,
  normalizeHttpUrl,
  normalizeInterval,
  normalizeRepo,
  parseOpml,
  queryEntries,
  reasonOf,
  REFRESH_TICK_MS,
  upsertEntries,
} from './model.ts'
import type {
  Entry,
  EntryQuery,
  InboxSettings,
  InboxView,
  ListEntriesResult,
  ListGroupsResult,
  OpmlResult,
  RefreshResult,
  RefreshScope,
  Source,
  SourcesResult,
  SourceKind,
} from './model.ts'

/** Where the application starts a background task (the operation or the lifecycle face). */
export type StartTask = (descriptor: TaskDescriptor, work: TaskWork) => TaskHandle

/** The options the row (or a spec) builds an application with. */
export interface InboxAppOptions {
  repository: InboxRepository
  /** The outbound transport; the host fetch when absent. */
  fetchImpl?: FetchImpl
  /** The host's bounded network service; absent in tests. */
  http?: ApplicationHttpLike
  /** Attach the storage capability door before the first read (the shipped row passes the gated namespace's own). */
  attach?: (access: CapabilityAccess) => void
  /** The clock (epoch ms); `Date.now` when absent. */
  now?: () => number
  /** The scheduler tick; {@link REFRESH_TICK_MS} when absent, 0 disables the timer. */
  tickMs?: number
}

/** The arguments of `listEntries`. */
export interface ListEntriesArgs {
  view?: string
  unread?: boolean
  newOnly?: boolean
  sourceId?: string
  kind?: string
  search?: string
  offset?: number
  limit?: number
}

/** The arguments of `listGroups`. */
export interface ListGroupsArgs extends ListEntriesArgs {
  perGroup?: number
}

/** The arguments of `markSourceRead`. */
export interface MarkSourceReadArgs { sourceId: string; read: boolean }

/** The arguments of `markRead`/`markSeen`. */
export interface MarkArgs { ids: string[] }

/** The arguments of `favorite`. */
export interface FavoriteArgs { id: string; favorite: boolean }

/** The arguments of `saveToTask`. */
export interface SaveToTaskArgs { id: string }

/** The arguments of `saveToNote`. */
export interface SaveToNoteArgs { id: string }

/** The arguments of `addManualLink`. */
export interface AddManualLinkArgs { url: string; title?: string }

/** The arguments of `addSource`. */
export interface AddSourceArgs {
  kind: string
  url?: string
  name?: string
  repo?: string
  intervalMs?: number
}

/** The editable half of one source. */
export interface SourcePatch {
  name?: string
  enabled?: boolean
  intervalMs?: number
  url?: string
  repo?: string
}

/** The arguments of `updateSource`. */
export interface UpdateSourceArgs { id: string; expectedVersion: number; patch?: SourcePatch }

/** The arguments of `refresh`. */
export interface RefreshArgs { scope?: string; sourceId?: string }

/** The arguments of `clearEntries`. */
export interface ClearEntriesArgs { sourceId?: string }

/** The arguments of `setSettings`. */
export interface SetSettingsArgs {
  patch?: Record<string, unknown>
}

/** What a settings change would prune if saved now. */
export interface SettingsPreview {
  settings: InboxSettings
  removedEntries: number
  removedBytes: number
}

/** One refresh's outcome (also the task's result summary). */
export interface RefreshSummary {
  sources: number
  added: number
  updated: number
  failed: number
  removed: number
}

/** The result one source read contributes to the refresh summary. */
interface ApplyCounts { added: number; updated: number; created: Entry[] }

/** The most entry refs one published `entry.created` event carries (a busy pull is coalesced into one event). */
const MAX_EVENT_REFS = 50

/** Build an abort error the runtime reads as a cancellation. */
function abortError(): Error {
  const error = new Error('the inbox refresh was cancelled')
  error.name = 'AbortError'
  return error
}

/** Read one created id out of a peer call's result, failing loudly on a shape this app cannot use. */
function createdId(value: JsonValue, what: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('dependency-invalid-result', `inbox: the ${what} response carried no object`)
  }
  const id = (value as Record<string, unknown>).id
  if (typeof id !== 'string' || id === '') throw new AppError('dependency-invalid-result', `inbox: the ${what} response carried no id`)
  return id
}

/** A one-line reason out of one call outcome that did not succeed. */
function failureMessage(outcome: { status: string; message?: string }): string {
  return outcome.status === 'cancelled' ? 'the call was cancelled' : (outcome.message as string)
}

/** Normalize an optional source name. */
function sourceNameOf(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback
  const name = clampText(value, MAX_SOURCE_NAME)
  if (name === '') throw new AppError('invalid-args', 'a source name must not be empty')
  return name
}

/** Whether two sources name the same subscription (GitHub compares the repository, RSS the URL). */
function sameSource(left: Source, right: Source): boolean {
  if (left.kind === 'github' && right.kind === 'github') {
    return String(left.config.repo).toLocaleLowerCase() === String(right.config.repo).toLocaleLowerCase()
  }
  return left.kind === right.kind && left.url === right.url
}

/** Build one new source from the add-source arguments. */
export function buildSource(kind: SourceKind, args: AddSourceArgs, now: number): Source {
  const base = {
    id: newSourceId(),
    kind,
    enabled: true,
    removed: false,
    failures: 0,
    createdAt: now,
    updatedAt: now,
    version: 1,
    // No override until the caller asks for one: the source then follows the
    // family setting, so a later change of that setting reaches it too.
    intervalMs: normalizeInterval(args.intervalMs, 0),
  }
  if (kind === 'github') {
    const repo = normalizeRepo(args.repo ?? args.url ?? '')
    return { ...base, name: sourceNameOf(args.name, repo), url: `https://github.com/${repo}`, config: { repo } }
  }
  const url = normalizeHttpUrl(args.url ?? '')
  return { ...base, name: sourceNameOf(args.name, hostOf(url)), url, config: {} }
}

/** Select the sources one refresh request targets. */
export function selectTargets(sources: readonly Source[], scope: RefreshScope, sourceId: string | undefined, now: number, settings: InboxSettings): Source[] {
  if (sourceId !== undefined) {
    const source = sources.find(candidate => candidate.id === sourceId)
    if (source === undefined || source.removed || !isSourceKind(source.kind)) return []
    return [source]
  }
  return sources.filter((source) => {
    if (source.removed || !isSourceKind(source.kind)) return false
    return scope === 'due' ? isDue(source, now, settings) : source.enabled
  })
}

/** Apply one validated patch to one source (the update-source rule). */
export function applySourcePatch(sources: readonly Source[], current: Source, patch: SourcePatch, now: number): Source {
  const next: Source = { ...current, config: { ...current.config } }
  if (patch.name !== undefined) {
    const name = clampText(patch.name, MAX_SOURCE_NAME)
    if (name === '') throw new AppError('invalid-args', 'a source name must not be empty')
    next.name = name
  }
  if (patch.enabled !== undefined) {
    next.enabled = patch.enabled
    if (patch.enabled) delete next.backoffUntil
  }
  if (patch.intervalMs !== undefined) next.intervalMs = normalizeInterval(patch.intervalMs, current.intervalMs)
  if (patch.repo !== undefined || patch.url !== undefined) {
    if (current.kind === 'github') {
      const repo = normalizeRepo((patch.repo ?? patch.url) as string)
      next.url = `https://github.com/${repo}`
      next.config.repo = repo
    } else {
      if (patch.repo !== undefined) throw new AppError('invalid-args', 'only a GitHub source carries a repository')
      next.url = normalizeHttpUrl(patch.url as string)
    }
    const duplicate = sources.find(candidate => candidate.id !== current.id && sameSource(candidate, next))
    if (duplicate !== undefined) throw new AppError('duplicate-source', `inbox: ${duplicate.name} is already a source`)
  }
  next.updatedAt = now
  next.version = current.version + 1
  return next
}

/** The application. */
export class InboxApp {
  private readonly repository: InboxRepository
  private readonly fetchImpl: FetchImpl | undefined
  private readonly http: ApplicationHttpLike | undefined
  private readonly attach: ((access: CapabilityAccess) => void) | undefined
  private readonly now: () => number
  private readonly tickMs: number
  private readonly flight = new SingleFlight()
  private appContext: AppContext | undefined
  private pruned = false
  private timerStop: (() => void) | undefined
  private timerAbort: AbortController | undefined
  private refreshTaskId: string | undefined

  constructor(options: InboxAppOptions) {
    this.repository = options.repository
    this.fetchImpl = options.fetchImpl
    this.http = options.http
    this.attach = options.attach
    this.now = options.now ?? (() => Date.now())
    this.tickMs = options.tickMs ?? REFRESH_TICK_MS
  }

  /** Load the document once (the declaration's wrapper calls it before every operation). */
  async ensureLoaded(): Promise<void> {
    await this.repository.ensureLoaded()
    if (!this.pruned) {
      this.pruned = true
      await this.prune()
    }
  }

  /** Load the document, apply retention and arm the scheduler. */
  async start(ctx: AppContext): Promise<void> {
    this.appContext = ctx
    this.attach?.(ctx.capabilities)
    // The first operation loads the document; start must not touch storage
    // before the human approves the capability (the panel would show a failed
    // application that can never recover). The scheduler only arms the timer.
    this.arm()
  }

  /** Stop the scheduler (the runtime settles the background work). */
  stop(): void {
    this.disarm()
    this.appContext = undefined
  }

  /** Stop arming automatic refreshes (an import hold). */
  pause(): void {
    this.disarm()
  }

  /** Re-arm the scheduler after a hold. */
  resume(): void {
    this.arm()
  }

  /** Re-read the document after an external writer changed it. */
  async reload(): Promise<void> {
    await this.repository.load()
    this.pruned = true
    await this.prune()
    this.arm()
  }

  /** The source list with per-source entry counts and the health summary. */
  async listSources(args: { includeRemoved?: boolean }): Promise<SourcesResult> {
    // A health check can be the first reader after mount. Without this load it
    // would inspect the empty in-memory default and report a healthy application
    // while the durable document holds failing sources.
    await this.repository.ensureLoaded()
    const includeRemoved = args.includeRemoved === true
    const document = this.repository.read(value => value)
    const counts = new Map<string, { total: number; unread: number; latestAt?: number }>()
    for (const entry of document.entries) {
      if (entry.sourceId === undefined) continue
      const current = counts.get(entry.sourceId) ?? { total: 0, unread: 0 }
      current.total += 1
      if (entry.readAt === undefined) current.unread += 1
      const at = entryTime(entry)
      if (current.latestAt === undefined || at > current.latestAt) current.latestAt = at
      counts.set(entry.sourceId, current)
    }
    const all = document.sources
      .map((source) => {
        const counted = counts.get(source.id)
        return {
          ...source,
          entryCount: counted?.total ?? 0,
          unreadCount: counted?.unread ?? 0,
          ...(counted?.latestAt === undefined ? {} : { latestAt: counted.latestAt }),
        }
      })
    const health = { total: 0, ok: 0, error: 0, paused: 0 }
    for (const source of all) {
      if (source.removed) continue
      health.total += 1
      if (!source.enabled) health.paused += 1
      else if (source.lastError !== undefined) health.error += 1
      else health.ok += 1
    }
    return { sources: includeRemoved ? all : all.filter(source => !source.removed), health }
  }

  /** The shared query shape for the flat and grouped reads. */
  private queryOf(args: ListEntriesArgs): EntryQuery {
    if (args.view !== undefined && args.view !== 'inbox' && args.view !== 'saved') throw new AppError('invalid-args', 'view must be inbox or saved')
    const view: InboxView = args.view === 'saved' ? 'saved' : 'inbox'
    const kind = args.kind === undefined ? undefined : assertEntryKind(args.kind)
    const search = args.search?.trim()
    return {
      view,
      ...(args.unread === true ? { unread: true } : {}),
      ...(args.newOnly === true ? { newOnly: true } : {}),
      ...(args.sourceId === undefined ? {} : { sourceId: args.sourceId }),
      ...(kind === undefined ? {} : { kind }),
      ...(search === undefined || search === '' ? {} : { search }),
      ...(args.offset === undefined ? {} : { offset: args.offset }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    }
  }

  /** One page of entries plus the badges' counts. */
  async listEntries(args: ListEntriesArgs): Promise<ListEntriesResult> {
    const document = this.repository.read(value => value)
    return queryEntries(document.entries, document.sources, this.queryOf(args))
  }

  /** The inbox grouped by source, each group carrying its newest few entries. */
  async listGroups(args: ListGroupsArgs): Promise<ListGroupsResult> {
    const document = this.repository.read(value => value)
    return groupEntries(document.entries, document.sources, this.queryOf(args), args.perGroup)
  }

  /** One entry with its full body. */
  async getEntry(args: { id: string }): Promise<Entry> {
    return this.entryOf(args.id)
  }

  /** Mark entries read or unread; marking read also clears the "new" flag. */
  async markRead(args: MarkArgs & { read: boolean }): Promise<{ changed: number }> {
    const now = this.now()
    const changed = await this.repository.mutate((document) => {
      let count = 0
      const entries = document.entries.map((entry) => {
        if (!args.ids.includes(entry.id)) return entry
        if (args.read) {
          if (entry.readAt !== undefined && entry.seenAt !== undefined) return entry
          count += 1
          return { ...entry, readAt: entry.readAt ?? now, seenAt: entry.seenAt ?? now }
        }
        if (entry.readAt === undefined) return entry
        count += 1
        const { readAt: _readAt, ...rest } = entry
        return rest
      })
      return { document: { ...document, entries }, result: count }
    })
    return { changed }
  }

  /** Clear the "new" flag on entries. */
  async markSeen(args: MarkArgs): Promise<{ changed: number }> {
    const now = this.now()
    const changed = await this.repository.mutate((document) => {
      let count = 0
      const entries = document.entries.map((entry) => {
        if (!args.ids.includes(entry.id) || entry.seenAt !== undefined) return entry
        count += 1
        return { ...entry, seenAt: now }
      })
      return { document: { ...document, entries }, result: count }
    })
    return { changed }
  }

  /** Mark every entry of one source read or unread (the group-level action). */
  async markSourceRead(args: MarkSourceReadArgs): Promise<{ changed: number }> {
    const now = this.now()
    const changed = await this.repository.mutate((document) => {
      if (!document.sources.some(source => source.id === args.sourceId)) {
        throw new AppError('not-found', `inbox: no source ${args.sourceId}`)
      }
      let count = 0
      const entries = document.entries.map((entry) => {
        if (entry.sourceId !== args.sourceId) return entry
        if (args.read) {
          if (entry.readAt !== undefined && entry.seenAt !== undefined) return entry
          count += 1
          return { ...entry, readAt: entry.readAt ?? now, seenAt: entry.seenAt ?? now }
        }
        if (entry.readAt === undefined) return entry
        count += 1
        const { readAt: _readAt, ...rest } = entry
        return rest
      })
      return { document: { ...document, entries }, result: count }
    })
    return { changed }
  }

  /** Set or clear one entry's favorite flag. */
  async favorite(args: FavoriteArgs): Promise<Entry> {
    return await this.repository.mutate((document) => {
      const index = document.entries.findIndex(entry => entry.id === args.id)
      if (index < 0) throw new AppError('not-found', `inbox: no entry ${args.id}`)
      const current = document.entries[index]!
      if (current.favorite === args.favorite) return { document, result: current }
      const next: Entry = { ...current, favorite: args.favorite }
      const entries = [...document.entries]
      entries[index] = next
      return { document: { ...document, entries }, result: next }
    })
  }

  /** Create (or return) the one task this entry owns. */
  async saveToTask(args: SaveToTaskArgs, ctx: OperationContext): Promise<{ taskId: string }> {
    return await this.convertToTask(args, ctx, false)
  }

  /**
   * Create a new task after the entry's stored task is known to be gone. The
   * page calls this only when its reference resolution reported `not-found`;
   * the operation stays UI-only so no model or peer can mint a duplicate task
   * for an entry that still owns one.
   */
  async reconvertToTask(args: SaveToTaskArgs, ctx: OperationContext): Promise<{ taskId: string }> {
    return await this.convertToTask(args, ctx, true)
  }

  /** Create (or return) the one task this entry owns, optionally replacing a dead reference. */
  private async convertToTask(args: SaveToTaskArgs, ctx: OperationContext, replace: boolean): Promise<{ taskId: string }> {
    const entry = this.entryOf(args.id)
    if (entry.taskId !== undefined && !replace) return { taskId: entry.taskId }
    const notes = clampText([entry.summary, entry.url].filter(part => part !== '').join('\n\n'), MAX_CONTENT)
    const outcome = await ctx.call('todo', 'createTask', {
      title: clampText(entry.title, MAX_TITLE),
      notes,
      source: { app: INBOX_APP_ID, id: entry.id, url: entry.url, title: entry.title },
      requestId: `inbox:${entry.id}:task`,
    })
    if (outcome.status !== 'success') throw new AppError('dependency-unavailable', `inbox: the task was not created: ${failureMessage(outcome)}`)
    const taskId = createdId(outcome.result as JsonValue, 'task')
    const stored = await this.repository.mutate((document) => {
      const index = document.entries.findIndex(candidate => candidate.id === entry.id)
      if (index < 0) return { document, result: taskId }
      const current = document.entries[index]!
      if (current.taskId !== undefined && !replace) return { document, result: current.taskId }
      const entries = [...document.entries]
      entries[index] = { ...current, taskId }
      return { document: { ...document, entries }, result: taskId }
    })
    return { taskId: stored }
  }

  /** Create (or return) the one note this entry was saved as. */
  async saveToNote(args: SaveToNoteArgs, ctx: OperationContext): Promise<{ noteId: string }> {
    return await this.convertToNote(args, ctx, false)
  }

  /**
   * Save a new note after the entry's stored note is known to be gone. UI-only
   * for the same reason as {@link reconvertToTask}: a duplicate must never be
   * minted by a caller that can already see the live note.
   */
  async reconvertToNote(args: SaveToNoteArgs, ctx: OperationContext): Promise<{ noteId: string }> {
    return await this.convertToNote(args, ctx, true)
  }

  /** Create (or return) the one note this entry owns, optionally replacing a dead reference. */
  private async convertToNote(args: SaveToNoteArgs, ctx: OperationContext, replace: boolean): Promise<{ noteId: string }> {
    const entry = this.entryOf(args.id)
    if (entry.noteId !== undefined && !replace) return { noteId: entry.noteId }
    const body = clampText([entry.title, entry.summary, entry.content, entry.url].filter(part => part !== '').join('\n\n'), 90_000)
    const outcome = await ctx.call('notes', 'create', {
      body,
      tags: [`inbox:${entry.sourceKind}`],
      source: { app: INBOX_APP_ID, id: entry.id, url: entry.url, title: entry.title },
      requestId: `inbox:${entry.id}:note`,
    })
    if (outcome.status !== 'success') throw new AppError('dependency-unavailable', `inbox: the note was not saved: ${failureMessage(outcome)}`)
    const noteId = createdId(outcome.result as JsonValue, 'note')
    const stored = await this.repository.mutate((document) => {
      const index = document.entries.findIndex(candidate => candidate.id === entry.id)
      if (index < 0) return { document, result: noteId }
      const current = document.entries[index]!
      if (current.noteId !== undefined && !replace) return { document, result: current.noteId }
      const entries = [...document.entries]
      entries[index] = { ...current, noteId }
      return { document: { ...document, entries }, result: noteId }
    })
    return { noteId: stored }
  }

  /** Add one manual link, fetching the page's title/description when the network allows it. */
  async addManualLink(args: AddManualLinkArgs, ctx: OperationContext): Promise<Entry> {
    const url = normalizeHttpUrl(args.url)
    const duplicate = this.repository.read(document => document.entries.find(entry => entry.sourceKind === 'manual' && entry.url === url))
    if (duplicate !== undefined) return duplicate
    let meta: Awaited<ReturnType<typeof fetchPageMeta>> | undefined
    try {
      meta = await fetchPageMeta(url, this.pullOptions(ctx.capabilities, ctx.signal))
    } catch {
      meta = undefined
    }
    const now = this.now()
    const title = clampText(args.title?.trim() || meta?.title || url, MAX_TITLE)
    let summary = url
    let content = url
    if (meta !== undefined) {
      summary = meta.description ?? meta.text
      content = meta.text
    }
    summary = clampText(summary, MAX_SUMMARY) || url
    content = clampText(content, MAX_CONTENT) || url
    const entry: Entry = {
      id: newEntryId(),
      sourceKind: 'manual',
      externalId: `manual:${hashText(url)}`,
      url,
      title,
      summary,
      content,
      fetchedAt: now,
      contentHash: hashText(`${title}\n${summary}\n${content}`),
      favorite: false,
    }
    const stored = await this.repository.mutate((document) => {
      const raced = document.entries.find(candidate => candidate.sourceKind === 'manual' && candidate.url === url)
      if (raced !== undefined) return { document, result: raced }
      return { document: { ...document, entries: [entry, ...document.entries] }, result: entry }
    })
    // A manually added link is a new entry too, so it carries the same notice a
    // pull does; the duplicate path above stays silent.
    if (stored.id === entry.id) this.publishCreated(ctx, [stored])
    return stored
  }

  /** Create one source, refusing a duplicate subscription. */
  async addSource(args: AddSourceArgs): Promise<Source> {
    const kind = assertSourceKind(args.kind)
    const now = this.now()
    return await this.repository.mutate((document) => {
      const source = buildSource(kind, args, now)
      const duplicate = document.sources.find(candidate => candidate.removed !== true && sameSource(candidate, source))
      if (duplicate !== undefined) throw new AppError('duplicate-source', `inbox: ${duplicate.name} is already a source`)
      return { document: { ...document, sources: [...document.sources, source] }, result: source }
    })
  }

  /** Edit, enable/disable or re-target one source with optimistic concurrency. */
  async updateSource(args: UpdateSourceArgs): Promise<Source> {
    const now = this.now()
    return await this.repository.mutate((document) => {
      const index = document.sources.findIndex(source => source.id === args.id)
      if (index < 0) throw new AppError('not-found', `inbox: no source ${args.id}`)
      const current = document.sources[index]!
      if (current.removed) throw new AppError('not-found', `inbox: the source ${args.id} was removed`)
      if (current.version !== args.expectedVersion) throw new AppError('stale-version', 'inbox: the source changed; reload and retry')
      const next = applySourcePatch(document.sources, current, args.patch ?? {}, now)
      const sources = [...document.sources]
      sources[index] = next
      return { document: { ...document, sources }, result: next }
    })
  }

  /** Mark one source removed; its entries stay readable. */
  async removeSource(args: { id: string }): Promise<Source> {
    const now = this.now()
    return await this.repository.mutate((document) => {
      const index = document.sources.findIndex(source => source.id === args.id)
      if (index < 0) throw new AppError('not-found', `inbox: no source ${args.id}`)
      const current = document.sources[index]!
      if (current.removed) return { document, result: current }
      const next: Source = { ...current, removed: true, enabled: false, updatedAt: now, version: current.version + 1 }
      const sources = [...document.sources]
      sources[index] = next
      return { document: { ...document, sources }, result: next }
    })
  }

  /** Import the feeds of one OPML document. */
  async importOpml(args: { xml: string }): Promise<OpmlResult> {
    if (args.xml.length > MAX_OPML) throw new AppError('invalid-args', `the OPML document may be at most ${String(MAX_OPML)} characters`)
    const { candidates, invalid } = parseOpml(args.xml)
    const now = this.now()
    return await this.repository.mutate((document) => {
      const sources = [...document.sources]
      let added = 0
      let skipped = 0
      for (const candidate of candidates) {
        const duplicate = sources.some(source => source.removed !== true && source.kind === 'rss' && source.url === candidate.url)
        if (duplicate) {
          skipped += 1
          continue
        }
        sources.push({
          id: newSourceId(),
          kind: 'rss',
          name: candidate.name,
          url: candidate.url,
          enabled: true,
          intervalMs: 0,
          config: {},
          removed: false,
          failures: 0,
          createdAt: now,
          updatedAt: now,
          version: 1,
        })
        added += 1
      }
      return { document: { ...document, sources }, result: { added, skipped, invalid } }
    })
  }

  /** Delete entries (all of them, or one source's); sources themselves stay. */
  async clearEntries(args: ClearEntriesArgs): Promise<{ removed: number }> {
    return await this.repository.mutate((document) => {
      if (args.sourceId !== undefined && !document.sources.some(source => source.id === args.sourceId)) {
        throw new AppError('not-found', `inbox: no source ${args.sourceId}`)
      }
      const entries = args.sourceId === undefined ? [] : document.entries.filter(entry => entry.sourceId !== args.sourceId)
      return { document: { ...document, entries }, result: { removed: document.entries.length - entries.length } }
    })
  }

  /** The durable settings (read-only; no credential is ever stored or shown). */
  async settings(): Promise<InboxSettings> {
    return this.repository.read(document => document.settings)
  }

  /**
   * Preview a settings change without writing: what the new retention policy
   * would delete if it were applied now. The page asks this before saving so a
   * shrink cannot silently delete read entries.
   */
  async previewSettings(args: SetSettingsArgs): Promise<SettingsPreview> {
    const document = this.repository.read(value => value)
    const next = applySettingsPatch(document.settings, args.patch ?? {})
    const pruned = applyRetention(document.entries, next, this.now())
    const kept = new Set(pruned.entries.map(entry => entry.id))
    const removed = document.entries.filter(entry => !kept.has(entry.id))
    return {
      settings: next,
      removedEntries: pruned.removed,
      removedBytes: removed.reduce((sum, entry) => sum + entryBytes(entry), 0),
    }
  }

  /** Change the settings and apply the new retention policy immediately. */
  async setSettings(args: SetSettingsArgs): Promise<InboxSettings> {
    const settings = await this.repository.mutate((document) => {
      const next = applySettingsPatch(document.settings, args.patch ?? {})
      return { document: { ...document, settings: next }, result: next }
    })
    await this.prune()
    return settings
  }

  /** Start one refresh task (or report the one already running). */
  async refresh(args: RefreshArgs, ctx: OperationContext): Promise<RefreshResult> {
    const scope = args.scope ?? 'all'
    if (scope !== 'all' && scope !== 'due') throw new AppError('invalid-args', 'scope must be all or due')
    const sourceId = args.sourceId === undefined || args.sourceId === '' ? undefined : args.sourceId
    return this.startRefresh(scope, sourceId, (descriptor, work) => ctx.startTask(descriptor, work))
  }

  /** Apply the retention policy now. */
  async prune(): Promise<number> {
    const now = this.now()
    return await this.repository.mutate((document) => {
      const pruned = applyRetention(document.entries, document.settings, now)
      if (pruned.removed === 0) return { document, result: 0 }
      return { document: { ...document, entries: pruned.entries }, result: pruned.removed }
    })
  }

  /** One entry or the runtime's `not-found` failure. */
  private entryOf(id: string): Entry {
    const entry = this.repository.read(document => document.entries.find(candidate => candidate.id === id))
    if (entry === undefined) throw new AppError('not-found', `inbox: no entry ${id}`)
    return entry
  }

  /** The pull options one read runs with. */
  private pullOptions(capabilities: CapabilityAccess, signal: AbortSignal): PullOptions {
    return {
      signal,
      capabilities,
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
      ...(this.http === undefined ? {} : { http: this.http }),
      // A production row without `applicationHttp` must not silently fall back
      // to the process-global fetch; only an explicitly injected transport
      // keeps the direct path (tests use that seam).
      allowFetchFallback: this.fetchImpl !== undefined,
    }
  }

  /** Arm the scheduler once; a running timer or a disabled tick is a no-op. */
  private arm(): void {
    if (this.tickMs <= 0 || this.timerStop !== undefined || this.appContext === undefined) return
    const context = this.appContext
    const controller = new AbortController()
    this.timerAbort = controller
    this.timerStop = runPeriodically({
      intervalMs: this.tickMs,
      signal: controller.signal,
      run: async () => { await this.tick(context) },
    })
  }

  /** Release the scheduler timer. */
  private disarm(): void {
    this.timerStop?.()
    this.timerStop = undefined
    this.timerAbort?.abort()
    this.timerAbort = undefined
  }

  /** One scheduler tick: refresh the sources that are due, unless a refresh is already running. */
  private async tick(context: AppContext): Promise<void> {
    await this.repository.ensureLoaded()
    if (this.refreshTaskId !== undefined) return
    this.startRefresh('due', undefined, (descriptor, work) => context.startTask(descriptor, work))
  }

  /** Start one refresh task over the selected sources. */
  private startRefresh(scope: RefreshScope, sourceId: string | undefined, startTask: StartTask): RefreshResult {
    if (this.refreshTaskId !== undefined) return { taskId: this.refreshTaskId, started: false, sources: 0 }
    const document = this.repository.read(value => value)
    if (sourceId !== undefined && !document.sources.some(source => source.id === sourceId)) {
      throw new AppError('not-found', `inbox: no source ${sourceId}`)
    }
    const targets = selectTargets(document.sources, scope, sourceId, this.now(), document.settings)
    if (targets.length === 0) return { started: false, sources: 0 }
    const handle = startTask(
      { kind: 'refresh', title: `刷新 ${String(targets.length)} 个来源` },
      async taskContext => await this.runRefresh(targets, taskContext),
    )
    this.refreshTaskId = handle.taskId
    void handle.done.then(() => { this.refreshTaskId = undefined })
    return { taskId: handle.taskId, started: true, sources: targets.length }
  }

  /** Run one refresh: each source read is independent, a failure backs that source off. */
  private async runRefresh(targets: readonly Source[], ctx: TaskContext): Promise<JsonValue> {
    const options = this.pullOptions(ctx.capabilities, ctx.signal)
    const summary: RefreshSummary = { sources: targets.length, added: 0, updated: 0, failed: 0, removed: 0 }
    for (const source of targets) {
      if (ctx.signal.aborted) throw abortError()
      ctx.reportProgress(`正在检查 ${source.name}`, { sourceId: source.id })
      try {
        const pull: PullResult = await this.flight.run(source.id, async () => await pullSource(source, options))
        const counts = await this.applyPull(source.id, pull)
        summary.added += counts.added
        summary.updated += counts.updated
        // Announce the entries this pull created, after their durable write. The
        // event carries references only; the subscriber re-reads the inbox.
        if (counts.created.length > 0) this.publishCreated(ctx, counts.created)
      } catch (error) {
        if (ctx.signal.aborted) throw abortError()
        summary.failed += 1
        await this.recordFailure(source.id, reasonOf(error))
      }
    }
    summary.removed = await this.prune()
    ctx.notifyChanged()
    return { ...summary } as unknown as JsonValue
  }

  /** Publish `entry.created` for the entries one write created; a busy pull is coalesced into one event. */
  private publishCreated(ctx: Pick<TaskContext, 'publishEvent'>, created: readonly Entry[]): void {
    const refs: ObjectRef[] = created.slice(0, MAX_EVENT_REFS).map(entry => ({ appId: INBOX_APP_ID, type: 'entry', id: entry.id }))
    ctx.publishEvent('entry.created', refs)
  }

  /** Persist one successful source read (entries and the source's health). */
  private async applyPull(sourceId: string, pull: PullResult): Promise<ApplyCounts> {
    const now = this.now()
    return await this.repository.mutate((document) => {
      const index = document.sources.findIndex(source => source.id === sourceId)
      /* v8 ignore next -- sources are never physically deleted */
      if (index < 0) return { document, result: { added: 0, updated: 0, created: [] } }
      const source = document.sources[index]!
      if (source.removed) return { document, result: { added: 0, updated: 0, created: [] } }
      const merged = upsertEntries(document.entries, source, pull.entries, now)
      const { lastError: _lastError, backoffUntil: _backoffUntil, ...healthy } = source
      // A new RSS subscription starts as its host; the first successful read can
      // give it the feed's real title. A name the human chose is never replaced.
      const discovered = pull.title === undefined ? '' : clampText(pull.title, MAX_SOURCE_NAME)
      const autoName = source.kind === 'rss'
        && discovered !== ''
        && (source.name === '' || source.name === hostOf(source.url))
      const nextSource: Source = {
        ...healthy,
        ...(autoName ? { name: discovered } : {}),
        lastCheckedAt: now,
        lastSuccessAt: now,
        failures: 0,
        updatedAt: now,
        version: source.version + 1,
      }
      const sources = [...document.sources]
      sources[index] = nextSource
      // `upsertEntries` appends new entries after the stored ones; updates keep their slot.
      const created = merged.entries.slice(document.entries.length)
      return { document: { ...document, sources, entries: merged.entries }, result: { added: merged.added, updated: merged.updated, created } }
    })
  }

  /** Persist one failed source read: the error and the next attempt's backoff. */
  private async recordFailure(sourceId: string, message: string): Promise<void> {
    const now = this.now()
    await this.repository.mutate((document) => {
      const index = document.sources.findIndex(source => source.id === sourceId)
      /* v8 ignore next -- sources are never physically deleted */
      if (index < 0) return { document, result: undefined }
      const source = document.sources[index]!
      if (source.removed) return { document, result: undefined }
      const failures = source.failures + 1
      const next: Source = {
        ...source,
        lastCheckedAt: now,
        lastError: clampText(message, MAX_ERROR) || 'the read failed',
        failures,
        /* v8 ignore next -- source interval and family fallback are both valid; branch accounting splits the ternary */
        backoffUntil: now + backoffMs(failures, effectiveInterval(source, document.settings)),
        updatedAt: now,
        version: source.version + 1,
      }
      const sources = [...document.sources]
      sources[index] = next
      return { document: { ...document, sources }, result: undefined }
    })
  }
}

// ── declaration ──────────────────────────────────────────────────────────────

const str = (description: string, required = false): ValueSchemaSpec & { required?: true } =>
  required ? { type: 'string', description, required: true } : { type: 'string', description }
const int = (description: string, required = false): ValueSchemaSpec & { required?: true } =>
  required ? { type: 'integer', description, required: true } : { type: 'integer', description }
const bool = (description: string): ValueSchemaSpec => ({ type: 'boolean', description })
const strList = (description: string): ValueSchemaSpec & { required?: true } =>
  ({ type: 'array', items: { type: 'string' }, description, required: true })
const loose = (description: string): ValueSchemaSpec => ({ type: 'json', description })
const resultOf = (description: string): ValueSchemaSpec => ({ type: 'object', additionalProperties: true, description })

/** The peer applications this application may call, and the exact operations it uses. */
export const INBOX_CALLS: readonly AppCall[] = [
  { app: 'todo', ops: ['createTask'] },
  { app: 'notes', ops: ['create'] },
]

/** The platform capabilities the declaration states. */
export const INBOX_CAPABILITIES: readonly string[] = ['storage', 'network']

/** One operation declaration; the wrapper loads the document and announces a write. */
function operation(
  app: InboxApp,
  description: string,
  params: ParameterSchemaSpec,
  effect: 'read' | 'write',
  ai: 'open' | 'confirm' | 'closed',
  run: (args: never, ctx: OperationContext) => unknown,
  peers: 'open' | 'closed' = 'open',
) {
  return {
    description,
    params,
    result: resultOf('Operation result'),
    effect,
    exposure: { ai, peers },
    execute: async (args: JsonValue, ctx: OperationContext) => {
      await app.ensureLoaded()
      const value = await run(args as never, ctx)
      if (effect === 'write') ctx.notifyChanged()
      return value as never
    },
  }
}

/**
 * Build the inbox declaration.
 * @param app - the application instance the operations call.
 * @returns the declaration the runtime registers.
 */
export function inboxDeclaration(app: InboxApp): AppDeclaration {
  const read = (description: string, params: ParameterSchemaSpec, run: (args: never, ctx: OperationContext) => unknown, peers: 'open' | 'closed' = 'open') =>
    operation(app, description, params, 'read', 'open', run, peers)
  const write = (description: string, params: ParameterSchemaSpec, ai: 'open' | 'confirm' | 'closed', run: (args: never, ctx: OperationContext) => unknown, peers: 'open' | 'closed' = 'open') =>
    operation(app, description, params, 'write', ai, run, peers)
  return {
    id: INBOX_APP_ID,
    name: INBOX_NAME,
    description: INBOX_DESCRIPTION,
    version: INBOX_VERSION,
    generation: 2,
    data: {
      kind: 'unified',
      namespace: 'inbox',
      schemaVersion: INBOX_SCHEMA_VERSION,
    },
    events: {
      'entry.created': {
        description: 'New entries were written into the inbox; the event carries entry references only',
        subscription: 'open',
      },
    },
    capabilities: [...INBOX_CAPABILITIES],
    calls: INBOX_CALLS,
    start: async (ctx) => { await app.start(ctx) },
    health: async () => {
      const { health } = await app.listSources({})
      if (health.error > 0) return { status: 'degraded' as const, reason: `${String(health.error)} inbox source(s) failed` }
      return { status: 'ok' as const }
    },
    stop: () => { app.stop() },
    pause: () => { app.pause() },
    resume: () => { app.resume() },
    reload: async () => { await app.reload() },
    ops: {
      listEntries: read('List inbox or saved entries (summaries only)', {
        view: str('inbox or saved'),
        unread: bool('Only unread entries'),
        newOnly: bool('Only unseen ("new") entries'),
        sourceId: str('Filter by source id'),
        kind: str('Filter by entry kind: github, rss or manual'),
        search: str('Search title, summary, body and source name'),
        offset: int('Paging offset'),
        limit: int(`Page size (${String(DEFAULT_PAGE_LIMIT)} by default)`),
      }, (args: ListEntriesArgs) => app.listEntries(args)) as never,
      listGroups: read('List inbox entries grouped by source, newest few per group', {
        view: str('inbox or saved'),
        unread: bool('Only unread entries'),
        newOnly: bool('Only unseen ("new") entries'),
        sourceId: str('Filter by source id'),
        kind: str('Filter by entry kind: github, rss or manual'),
        search: str('Search title, summary, body and source name'),
        perGroup: int('Entries per group (3 by default, at most 10)'),
      }, (args: ListGroupsArgs) => app.listGroups(args)) as never,
      getEntry: read('Read one entry with its full body', { id: str('Entry id', true) }, (args: { id: string }) => app.getEntry(args)) as never,
      markRead: write('Mark entries read or unread', { ids: strList('Entry ids'), read: bool('True to mark read, false to mark unread') }, 'open', (args: MarkArgs & { read: boolean }) => app.markRead(args)) as never,
      markSourceRead: write('Mark every entry of one source read or unread', { sourceId: str('Source id', true), read: bool('True to mark read, false to mark unread') }, 'confirm', (args: MarkSourceReadArgs) => app.markSourceRead(args), 'closed') as never,
      markSeen: write('Clear the new flag on entries', { ids: strList('Entry ids') }, 'open', (args: MarkArgs) => app.markSeen(args)) as never,
      favorite: write('Favorite or unfavorite one entry', { id: str('Entry id', true), favorite: bool('True to favorite') }, 'open', (args: FavoriteArgs) => app.favorite(args)) as never,
      saveToTask: write('Create the task one entry owns', { id: str('Entry id', true) }, 'confirm', (args: SaveToTaskArgs, ctx: OperationContext) => app.saveToTask(args, ctx)) as never,
      reconvertToTask: write('Create a new task after the stored task was deleted', { id: str('Entry id', true) }, 'closed', (args: SaveToTaskArgs, ctx: OperationContext) => app.reconvertToTask(args, ctx), 'closed') as never,
      saveToNote: write('Save one entry as a note', { id: str('Entry id', true) }, 'confirm', (args: SaveToNoteArgs, ctx: OperationContext) => app.saveToNote(args, ctx)) as never,
      reconvertToNote: write('Save a new note after the stored note was deleted', { id: str('Entry id', true) }, 'closed', (args: SaveToNoteArgs, ctx: OperationContext) => app.reconvertToNote(args, ctx), 'closed') as never,
      refresh: write('Refresh sources in the background', { scope: str('all (manual) or due (scheduled)'), sourceId: str('Refresh one source') }, 'confirm', (args: RefreshArgs, ctx: OperationContext) => app.refresh(args, ctx)) as never,
      addManualLink: write('Add a manual link to the inbox', { url: str('The link URL', true), title: str('Optional title') }, 'confirm', (args: AddManualLinkArgs, ctx: OperationContext) => app.addManualLink(args, ctx)) as never,
      listSources: read('List sources with health and entry counts', { includeRemoved: bool('Include removed sources') }, (args: { includeRemoved?: boolean }) => app.listSources(args)) as never,
      addSource: write('Add one source', {
        kind: str('github or rss', true),
        url: str('Source URL (a repository URL for GitHub)'),
        name: str('Display name'),
        repo: str('GitHub owner/repo'),
        intervalMs: int('Refresh interval in ms (0 = follow the settings)'),
      }, 'closed', (args: AddSourceArgs) => app.addSource(args), 'closed') as never,
      updateSource: write('Edit, enable or pause one source', {
        id: str('Source id', true),
        expectedVersion: int('Expected source version', true),
        patch: loose('Fields to change'),
      }, 'closed', (args: UpdateSourceArgs) => app.updateSource(args), 'closed') as never,
      removeSource: write('Remove one source (its entries stay)', { id: str('Source id', true) }, 'closed', (args: { id: string }) => app.removeSource(args), 'closed') as never,
      importOpml: write('Import RSS/Atom feeds from an OPML document', { xml: str('The OPML document', true) }, 'closed', (args: { xml: string }) => app.importOpml(args), 'closed') as never,
      clearEntries: write('Delete all entries, or one source\'s entries', { sourceId: str('Only this source\'s entries') }, 'closed', (args: ClearEntriesArgs) => app.clearEntries(args), 'closed') as never,
      settings: read('Read the inbox settings', {}, () => app.settings(), 'closed') as never,
      previewSettings: read('Preview entries a settings change would prune', {
        patch: loose('Settings fields to change'),
      }, (args: SetSettingsArgs) => app.previewSettings(args), 'closed') as never,
      setSettings: write('Change the inbox settings', {
        patch: loose('Settings fields to change'),
      }, 'closed', (args: SetSettingsArgs) => app.setSettings(args), 'closed') as never,
    },
  }
}
