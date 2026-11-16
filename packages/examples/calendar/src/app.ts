/**
 * The calendar application: events over one gated SQLite document. The page
 * and the agent use the same public operations; the only cross-application
 * read is the read-only task-deadline overlay proxied through `tasks`.
 * @module
 */

import { randomUUID } from 'node:crypto'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { AppContext, AppDeclaration, OperationContext } from '@matrix1001/dsh-application-harness-runtime'
import { GatedStore } from '@matrix1001/dsh-application-harness-store'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** The palette an event may use. Display only; there is no category model. */
export type EventColor = 'blue' | 'green' | 'amber' | 'purple' | 'gray'

/** When an event happens: UTC instants plus the event's IANA zone, or a half-open civil range. */
export type EventTime =
  | { kind: 'timed'; start: string; end: string; timeZone: string }
  | { kind: 'allDay'; startDate: string; endDateExclusive: string }

/** One calendar event as stored. */
export interface CalendarEvent {
  id: string
  title: string
  description: string
  location: string
  time: EventTime
  color: EventColor
  createdAt: number
  updatedAt: number
  version: number
  deletedAt?: number
}

/** The whole durable document: one unified-store document per namespace. */
export interface CalendarDocument {
  schemaVersion: 1
  events: CalendarEvent[]
}

/** One read-only task deadline in the overlay. */
export interface TaskDeadline {
  id: string
  title: string
  dueDate: string
}

/** The task overlay result; `available: false` degrades without blocking the calendar. */
export interface TaskDeadlinesResult {
  tasks: TaskDeadline[]
  available: boolean
}

const SCHEMA_VERSION = 1
const MAX_EVENTS = 4000
const MAX_TITLE = 200
const MAX_DESCRIPTION = 10_000
const MAX_LOCATION = 200
const COLORS: readonly EventColor[] = ['blue', 'green', 'amber', 'purple', 'gray']
const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/u

function empty(): CalendarDocument {
  return { schemaVersion: SCHEMA_VERSION, events: [] }
}

function copyEvent(event: CalendarEvent): CalendarEvent {
  return { ...event, time: { ...event.time } }
}

function live(event: CalendarEvent): boolean {
  return event.deletedAt === undefined
}

function assertTitle(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('invalid-args', 'title must be a string')
  const title = value.trim()
  if (title === '' || title.length > MAX_TITLE) {
    throw new AppError('invalid-args', `title must be 1..${String(MAX_TITLE)} characters`)
  }
  return title
}

function assertDescription(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('invalid-args', 'description must be a string')
  if (value.length > MAX_DESCRIPTION) {
    throw new AppError('invalid-args', `description must be at most ${String(MAX_DESCRIPTION)} characters`)
  }
  return value
}

function assertLocation(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('invalid-args', 'location must be a string')
  const location = value.trim()
  if (location.length > MAX_LOCATION) {
    throw new AppError('invalid-args', `location must be at most ${String(MAX_LOCATION)} characters`)
  }
  return location
}

function assertColor(value: unknown): EventColor {
  if (typeof value !== 'string' || !COLORS.includes(value as EventColor)) {
    throw new AppError('invalid-args', `color must be one of ${COLORS.join(', ')}`)
  }
  return value as EventColor
}

function civilParts(value: unknown, field: string): { year: number; month: number; day: number } {
  if (typeof value !== 'string') throw new AppError('invalid-args', `${field} must be a date string`)
  const match = CIVIL_DATE.exec(value)
  if (match === null) throw new AppError('invalid-args', `${field} must be YYYY-MM-DD`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new AppError('invalid-args', `${field} must be an existing civil date`)
  }
  return { year, month, day }
}

function assertCivilDate(value: unknown, field: string): string {
  civilParts(value, field)
  return value as string
}

function assertInstant(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) {
    throw new AppError('invalid-args', `${field} must be a UTC instant`)
  }
  const millis = Date.parse(value)
  if (Number.isNaN(millis)) throw new AppError('invalid-args', `${field} must be an existing instant`)
  if (new Date(millis).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new AppError('invalid-args', `${field} must be an existing instant`)
  }
  return new Date(millis).toISOString()
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached !== undefined) return cached
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  formatters.set(timeZone, created)
  return created
}

function assertTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('invalid-args', 'timeZone must be an IANA zone name')
  }
  try {
    formatterFor(value)
  } catch {
    throw new AppError('invalid-args', `unknown IANA time zone ${value}`)
  }
  return value
}

function zoneOffsetAt(timeZone: string, instant: number): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant))
  const part = (type: string): string => parts.find(candidate => candidate.type === type)!.value
  const local = Date.UTC(
    Number(part('year')),
    Number(part('month')) - 1,
    Number(part('day')),
    Number(part('hour')),
    Number(part('minute')),
    Number(part('second')),
  )
  return local - Math.floor(instant / 1000) * 1000
}

/** The first instant of one civil date in a zone (DST transitions included). */
function zonedMidnight(dateKey: string, timeZone: string): number {
  const match = CIVIL_DATE.exec(dateKey)!
  const guess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const first = guess - zoneOffsetAt(timeZone, guess)
  return guess - zoneOffsetAt(timeZone, first)
}

function assertTime(value: unknown): EventTime {
  if (typeof value !== 'object' || value === null) throw new AppError('invalid-args', 'time must be an object')
  const time = value as Record<string, unknown>
  if (time.kind === 'timed') {
    const start = assertInstant(time.start, 'time.start')
    const end = assertInstant(time.end, 'time.end')
    const timeZone = assertTimeZone(time.timeZone)
    if (end <= start) throw new AppError('invalid-args', 'time.end must be after time.start')
    return { kind: 'timed', start, end, timeZone }
  }
  if (time.kind === 'allDay') {
    const startDate = assertCivilDate(time.startDate, 'time.startDate')
    const endDateExclusive = assertCivilDate(time.endDateExclusive, 'time.endDateExclusive')
    if (endDateExclusive <= startDate) {
      throw new AppError('invalid-args', 'time.endDateExclusive must be after time.startDate')
    }
    return { kind: 'allDay', startDate, endDateExclusive }
  }
  throw new AppError('invalid-args', 'time.kind must be timed or allDay')
}

interface EventRange { fromDate: string; toDate: string; timeZone: string }

function eventRange(input: { fromDate: string; toDate: string; timeZone: string }): EventRange {
  const fromDate = assertCivilDate(input.fromDate, 'fromDate')
  const toDate = assertCivilDate(input.toDate, 'toDate')
  const timeZone = assertTimeZone(input.timeZone)
  if (toDate <= fromDate) throw new AppError('invalid-args', 'toDate must be after fromDate')
  return { fromDate, toDate, timeZone }
}

function dayRange(input: { fromDate: string; toDate: string }): { fromDate: string; toDate: string } {
  const fromDate = assertCivilDate(input.fromDate, 'fromDate')
  const toDate = assertCivilDate(input.toDate, 'toDate')
  if (toDate < fromDate) throw new AppError('invalid-args', 'toDate must not be before fromDate')
  return { fromDate, toDate }
}

/** Sort key: all-day events first, then timed events by start, id breaking ties. */
function sortKey(event: CalendarEvent): string {
  return event.time.kind === 'allDay'
    ? `0|${event.time.startDate}|${event.time.endDateExclusive}|${event.id}`
    : `1|${event.time.start}|${event.time.end}|${event.id}`
}

function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  return sortKey(a).localeCompare(sortKey(b))
}

/** Whether a stored event overlaps a half-open civil range in the query zone. */
function overlaps(event: CalendarEvent, range: EventRange): boolean {
  if (event.time.kind === 'allDay') {
    return event.time.startDate < range.toDate && event.time.endDateExclusive > range.fromDate
  }
  const rangeStart = zonedMidnight(range.fromDate, range.timeZone)
  const rangeEnd = zonedMidnight(range.toDate, range.timeZone)
  return Date.parse(event.time.end) > rangeStart && Date.parse(event.time.start) < rangeEnd
}

function deadlineOf(value: unknown): TaskDeadline | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const task = value as Record<string, unknown>
  if (typeof task.id !== 'string') return undefined
  if (typeof task.title !== 'string') return undefined
  if (typeof task.dueDate !== 'string') return undefined
  return { id: task.id, title: task.title, dueDate: task.dueDate }
}

/** The calendar repository: one document, one serialized writer, capability-gated. */
export class CalendarRepository {
  private readonly store: GatedStore
  private document: CalendarDocument = empty()
  private revision: number | undefined
  private loaded = false
  private queue: Promise<unknown> = Promise.resolve()

  constructor(store: GatedStore) { this.store = store }

  /** Attach the application's capability door. */
  attach(access: AppContext['capabilities']): void { this.store.attach(access) }

  /** Load the durable document if this process has not done so yet. */
  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  /** Load the durable document; a missing document is an empty first run. A failed reload leaves no cache. */
  async load(): Promise<void> {
    this.document = empty()
    this.revision = undefined
    this.loaded = false
    const stored = await this.store.documents.get<CalendarDocument>('document')
    if (stored === undefined) { this.loaded = true; return }
    if (stored.value.schemaVersion !== SCHEMA_VERSION) {
      throw new AppError('storage-corrupt', 'calendar: unsupported document schema')
    }
    if (!Array.isArray(stored.value.events)) {
      throw new AppError('storage-corrupt', 'calendar: malformed events array')
    }
    this.document = stored.value
    this.revision = stored.revision
    this.loaded = true
  }

  /** Every event, including soft-deleted, for page citations. */
  state(): CalendarEvent[] {
    return this.document.events.map(copyEvent)
  }

  /** Live events overlapping a civil range, all-day first then by start. */
  list(input: { fromDate: string; toDate: string; timeZone: string }): CalendarEvent[] {
    const range = eventRange(input)
    return this.document.events
      .filter(live)
      .filter(event => overlaps(event, range))
      .map(copyEvent)
      .sort(compareEvents)
  }

  /** One event, including a soft-deleted one (so undo can read it). */
  get(id: string): CalendarEvent {
    const event = this.document.events.find(candidate => candidate.id === id)
    if (event === undefined) throw new AppError('not-found', `calendar: no event ${id}`)
    return copyEvent(event)
  }

  /** Read-only task deadlines proxied through `tasks`; unavailable degrades to empty. */
  async listTaskDeadlines(input: { fromDate: string; toDate: string }, ctx: OperationContext): Promise<TaskDeadlinesResult> {
    const range = dayRange(input)
    try {
      const outcome = await ctx.call('tasks', 'listTasks', { dueFrom: range.fromDate, dueTo: range.toDate })
      if (outcome.status !== 'success') return { tasks: [], available: false }
      if (!Array.isArray(outcome.result)) return { tasks: [], available: false }
      const tasks = outcome.result
        .map(deadlineOf)
        .filter((task): task is TaskDeadline => task !== undefined)
      return { tasks, available: true }
    } catch {
      return { tasks: [], available: false }
    }
  }

  /** Create one event. */
  async create(input: {
    title: string
    time: EventTime
    description?: string
    location?: string
    color?: EventColor
  }, ctx: OperationContext): Promise<CalendarEvent> {
    await this.ensureLoaded()
    const title = assertTitle(input.title)
    const description = input.description === undefined ? '' : assertDescription(input.description)
    const location = input.location === undefined ? '' : assertLocation(input.location)
    const time = assertTime(input.time)
    const color = input.color === undefined ? 'blue' : assertColor(input.color)
    const now = Date.now()
    let created: CalendarEvent | undefined
    await this.write((document) => {
      if (document.events.length >= MAX_EVENTS) {
        throw new AppError('limit-reached', `calendar: at most ${String(MAX_EVENTS)} events are supported`)
      }
      created = {
        id: `e_${randomUUID()}`,
        title,
        description,
        location,
        time,
        color,
        createdAt: now,
        updatedAt: now,
        version: 1,
      }
      return { ...document, events: [...document.events, created] }
    })
    ctx.notifyChanged()
    return copyEvent(created!)
  }

  /** Update one event with optimistic concurrency. */
  async update(id: string, expectedVersion: number, patch: {
    title?: string
    description?: string
    location?: string
    time?: EventTime
    color?: EventColor
  }, ctx: OperationContext): Promise<CalendarEvent> {
    await this.ensureLoaded()
    let updated: CalendarEvent | undefined
    await this.write((document) => {
      const index = document.events.findIndex(event => event.id === id)
      if (index < 0) throw new AppError('not-found', `calendar: no event ${id}`)
      const current = document.events[index]!
      if (!live(current)) throw new AppError('not-found', `calendar: no live event ${id}`)
      if (current.version !== expectedVersion) {
        throw new AppError('stale-version', 'calendar: the event changed; reload and retry')
      }
      updated = {
        ...current,
        title: patch.title === undefined ? current.title : assertTitle(patch.title),
        description: patch.description === undefined ? current.description : assertDescription(patch.description),
        location: patch.location === undefined ? current.location : assertLocation(patch.location),
        time: patch.time === undefined ? current.time : assertTime(patch.time),
        color: patch.color === undefined ? current.color : assertColor(patch.color),
        updatedAt: Date.now(),
        version: current.version + 1,
      }
      const events = [...document.events]
      events[index] = updated
      return { ...document, events }
    })
    ctx.notifyChanged()
    return copyEvent(updated!)
  }

  /** Soft-delete one event; deleting an already-deleted event is a no-op. */
  async remove(id: string, ctx: OperationContext): Promise<CalendarEvent> {
    await this.ensureLoaded()
    let removed: CalendarEvent | undefined
    await this.write((document) => {
      const index = document.events.findIndex(event => event.id === id)
      if (index < 0) throw new AppError('not-found', `calendar: no event ${id}`)
      const current = document.events[index]!
      if (!live(current)) { removed = current; return document }
      const now = Date.now()
      removed = { ...current, deletedAt: now, updatedAt: now, version: current.version + 1 }
      const events = [...document.events]
      events[index] = removed
      return { ...document, events }
    })
    ctx.notifyChanged()
    return copyEvent(removed!)
  }

  /** Restore one soft-deleted event; restoring a live event is a no-op. */
  async restore(id: string, ctx: OperationContext): Promise<CalendarEvent> {
    await this.ensureLoaded()
    let restored: CalendarEvent | undefined
    await this.write((document) => {
      const index = document.events.findIndex(event => event.id === id)
      if (index < 0) throw new AppError('not-found', `calendar: no event ${id}`)
      const current = document.events[index]!
      if (current.deletedAt === undefined) { restored = current; return document }
      const { deletedAt: _deletedAt, ...liveEvent } = current
      restored = { ...liveEvent, updatedAt: Date.now(), version: current.version + 1 }
      const events = [...document.events]
      events[index] = restored
      return { ...document, events }
    })
    ctx.notifyChanged()
    return copyEvent(restored!)
  }

  private async write(change: (document: CalendarDocument) => CalendarDocument): Promise<void> {
    const run = async (): Promise<void> => {
      const next = change(this.document)
      const stored = await this.store.documents.put('document', next, {
        schemaVersion: SCHEMA_VERSION,
        ...(this.revision === undefined ? {} : { expectedRevision: this.revision }),
      })
      this.document = stored.value
      this.revision = stored.revision
    }
    const pending = this.queue.then(run, run)
    this.queue = pending.then(() => undefined, () => undefined)
    await pending
  }
}

const str = (description: string, required = false) => required ? { type: 'string' as const, description, required: true as const } : { type: 'string' as const, description }

/**
 * Build the calendar declaration.
 * @param repository - the durable repository.
 * @returns the declaration the runtime registers.
 */
export function CalendarDeclaration(repository: CalendarRepository): AppDeclaration {
  const read = (description: string, params: Record<string, unknown>, run: (args: never, ctx: OperationContext) => unknown) => ({
    description,
    params,
    result: { type: 'json' as const, description: 'Operation result' },
    effect: 'read' as const,
    exposure: { ai: 'open' as const, peers: 'open' as const },
    execute: async (args: unknown, ctx: OperationContext) => {
      await repository.ensureLoaded()
      return run(args as never, ctx) as never
    },
  })
  const write = (description: string, params: Record<string, unknown>, run: (args: never, ctx: OperationContext) => unknown) => ({
    description,
    params,
    result: { type: 'json' as const, description: 'Operation result' },
    effect: 'write' as const,
    exposure: { ai: 'confirm' as const, peers: 'open' as const },
    execute: async (args: unknown, ctx: OperationContext) => {
      await repository.ensureLoaded()
      return run(args as never, ctx) as never
    },
  })
  return {
    id: 'calendar',
    name: '日历',
    description: '事件、月视图、议程与任务截止。',
    version: '0.2.0-rc.1',
    generation: 2,
    data: { kind: 'unified', namespace: 'calendar', schemaVersion: SCHEMA_VERSION },
    capabilities: ['storage'],
    calls: [{ app: 'tasks', ops: ['listTasks'] }],
    start: async (ctx) => {
      repository.attach(ctx.capabilities)
    },
    reload: async () => { await repository.load() },
    ops: {
      contextState: read('Read the current events for page citations', {}, () => ({ events: repository.state() })) as never,
      listEvents: read('List events overlapping a civil date range', {
        fromDate: str('First local date (YYYY-MM-DD, inclusive)', true),
        toDate: str('Last local date (YYYY-MM-DD, exclusive)', true),
        timeZone: str('IANA time zone of the date boundaries', true),
      }, (args: { fromDate: string; toDate: string; timeZone: string }) => {
        const events = repository.list(args)
        return { events, total: events.length }
      }) as never,
      getEvent: read('Read one event, including a soft-deleted one', { id: str('Event id', true) }, (args: { id: string }) => repository.get(args.id) as never) as never,
      createEvent: write('Create an event', {
        title: str('Event title', true),
        description: str('Description'),
        location: str('Location'),
        time: { type: 'json' as const, description: 'Event time', required: true as const },
        color: str('One of blue, green, amber, purple, gray'),
      }, (args: { title: string; description?: string; location?: string; time: EventTime; color?: EventColor }, ctx: OperationContext) => repository.create(args, ctx) as never) as never,
      updateEvent: write('Update an event with an expected version', {
        id: str('Event id', true),
        expectedVersion: { type: 'integer' as const, description: 'Expected event version', required: true as const },
        title: str('Event title'),
        description: str('Description'),
        location: str('Location'),
        time: { type: 'json' as const, description: 'Event time' },
        color: str('One of blue, green, amber, purple, gray'),
      }, (args: { id: string; expectedVersion: number; title?: string; description?: string; location?: string; time?: EventTime; color?: EventColor }, ctx: OperationContext) => repository.update(args.id, args.expectedVersion, args, ctx) as never) as never,
      deleteEvent: {
        description: 'Soft-delete an event (human and peer callers only)',
        params: { id: str('Event id', true) },
        result: { type: 'json', description: 'Operation result' },
        effect: 'write',
        exposure: { ai: 'closed', peers: 'open' },
        execute: (async (args: JsonValue, ctx: OperationContext) => {
          await repository.ensureLoaded()
          return await repository.remove((args as { id: string }).id, ctx)
        }) as never,
      },
      restoreEvent: {
        description: 'Restore a soft-deleted event',
        params: { id: str('Event id', true) },
        result: { type: 'json', description: 'Operation result' },
        effect: 'write',
        exposure: { ai: 'open', peers: 'open' },
        execute: (async (args: JsonValue, ctx: OperationContext) => {
          await repository.ensureLoaded()
          return await repository.restore((args as { id: string }).id, ctx)
        }) as never,
      },
      listTaskDeadlines: read('List read-only task deadlines due in a civil range', {
        fromDate: str('First due date (YYYY-MM-DD, inclusive)', true),
        toDate: str('Last due date (YYYY-MM-DD, inclusive)', true),
      }, async (args: { fromDate: string; toDate: string }, ctx: OperationContext) => repository.listTaskDeadlines(args, ctx) as never) as never,
    },
  }
}
