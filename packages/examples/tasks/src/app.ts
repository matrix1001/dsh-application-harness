/**
 * The tasks application: projects, tasks, due dates and the "today" view, all
 * over one gated SQLite document. Note lookup is a peer call to `notes`; the
 * page and the agent use the same operations.
 * @module
 */

import { randomUUID } from 'node:crypto'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { AppContext, AppDeclaration, OperationContext } from '@matrix1001/dsh-application-harness-runtime'
import { GatedStore } from '@matrix1001/dsh-application-harness-store'

/** One task project. */
export interface TaskProject {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  version: number
}

/** Where a task came from, when another application handed it over. */
export interface TaskSource {
  app: string
  id: string
  url?: string
  title?: string
}

/** One task. */
export interface Task {
  id: string
  title: string
  notes: string
  projectId: string | null
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
export interface TasksDocument {
  schemaVersion: 1
  projects: TaskProject[]
  tasks: Task[]
  /** requestId → task id, so a retried peer write returns the first result. */
  receipts?: Record<string, string>
}

const SCHEMA_VERSION = 1
const MAX_TITLE = 200
const MAX_NOTES = 20_000
const MAX_NOTE_IDS = 10

function empty(): TasksDocument { return { schemaVersion: SCHEMA_VERSION, projects: [], tasks: [] } }

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

/** The task repository: one document, one serialized writer, capability-gated. */
export class TasksRepository {
  private readonly store: GatedStore
  private document: TasksDocument = empty()
  private revision: number | undefined
  private loaded = false
  private queue: Promise<unknown> = Promise.resolve()

  constructor(store: GatedStore) { this.store = store }

  attach(access: AppContext['capabilities']): void { this.store.attach(access) }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  async load(): Promise<void> {
    const stored = await this.store.documents.get<TasksDocument>('document')
    if (stored === undefined) { this.document = empty(); this.revision = undefined; this.loaded = true; return }
    /* v8 ignore next -- corrupt store is a defensive branch with no normal producer */
    if (stored.value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(stored.value.tasks) || !Array.isArray(stored.value.projects)) {
      /* v8 ignore next -- a corrupt store is refused before any schema-dependent path */
      throw new AppError('storage-corrupt', 'tasks: unsupported or malformed document')
    }
    this.document = stored.value
    this.revision = stored.revision
    this.loaded = true
  }

  listProjects(): TaskProject[] {
    return [...this.document.projects].sort((a, b) => a.name.localeCompare(b.name))
  }

  listTasks(input: { projectId?: string; includeCompleted?: boolean; dueDate?: string; dueFrom?: string; dueTo?: string; assignee?: 'me' | 'agent' }): Task[] {
    return this.document.tasks
      .filter(task => task.deletedAt === undefined)
      .filter(task => input.includeCompleted === true || task.completedAt === null)
      .filter(task => input.projectId === undefined || task.projectId === input.projectId)
      .filter(task => input.dueDate === undefined || task.dueDate === input.dueDate)
      .filter(task => input.dueFrom === undefined || (task.dueDate !== null && task.dueDate >= input.dueFrom))
      .filter(task => input.dueTo === undefined || (task.dueDate !== null && task.dueDate <= input.dueTo))
      .filter(task => input.assignee === undefined || task.assignee === input.assignee)
      .sort((a, b) => (a.dueDate ?? '9999-99-99').localeCompare(b.dueDate ?? '9999-99-99') || a.priority - b.priority || a.createdAt - b.createdAt)
  }

  get(id: string): Task {
    const task = this.document.tasks.find(candidate => candidate.id === id)
    if (task === undefined) throw new AppError('not-found', `tasks: no task ${id}`)
    return task
  }

  async createProject(name: string, ctx: OperationContext): Promise<TaskProject> {
    const trimmed = name.trim()
    if (trimmed === '') throw new AppError('invalid-args', 'project name must not be empty')
    const now = Date.now()
    const project: TaskProject = { id: `p_${randomUUID()}`, name: trimmed, createdAt: now, updatedAt: now, version: 1 }
    await this.write(document => ({ ...document, projects: [...document.projects, project] }))
    ctx.notifyChanged()
    return project
  }

  async updateProject(id: string, expectedVersion: number, name: string, ctx: OperationContext): Promise<TaskProject> {
    let updated: TaskProject | undefined
    await this.write(document => {
      const index = document.projects.findIndex(project => project.id === id)
      if (index < 0) throw new AppError('not-found', `tasks: no project ${id}`)
      const current = document.projects[index]!
      if (current.version !== expectedVersion) throw new AppError('stale-version', 'tasks: the project changed; reload and retry')
      updated = { ...current, name: name.trim(), updatedAt: Date.now(), version: current.version + 1 }
      const projects = [...document.projects]
      projects[index] = updated
      return { ...document, projects }
    })
    ctx.notifyChanged()
    return updated!
  }

  async create(input: {
    title: string
    notes?: string
    projectId?: string | null
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
        projectId: input.projectId ?? null,
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
      if (created.projectId !== null && !document.projects.some(project => project.id === created!.projectId)) {
        throw new AppError('not-found', `tasks: no project ${created.projectId}`)
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
    projectId?: string | null
    dueDate?: string | null
    assignee?: 'me' | 'agent'
    priority?: 1 | 2 | 3
    completed?: boolean
    noteIds?: string[]
  }, ctx: OperationContext): Promise<Task> {
    let updated: Task | undefined
    await this.write(document => {
      const index = document.tasks.findIndex(task => task.id === id)
      if (index < 0) throw new AppError('not-found', `tasks: no task ${id}`)
      const current = document.tasks[index]!
      if (current.deletedAt !== undefined) throw new AppError('not-found', `tasks: no live task ${id}`)
      if (current.version !== expectedVersion) throw new AppError('stale-version', 'tasks: the task changed; reload and retry')
      if (patch.projectId !== undefined && patch.projectId !== null && !document.projects.some(project => project.id === patch.projectId)) {
        throw new AppError('not-found', `tasks: no project ${patch.projectId}`)
      }
      updated = {
        ...current,
        title: patch.title === undefined ? current.title : assertTitle(patch.title),
        notes: patch.notes === undefined ? current.notes : assertNotes(patch.notes),
        projectId: patch.projectId === undefined ? current.projectId : patch.projectId,
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
      if (index < 0) throw new AppError('not-found', `tasks: no task ${id}`)
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
      if (index < 0) throw new AppError('not-found', `tasks: no task ${id}`)
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

  private async write(change: (document: TasksDocument) => TasksDocument): Promise<void> {
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
const int = (description: string, required = false) => required ? { type: 'integer' as const, description, required: true as const } : { type: 'integer' as const, description }
const bool = (description: string) => ({ type: 'boolean' as const, description })
const noteIds = (description: string) => ({ type: 'array' as const, items: { type: 'string' as const }, description })

/**
 * Build the tasks declaration.
 * @param repository - the durable repository.
 * @returns the declaration.
 */
export function TasksDeclaration(repository: TasksRepository): AppDeclaration {
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
    id: 'tasks',
    name: '任务',
    description: '项目、任务、截止日与今天。',
    version: '0.2.0-rc.1',
    generation: 2,
    data: { kind: 'unified', namespace: 'tasks', schemaVersion: SCHEMA_VERSION },
    capabilities: ['storage'],
    calls: [{ app: 'notes', ops: ['resolveNotes', 'searchNotes'] }],
    start: async (ctx) => { repository.attach(ctx.capabilities) },
    reload: async () => { await repository.load() },
    ops: {
      contextState: read('Read the current tasks and projects for page citations', {}, () => ({ tasks: repository.listTasks({ includeCompleted: true }), projects: repository.listProjects() })) as never,
      listTasks: read('List tasks', {
        projectId: str('Project filter'),
        includeCompleted: bool('Include completed tasks'),
        dueDate: str('Due date (YYYY-MM-DD)'),
        dueFrom: str('Due date from (inclusive)'),
        dueTo: str('Due date to (inclusive)'),
        assignee: str('Assignee filter'),
      }, (args: { projectId?: string; includeCompleted?: boolean; dueDate?: string; dueFrom?: string; dueTo?: string; assignee?: 'me' | 'agent' }) => repository.listTasks(args)) as never,
      getTask: read('Read one task', { id: str('Task id', true) }, (args: { id: string }) => repository.get(args.id)) as never,
      today: read('Tasks due today', { date: str('Client-local date (YYYY-MM-DD)', true) }, (args: { date: string }) => ({ date: args.date, tasks: repository.listTasks({ dueDate: args.date }) })) as never,
      listProjects: read('List projects', {}, () => repository.listProjects()) as never,
      createProject: write('Create a project', { name: str('Project name', true) }, (args: { name: string }, ctx: OperationContext) => repository.createProject(args.name, ctx)) as never,
      updateProject: write('Update a project', { id: str('Project id', true), expectedVersion: int('Expected version', true), name: str('Project name', true) }, (args: { id: string; expectedVersion: number; name: string }, ctx: OperationContext) => repository.updateProject(args.id, args.expectedVersion, args.name, ctx)) as never,
      createTask: write('Create a task', {
        title: str('Title', true), notes: str('Notes'), projectId: { type: 'json' as const, description: 'Project id or null' }, dueDate: { type: 'json' as const, description: 'Due date or null' }, assignee: str('me or agent'), priority: int('Priority 1..3'), noteIds: noteIds('Linked notes'), source: { type: 'json' as const, description: 'Source reference' }, requestId: str('Idempotency key'),
      }, (args: { title: string; notes?: string; projectId?: string | null; dueDate?: string | null; assignee?: 'me' | 'agent'; priority?: 1 | 2 | 3; noteIds?: string[]; source?: TaskSource; requestId?: string }, ctx: OperationContext) => repository.create(args, ctx)) as never,
      updateTask: write('Update a task', {
        id: str('Task id', true), expectedVersion: int('Expected version', true), title: str('Title'), notes: str('Notes'), projectId: { type: 'json' as const, description: 'Project id or null' }, dueDate: { type: 'json' as const, description: 'Due date or null' }, assignee: str('me or agent'), priority: int('Priority 1..3'), completed: bool('Completed'), noteIds: noteIds('Linked notes'),
      }, (args: { id: string; expectedVersion: number; title?: string; notes?: string; projectId?: string | null; dueDate?: string | null; assignee?: 'me' | 'agent'; priority?: 1 | 2 | 3; completed?: boolean; noteIds?: string[] }, ctx: OperationContext) => repository.update(args.id, args.expectedVersion, args, ctx)) as never,
      deleteTask: write('Soft-delete a task', { id: str('Task id', true) }, (args: { id: string }, ctx: OperationContext) => repository.remove(args.id, ctx)) as never,
      restoreTask: write('Restore a soft-deleted task', { id: str('Task id', true) }, (args: { id: string }, ctx: OperationContext) => repository.restore(args.id, ctx)) as never,
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
