/**
 * The home application: a dashboard that reads the other applications' current
 * state through their public operations and keeps a small log of the change
 * notices it received. The two sources are deliberately different — a card is
 * a point-in-time read, the activity log is a record of notices — and the page
 * shows both so the difference is visible.
 * @module @matrix1001/dsh-application-harness-home/app
 */

import type {
  AppCall, AppContext, AppDeclaration, AppEvent, CallOutcome, OperationContext,
} from '@matrix1001/dsh-application-harness-runtime'
import type { HomeRepository } from './repository.ts'
import {
  activityFrom, appendActivity, cardFailure, HOME_APP_ID, HOME_DESCRIPTION, HOME_NAME, HOME_NAMESPACE, HOME_SCHEMA_VERSION, HOME_VERSION, localDate, PREVIEW_ITEMS,
} from './model.ts'
import type { Activity, ActivityRef, CardFailure } from './model.ts'

/** The publisher this application follows. */
export const HOME_EVENT_PUBLISHER = 'inbox'
/** The event this application follows. */
export const HOME_EVENT_TYPE = 'entry.created'

/** The cross-application reads the overview aggregates. */
export const HOME_CALLS: readonly AppCall[] = [
  { app: 'inbox', ops: ['listGroups'] },
  { app: 'todo', ops: ['listTasks'] },
  { app: 'notes', ops: ['list'] },
]

/** One entry previewed in a card. */
export interface InboxPreview { readonly id: string; readonly title: string; readonly at?: number }
/** One task previewed in a card. */
export interface TodoPreview { readonly id: string; readonly title: string; readonly dueDate?: string }
/** One note previewed in a card. */
export interface NotePreview { readonly id: string; readonly title: string; readonly at?: number }

/** The inbox card: its counts and the newest entries. */
export interface InboxCard {
  readonly available: boolean
  /** Why the read failed, when `available` is false. */
  readonly failure?: CardFailure
  readonly unseen?: number
  readonly unread?: number
  readonly saved?: number
  readonly recent?: readonly InboxPreview[]
}
/** The todo card: its counts and the most urgent tasks. */
export interface TodoCard {
  readonly available: boolean
  /** Why the read failed, when `available` is false. */
  readonly failure?: CardFailure
  readonly open?: number
  readonly today?: number
  readonly overdue?: number
  readonly recent?: readonly TodoPreview[]
}
/** The notes card: its total and the most recently edited notes. */
export interface NotesCard {
  readonly available: boolean
  /** Why the read failed, when `available` is false. */
  readonly failure?: CardFailure
  readonly total?: number
  readonly recent?: readonly NotePreview[]
}
/** Everything the page needs for its snapshot cards. */
export interface Overview {
  readonly generatedAt: number
  readonly inbox: InboxCard
  readonly todo: TodoCard
  readonly notes: NotesCard
}

/** One application's answer to the dashboard. */
export interface HomeAppOptions {
  repository: HomeRepository
  attach?: (access: AppContext['capabilities']) => void
  now?: () => number
}

/** Read one untrusted value as a plain record. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Read one untrusted value as a list of plain records (non-records are dropped). */
function recordsOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
    : []
}

/** Read one untrusted non-negative count. */
function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Read one untrusted non-empty text. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Turn one non-success peer outcome into the card's bounded failure. */
function failureOf(outcome: Exclude<CallOutcome, { readonly status: 'success' }>): CardFailure {
  // `unknown` means the platform cannot tell what happened: report the broken
  // carrier instead of inventing a business code.
  if (outcome.status === 'unknown') return { kind: 'transport' }
  return cardFailure(outcome.error?.code, outcome.error?.message)
}

/** The home application. */
export class HomeApp {
  private readonly repository: HomeRepository
  private readonly attach: ((access: AppContext['capabilities']) => void) | undefined
  private readonly now: () => number

  /** @param options - the repository, the capability door and the clock. */
  constructor(options: HomeAppOptions) {
    this.repository = options.repository
    this.attach = options.attach
    this.now = options.now ?? (() => Date.now())
  }

  /** Load the durable document (the declaration's wrapper calls it before every operation). */
  async ensureLoaded(): Promise<void> {
    await this.repository.ensureLoaded()
  }

  /** Re-read the document after an external import. */
  async reload(): Promise<void> {
    await this.repository.load()
  }

  /**
   * Record the subscription. The first operation loads the document: start must
   * not touch storage before the human approves the storage capability, or the
   * application would show as failed and could never recover. A publisher that
   * is not installed yet is deferred by the runtime, so the page still renders.
   */
  async start(ctx: AppContext): Promise<void> {
    this.attach?.(ctx.capabilities)
    await ctx.subscribe(HOME_EVENT_PUBLISHER, HOME_EVENT_TYPE, async (event) => {
      const recorded = await this.record(event)
      if (recorded) ctx.notifyChanged()
    })
  }

  /** Append one received notice; a repeated event id is ignored. */
  private async record(event: AppEvent): Promise<boolean> {
    const at = Number.isFinite(Date.parse(event.occurredAt)) ? Date.parse(event.occurredAt) : this.now()
    const refs: ActivityRef[] = (event.refs ?? []).map(ref => ({ type: ref.type, id: ref.id }))
    const activity = activityFrom(event.appId, event.type, event.eventId, at, refs)
    return await this.repository.mutate((document) => {
      const next = appendActivity(document, activity)
      return { document: next, result: next !== document }
    })
  }

  /** The recent activity this application received, newest first. */
  async activity(): Promise<{ readonly activities: readonly Activity[] }> {
    return this.repository.read(document => ({ activities: document.activities }))
  }

  /** Read every card at the same moment; a failing section degrades on its own. */
  async overview(ctx: OperationContext): Promise<Overview> {
    const [inbox, todo, notes] = await Promise.all([
      this.inboxCard(ctx),
      this.todoCard(ctx),
      this.notesCard(ctx),
    ])
    return { generatedAt: this.now(), inbox, todo, notes }
  }

  /** The inbox card: a grouped read gives every source a slice of the preview. */
  private async inboxCard(ctx: OperationContext): Promise<InboxCard> {
    let grouped: CallOutcome
    try {
      grouped = await ctx.call('inbox', 'listGroups', { view: 'inbox', perGroup: PREVIEW_ITEMS })
    } catch {
      // A rejected call never produced an outcome; its error may carry a
      // stack, so the card reports only that the answer did not arrive.
      return { available: false, failure: { kind: 'transport' } }
    }
    if (grouped.status !== 'success') return { available: false, failure: failureOf(grouped) }
    const result = recordOf(grouped.result)
    const counts = recordOf(result?.['counts'])
    const groups = recordsOf(result?.['groups']).filter(group => group['removed'] !== true)
    const recent: InboxPreview[] = []
    const slots = groups.map(group => recordsOf(group['entries']))
    for (let index = 0; index < PREVIEW_ITEMS && recent.length < PREVIEW_ITEMS; index += 1) {
      for (const entries of slots) {
        const entry = entries[index]
        if (entry === undefined) continue
        const id = textOf(entry['id'])
        const title = textOf(entry['title'])
        if (id === undefined || title === undefined) continue
        const at = countOf(entry['publishedAt']) ?? countOf(entry['fetchedAt'])
        recent.push({ id, title, ...(at === undefined ? {} : { at }) })
        if (recent.length >= PREVIEW_ITEMS) break
      }
    }
    const unseen = countOf(counts?.['unseen'])
    const unread = countOf(counts?.['unread'])
    const saved = countOf(counts?.['saved'])
    return {
      available: true,
      ...(unseen === undefined ? {} : { unseen }),
      ...(unread === undefined ? {} : { unread }),
      ...(saved === undefined ? {} : { saved }),
      recent,
    }
  }

  /** The todo card: counts derived from the task list the todo app already sorts. */
  private async todoCard(ctx: OperationContext): Promise<TodoCard> {
    let outcome: CallOutcome
    try {
      outcome = await ctx.call('todo', 'listTasks', { includeCompleted: true })
    } catch {
      return { available: false, failure: { kind: 'transport' } }
    }
    if (outcome.status !== 'success') return { available: false, failure: failureOf(outcome) }
    const today = localDate(this.now())
    let open = 0
    let dueToday = 0
    let overdue = 0
    const recent: TodoPreview[] = []
    for (const task of recordsOf(outcome.result)) {
      const completed = task['completedAt']
      if (typeof completed === 'number' && completed > 0) continue
      open += 1
      const dueDate = textOf(task['dueDate'])
      if (dueDate !== undefined) {
        if (dueDate === today) dueToday += 1
        else if (dueDate < today) overdue += 1
      }
      const id = textOf(task['id'])
      const title = textOf(task['title'])
      if (id !== undefined && title !== undefined && recent.length < PREVIEW_ITEMS) {
        recent.push({ id, title, ...(dueDate === undefined ? {} : { dueDate }) })
      }
    }
    return { available: true, open, today: dueToday, overdue, recent }
  }

  /** The notes card: the total and the first notes the notes app returns (pinned first). */
  private async notesCard(ctx: OperationContext): Promise<NotesCard> {
    let outcome: CallOutcome
    try {
      outcome = await ctx.call('notes', 'list', {})
    } catch {
      return { available: false, failure: { kind: 'transport' } }
    }
    if (outcome.status !== 'success') return { available: false, failure: failureOf(outcome) }
    const notes = recordsOf(outcome.result)
    const recent = notes.slice(0, PREVIEW_ITEMS).flatMap((note) => {
      const id = textOf(note['id'])
      const title = textOf(note['title'])
      if (id === undefined || title === undefined) return []
      const at = countOf(note['updatedAt'])
      return [{ id, title, ...(at === undefined ? {} : { at }) }]
    })
    return { available: true, total: notes.length, recent }
  }
}

/**
 * Build the home declaration.
 * @param app - the application instance the operations call.
 * @returns the declaration the runtime registers.
 */
export function homeDeclaration(app: HomeApp): AppDeclaration {
  const read = (description: string, params: Record<string, unknown>, run: (args: never, ctx: OperationContext) => Promise<unknown>) => ({
    description,
    params,
    result: { type: 'json' as const, description: 'Operation result' },
    effect: 'read' as const,
    // The page and AI are the consumers; peer applications have no business here.
    exposure: { ai: 'open' as const, peers: 'closed' as const },
    execute: async (args: unknown, ctx: OperationContext) => {
      await app.ensureLoaded()
      return await run(args as never, ctx)
    },
  })
  return {
    id: HOME_APP_ID,
    name: HOME_NAME,
    description: HOME_DESCRIPTION,
    version: HOME_VERSION,
    generation: 2,
    data: { kind: 'unified', namespace: HOME_NAMESPACE, schemaVersion: HOME_SCHEMA_VERSION },
    capabilities: ['storage'],
    calls: [...HOME_CALLS],
    subscriptions: [{ appId: HOME_EVENT_PUBLISHER, type: HOME_EVENT_TYPE }],
    start: async (ctx) => { await app.start(ctx) },
    reload: async () => { await app.reload() },
    ops: {
      overview: read('Read the snapshot cards this page shows', {}, async (_args: never, ctx: OperationContext) => await app.overview(ctx)) as never,
      activity: read('Read the change notices this page received', {}, async () => await app.activity()) as never,
    },
  }
}
