/**
 * The todo application: tasks with a title, notes, a due date and a priority,
 * all over one gated SQLite document. Note lookup is a peer call to `notes`;
 * the page and the agent use the same operations. Projects are deliberately
 * absent from this application (v1).
 * @module
 */

import { randomUUID } from 'node:crypto'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { AppContext, AppDeclaration, OperationContext } from '@matrix1001/dsh-application-harness-runtime'
import { GatedCollection, GatedStore } from '@matrix1001/dsh-application-harness-store'

/** Where a todo came from, when another application handed it over. */
export interface TaskSource {
  app: string
  id: string
  url?: string
  title?: string
}

/** One todo. */
export interface Task {
  id: string
  title: string
  notes: string
  dueDate: string | null
  assignee: 'me' | 'agent'
  priority: 1 | 2 | 3
  completedAt: number | null
  noteIds: string[]
  source?: TaskSource
  createdAt: number
  updatedAt: number
  version: number
  deletedAt?: number
}

/** The whole durable document. */
export interface TodoDocument {
  schemaVersion: 1
  tasks: Task[]
  /** requestId → task id, so a retried peer write returns the first result. */
  receipts?: Record<string, string>
}

/**
 * The application-side link from one todo to its delegation. Delegations are
 * platform records (`ctx.delegations`); this small collection only remembers
 * WHICH delegation the todo currently uses and whether its result was already
 * appended — the todo document itself is untouched, so creating a delegation
 * never invalidates an open editor's version.
 */
export interface TodoDelegationLink {
  readonly taskId: string
  readonly delegationId: string
  /** The delegation whose report the user already appended to the todo. */
  readonly appliedDelegationId?: string
  readonly updatedAt: number
}

const SCHEMA_VERSION = 1
/** The collection that holds {@link TodoDelegationLink} rows, keyed by todo id. */
const DELEGATION_COLLECTION = 'delegations'
const MAX_TITLE = 200
const MAX_NOTES = 20_000
const MAX_NOTE_IDS = 10

function empty(): TodoDocument { return { schemaVersion: SCHEMA_VERSION, tasks: [] } }

function assertDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new AppError('invalid-args', 'dueDate must be YYYY-MM-DD')
  return value
}

function assertTitle(value: unknown): string {
  /* v8 ignore next -- the declared schema already guarantees a string */
  if (typeof value !== 'string') throw new AppError('invalid-args', 'title must be a string')
  const title = value.trim()
  if (title === '' || title.length > MAX_TITLE) throw new AppError('invalid-args', `title must be 1..${String(MAX_TITLE)} characters`)
  return title
}

function assertNotes(value: unknown): string {
  /* v8 ignore next -- the declared schema already guarantees a string */
  if (typeof value !== 'string') throw new AppError('invalid-args', 'notes must be a string')
  if (value.length > MAX_NOTES) throw new AppError('invalid-args', `notes must be at most ${String(MAX_NOTES)} characters`)
  return value
}

function assertNoteIds(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_NOTE_IDS || value.some(id => typeof id !== 'string' || id === '')) {
    throw new AppError('invalid-args', `noteIds must be up to ${String(MAX_NOTE_IDS)} non-empty strings`)
  }
  return [...new Set(value as string[])]
}

function assertPriority(value: unknown): 1 | 2 | 3 {
  if (value !== 1 && value !== 2 && value !== 3) throw new AppError('invalid-args', 'priority must be 1, 2 or 3')
  return value
}

function assertAssignee(value: unknown): 'me' | 'agent' {
  if (value !== 'me' && value !== 'agent') throw new AppError('invalid-args', 'assignee must be me or agent')
  return value
}

/** The todo repository: one document, one serialized writer, capability-gated. */
export class TodoRepository {
  private readonly store: GatedStore
  private document: TodoDocument = empty()
  private revision: number | undefined
  private loaded = false
  private queue: Promise<unknown> = Promise.resolve()

  /** The todo → delegation links; the todo document stores no delegation fields. */
  private readonly delegationLinks: GatedCollection

  constructor(store: GatedStore) {
    this.store = store
    this.delegationLinks = store.collections.open(DELEGATION_COLLECTION)
  }

  attach(access: AppContext['capabilities']): void { this.store.attach(access) }

  /** Read one todo's delegation link. */
  async delegationLink(taskId: string): Promise<TodoDelegationLink | undefined> {
    const item = await this.delegationLinks.get<TodoDelegationLink>(taskId)
    return item?.value
  }

  /** Remember which delegation the todo currently uses. */
  async setDelegationLink(taskId: string, delegationId: string, appliedDelegationId?: string): Promise<TodoDelegationLink> {
    const link: TodoDelegationLink = {
      taskId,
      delegationId,
      ...(appliedDelegationId === undefined ? {} : { appliedDelegationId }),
      updatedAt: Date.now(),
    }
    await this.delegationLinks.put(taskId, link)
    return link
  }

  /** Record that a delegation's report was appended to the todo (idempotent marker). */
  async markDelegationApplied(link: TodoDelegationLink, delegationId: string): Promise<TodoDelegationLink> {
    return await this.setDelegationLink(link.taskId, link.delegationId, delegationId)
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  async load(): Promise<void> {
    const stored = await this.store.documents.get<TodoDocument>('document')
    if (stored === undefined) { this.document = empty(); this.revision = undefined; this.loaded = true; return }
    /* v8 ignore next -- corrupt store is a defensive branch with no normal producer */
    if (stored.value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(stored.value.tasks)) {
      /* v8 ignore next -- a corrupt store is refused before any schema-dependent path */
      throw new AppError('storage-corrupt', 'todo: unsupported or malformed document')
    }
    this.document = stored.value
    this.revision = stored.revision
    this.loaded = true
  }

  listTasks(input: { includeCompleted?: boolean; dueDate?: string; dueFrom?: string; dueTo?: string; assignee?: 'me' | 'agent' }): Task[] {
    return this.document.tasks
      .filter(task => task.deletedAt === undefined)
      .filter(task => input.includeCompleted === true || task.completedAt === null)
      .filter(task => input.dueDate === undefined || task.dueDate === input.dueDate)
      .filter(task => input.dueFrom === undefined || (task.dueDate !== null && task.dueDate >= input.dueFrom))
      .filter(task => input.dueTo === undefined || (task.dueDate !== null && task.dueDate <= input.dueTo))
      .filter(task => input.assignee === undefined || task.assignee === input.assignee)
      .sort((a, b) => (a.dueDate ?? '9999-99-99').localeCompare(b.dueDate ?? '9999-99-99') || a.priority - b.priority || a.createdAt - b.createdAt)
  }

  get(id: string): Task {
    const task = this.document.tasks.find(candidate => candidate.id === id)
    if (task === undefined) throw new AppError('not-found', `todo: no task ${id}`)
    return task
  }

  async create(input: {
    title: string
    notes?: string
    dueDate?: string | null
    assignee?: 'me' | 'agent'
    priority?: 1 | 2 | 3
    noteIds?: string[]
    source?: TaskSource
    requestId?: string
  }, ctx: OperationContext): Promise<Task> {
    const now = Date.now()
    let created: Task | undefined
    await this.write(document => {
      const receipt = input.requestId === undefined ? undefined : document.receipts?.[input.requestId]
      if (receipt !== undefined) {
        const existing = document.tasks.find(task => task.id === receipt)
        /* v8 ignore next -- a receipt normally points at an existing task */
        if (existing !== undefined) { created = existing; return document }
      }
      created = {
        id: `t_${randomUUID()}`,
        title: assertTitle(input.title),
        notes: input.notes === undefined ? '' : assertNotes(input.notes),
        dueDate: assertDate(input.dueDate),
        assignee: input.assignee === undefined ? 'me' : assertAssignee(input.assignee),
        priority: input.priority === undefined ? 2 : assertPriority(input.priority),
        completedAt: null,
        noteIds: assertNoteIds(input.noteIds),
        ...(input.source === undefined ? {} : { source: input.source }),
        createdAt: now,
        updatedAt: now,
        version: 1,
      }
      return {
        ...document,
        tasks: [...document.tasks, created],
        ...(input.requestId === undefined ? {} : { receipts: { ...(document.receipts ?? {}), [input.requestId]: created.id } }),
      }
    })
    ctx.notifyChanged()
    return created!
  }

  async update(id: string, expectedVersion: number, patch: {
    title?: string
    notes?: string
    dueDate?: string | null
    assignee?: 'me' | 'agent'
    priority?: 1 | 2 | 3
    completed?: boolean
    noteIds?: string[]
  }, ctx: OperationContext): Promise<Task> {
    let updated: Task | undefined
    await this.write(document => {
      const index = document.tasks.findIndex(task => task.id === id)
      if (index < 0) throw new AppError('not-found', `todo: no task ${id}`)
      const current = document.tasks[index]!
      if (current.deletedAt !== undefined) throw new AppError('not-found', `todo: no live task ${id}`)
      if (current.version !== expectedVersion) throw new AppError('stale-version', 'todo: the task changed; reload and retry')
      updated = {
        ...current,
        title: patch.title === undefined ? current.title : assertTitle(patch.title),
        notes: patch.notes === undefined ? current.notes : assertNotes(patch.notes),
        dueDate: patch.dueDate === undefined ? current.dueDate : assertDate(patch.dueDate),
        assignee: patch.assignee === undefined ? current.assignee : assertAssignee(patch.assignee),
        priority: patch.priority === undefined ? current.priority : assertPriority(patch.priority),
        completedAt: patch.completed === undefined ? current.completedAt : patch.completed ? Date.now() : null,
        noteIds: patch.noteIds === undefined ? current.noteIds : assertNoteIds(patch.noteIds),
        updatedAt: Date.now(),
        version: current.version + 1,
      }
      const tasks = [...document.tasks]
      tasks[index] = updated
      return { ...document, tasks }
    })
    ctx.notifyChanged()
    return updated!
  }

  async remove(id: string, ctx: OperationContext): Promise<Task> {
    let removed: Task | undefined
    await this.write(document => {
      const index = document.tasks.findIndex(task => task.id === id)
      if (index < 0) throw new AppError('not-found', `todo: no task ${id}`)
      const current = document.tasks[index]!
      if (current.deletedAt !== undefined) { removed = current; return document }
      removed = { ...current, deletedAt: Date.now(), updatedAt: Date.now(), version: current.version + 1 }
      const tasks = [...document.tasks]
      tasks[index] = removed
      return { ...document, tasks }
    })
    ctx.notifyChanged()
    return removed!
  }

  async restore(id: string, ctx: OperationContext): Promise<Task> {
    let restored: Task | undefined
    await this.write(document => {
      const index = document.tasks.findIndex(task => task.id === id)
      if (index < 0) throw new AppError('not-found', `todo: no task ${id}`)
      const current = document.tasks[index]!
      const { deletedAt: _deletedAt, ...liveTask } = current
      restored = { ...liveTask, updatedAt: Date.now(), version: current.version + 1 }
      const tasks = [...document.tasks]
      tasks[index] = restored
      return { ...document, tasks }
    })
    ctx.notifyChanged()
    return restored!
  }

  private async write(change: (document: TodoDocument) => TodoDocument): Promise<void> {
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

/** How much of the todo's notes the application-fixed delegation instructions carry. */
const MAX_DELEGATION_NOTES = 4_000

/**
 * Build the title and instructions a todo delegation hands to its execution
 * Session. The application composes them from the todo at creation time; the
 * user can add a supplement but never rewrite them, and later todo edits do not
 * change a delegation that was already prepared.
 * @param task - the todo being delegated.
 * @returns the delegation title and instructions.
 */
export function delegationPromptFor(task: Task): { title: string; instructions: string } {
  const title = `待办：${task.title}`.slice(0, 200)
  const notes = task.notes.length > MAX_DELEGATION_NOTES ? `${task.notes.slice(0, MAX_DELEGATION_NOTES)}…` : task.notes
  const lines = [
    `处理这个待办：${task.title}`,
    ...(notes.trim() === '' ? [] : ['', '待办备注：', notes]),
    ...(task.dueDate === null ? [] : ['', `截止日期：${task.dueDate}`]),
    '',
    '要求：',
    '- 给出清晰的结果摘要；需要人决定时说明具体问题。',
    '- 不要直接修改待办、笔记或其他应用的数据；结果由用户确认后写回。',
  ]
  return { title, instructions: lines.join('\n') }
}

const str = (description: string, required = false) => required ? { type: 'string' as const, description, required: true as const } : { type: 'string' as const, description }
const int = (description: string, required = false) => required ? { type: 'integer' as const, description, required: true as const } : { type: 'integer' as const, description }
const bool = (description: string) => ({ type: 'boolean' as const, description })
const noteIds = (description: string) => ({ type: 'array' as const, items: { type: 'string' as const }, description })

/**
 * Build the todo declaration.
 * @param repository - the durable repository.
 * @returns the declaration.
 */
export function TodoDeclaration(repository: TodoRepository): AppDeclaration {
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
    id: 'todo',
    name: '待办',
    description: '待办、截止日与优先级。',
    version: '0.1.1-dev.0',
    generation: 2,
    data: { kind: 'unified', namespace: 'todo', schemaVersion: SCHEMA_VERSION },
    capabilities: ['storage', 'delegate'],
    calls: [{ app: 'notes', ops: ['resolveNotes', 'searchNotes'] }],
    objectTypes: { task: { description: 'A todo', resolveOperation: 'resolveTask' } },
    start: async (ctx) => {
      repository.attach(ctx.capabilities)
    },
    reload: async () => { await repository.load() },
    ops: {
      contextState: read('Read the current todos for page citations', {}, () => ({ tasks: repository.listTasks({ includeCompleted: true }) })) as never,
      resolveTask: read('Resolve one todo reference', { id: str('Todo id', true) }, (args: { id: string }) => {
        const task = repository.get(args.id)
        // A soft-deleted task is gone for every reader: resolving it would tell
        // the referencing page that a deleted object still exists.
        if (task.deletedAt !== undefined) throw new AppError('not-found', `todo: no live task ${args.id}`)
        return { ref: { appId: 'todo', type: 'task', id: args.id }, title: task.title, summary: task.completedAt === null ? 'open' : 'completed' }
      }) as never,
      listTasks: read('List todos', {
        includeCompleted: bool('Include completed todos'),
        dueDate: str('Due date (YYYY-MM-DD)'),
        dueFrom: str('Due date from (inclusive)'),
        dueTo: str('Due date to (inclusive)'),
        assignee: str('Assignee filter'),
      }, (args: { includeCompleted?: boolean; dueDate?: string; dueFrom?: string; dueTo?: string; assignee?: 'me' | 'agent' }) => repository.listTasks(args)) as never,
      getTask: read('Read one todo', { id: str('Todo id', true) }, (args: { id: string }) => repository.get(args.id)) as never,
      createTask: write('Create a todo', {
        title: str('Title', true), notes: str('Notes'), dueDate: { type: 'json' as const, description: 'Due date or null' }, assignee: str('me or agent'), priority: int('Priority 1..3'), noteIds: noteIds('Linked notes'), source: { type: 'json' as const, description: 'Source reference' }, requestId: str('Idempotency key'),
      }, async (args: { title: string; notes?: string; dueDate?: string | null; assignee?: 'me' | 'agent'; priority?: 1 | 2 | 3; noteIds?: string[]; source?: TaskSource; requestId?: string }, ctx: OperationContext) => {
        const task = await repository.create(args, ctx)
        return { id: task.id }
      }) as never,
      updateTask: write('Update a todo', {
        id: str('Todo id', true), expectedVersion: int('Expected version', true), title: str('Title'), notes: str('Notes'), dueDate: { type: 'json' as const, description: 'Due date or null' }, assignee: str('me or agent'), priority: int('Priority 1..3'), completed: bool('Completed'), noteIds: noteIds('Linked notes'),
      }, (args: { id: string; expectedVersion: number; title?: string; notes?: string; dueDate?: string | null; assignee?: 'me' | 'agent'; priority?: 1 | 2 | 3; completed?: boolean; noteIds?: string[] }, ctx: OperationContext) => repository.update(args.id, args.expectedVersion, args, ctx)) as never,
      deleteTask: write('Soft-delete a todo', { id: str('Todo id', true) }, (args: { id: string }, ctx: OperationContext) => repository.remove(args.id, ctx)) as never,
      restoreTask: write('Restore a soft-deleted todo', { id: str('Todo id', true) }, (args: { id: string }, ctx: OperationContext) => repository.restore(args.id, ctx)) as never,
      createDelegation: write('Prepare a pending delegation for this todo (the user still selects a session and sends it)', {
        taskId: str('Todo id', true),
      }, async (args: { taskId: string }, ctx: OperationContext) => {
        const task = repository.get(args.taskId)
        if (task.deletedAt !== undefined) throw new AppError('not-found', `todo: no live task ${args.taskId}`)
        const link = await repository.delegationLink(task.id)
        if (link !== undefined) {
          const current = await ctx.delegations.read(link.delegationId)
          if (current !== undefined && current.status !== 'ended') {
            throw new AppError('delegation-active', 'todo: this task already has a delegation waiting or running; cancel it or wait for it to end')
          }
        }
        const prompt = delegationPromptFor(task)
        const delegation = await ctx.delegations.create(prompt)
        await repository.setDelegationLink(task.id, delegation.id)
        ctx.notifyChanged()
        return { delegation }
      }) as never,
      taskDelegation: read("Read this todo's current delegation state", {
        taskId: str('Todo id', true),
      }, async (args: { taskId: string }, ctx: OperationContext) => {
        const link = await repository.delegationLink(args.taskId)
        if (link === undefined) return { delegation: null }
        const delegation = await ctx.delegations.read(link.delegationId)
        if (delegation === undefined) return { delegation: null, missing: true }
        return { delegation, applied: link.appliedDelegationId === delegation.id }
      }) as never,
      applyDelegationResult: write('Append an ended delegation report to the todo after the user confirms; never marks the todo complete', {
        taskId: str('Todo id', true),
        expectedVersion: int('Expected task version', true),
        delegationId: str('Delegation id', true),
      }, async (args: { taskId: string; expectedVersion: number; delegationId: string }, ctx: OperationContext) => {
        const link = await repository.delegationLink(args.taskId)
        if (link === undefined || link.delegationId !== args.delegationId) {
          throw new AppError('delegation-unknown', 'todo: this task has no such delegation')
        }
        if (link.appliedDelegationId === args.delegationId) return repository.get(args.taskId)
        const delegation = await ctx.delegations.read(args.delegationId)
        if (delegation === undefined) throw new AppError('delegation-unknown', `todo: no delegation ${args.delegationId}`)
        if (delegation.status !== 'ended') throw new AppError('delegation-not-ended', 'todo: the delegation has not ended yet')
        const report = delegation.latestReport
        if (report === undefined) throw new AppError('delegation-no-result', 'todo: the delegation ended without a report')
        const outcomeLabel = report.outcome === 'completed' ? '完成' : '失败'
        const summary = report.summary.length > 8_000 ? `${report.summary.slice(0, 8_000)}…` : report.summary
        const task = await repository.update(args.taskId, args.expectedVersion, {
          notes: `${repository.get(args.taskId).notes}\n\n[委托结果 · ${outcomeLabel}]\n${summary}`,
        }, ctx)
        await repository.markDelegationApplied(link, args.delegationId)
        return task
      }) as never,
      resolveNotes: read('Resolve note summaries through notes', { ids: noteIds('Note ids') }, async (args: { ids: string[] }, ctx: OperationContext) => {
        const outcome = await ctx.call('notes', 'resolveNotes', { ids: args.ids }) as { status: string; result?: unknown }
        return outcome.status === 'success' ? outcome.result : { notes: [], unavailable: true }
      }) as never,
      searchNotes: read('Search notes through notes', { query: str('Query', true) }, async (args: { query: string }, ctx: OperationContext) => {
        const outcome = await ctx.call('notes', 'searchNotes', { query: args.query }) as { status: string; result?: unknown }
        return outcome.status === 'success' ? outcome.result : { notes: [], unavailable: true }
      }) as never,
    },
  }
}
