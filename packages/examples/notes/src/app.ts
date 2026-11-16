/**
 * The notes application: a small, local-first note store over the harness's
 * unified SQLite namespace. The AI and peer applications use the same public
 * operations as the page; none of them sees the repository directly.
 * @module
 */

import { randomUUID } from 'node:crypto'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { AppContext, AppDeclaration, OperationContext } from '@matrix1001/dsh-application-harness-runtime'
import { GatedStore } from '@matrix1001/dsh-application-harness-store'

/** Where a note came from, when another application handed it over. */
export interface NoteSource {
  app: string
  id: string
  url?: string
  title?: string
}

/** One note as stored. */
export interface Note {
  id: string
  title: string
  body: string
  tags: string[]
  pinned: boolean
  source?: NoteSource
  createdAt: number
  updatedAt: number
  version: number
  deletedAt?: number
}

/** The whole durable document. */
export interface NotesDocument {
  schemaVersion: 1
  notes: Note[]
  /** requestId → note id, so a retried peer write returns the first result. */
  receipts?: Record<string, string>
}

/** A note without its body, for lists and citations. */
export type NoteSummary = Omit<Note, 'body'>

const SCHEMA_VERSION = 1
const MAX_BODY = 100_000
const MAX_TAGS = 20
const MAX_TAG = 40

function empty(): NotesDocument {
  return { schemaVersion: SCHEMA_VERSION, notes: [] }
}

function summary(note: Note): NoteSummary {
  const { body: _body, ...rest } = note
  return rest
}

function titleOf(body: string): string {
  const line = body.split('\n').find((candidate) => candidate.trim() !== '')?.trim() ?? '无标题'
  return line.length <= 200 ? line : `${line.slice(0, 199)}…`
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (tags === undefined) return []
  const normalized = [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag !== ''))]
  if (normalized.length > MAX_TAGS) throw new AppError('invalid-args', `a note may carry at most ${String(MAX_TAGS)} tags`)
  if (normalized.some((tag) => tag.length > MAX_TAG)) throw new AppError('invalid-args', `a tag may be at most ${String(MAX_TAG)} characters`)
  return normalized.sort()
}

function assertBody(body: unknown): string {
  /* v8 ignore next -- the declared schema guarantees a string */
  if (typeof body !== 'string') throw new AppError('invalid-args', 'body must be a string')
  if (body.length > MAX_BODY) throw new AppError('invalid-args', `body must be at most ${String(MAX_BODY)} characters`)
  return body
}

function live(note: Note): boolean { return note.deletedAt === undefined }

/** The note repository: one document, one serialized writer, capability-gated. */
export class NotesRepository {
  private readonly store: GatedStore
  private document: NotesDocument = empty()
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

  /** Load the durable document; a missing document is an empty first run. */
  async load(): Promise<void> {
    const stored = await this.store.documents.get<NotesDocument>('document')
    if (stored === undefined) { this.document = empty(); this.revision = undefined; this.loaded = true; return }
    /* v8 ignore next -- corrupt store is a defensive branch with no normal producer */
    if (stored.value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(stored.value.notes)) {
      /* v8 ignore next -- a corrupt store is refused before any schema-dependent path */
      throw new AppError('storage-corrupt', 'notes: unsupported or malformed document')
    }
    this.document = stored.value
    this.revision = stored.revision
    this.loaded = true
  }

  /** All notes, including soft-deleted when asked. */
  list(input: { query?: string; tag?: string; favorites?: boolean; includeDeleted?: boolean } = {}): NoteSummary[] {
    const query = input.query?.trim().toLocaleLowerCase()
    return this.document.notes
      .filter((note) => input.includeDeleted === true || live(note))
      .filter((note) => input.favorites !== true || note.pinned)
      .filter((note) => input.tag === undefined || note.tags.includes(input.tag))
      .filter((note) => query === undefined || query === '' || `${note.title}\n${note.body}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .map(summary)
  }

  /** One note including its body. */
  get(id: string): Note {
    const note = this.document.notes.find((candidate) => candidate.id === id)
    if (note === undefined) throw new AppError('not-found', `notes: no note ${id}`)
    return note
  }

  /** Resolve a set of live notes for another application. */
  resolve(ids: readonly string[]): NoteSummary[] {
    return this.document.notes.filter((note) => ids.includes(note.id) && live(note)).map(summary)
  }

  /** All tags with their live-note counts. */
  tags(): Array<{ tag: string; count: number }> {
    const counts = new Map<string, number>()
    for (const note of this.document.notes) if (live(note)) for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }

  /** Create one note. */
  async create(input: { body: string; tags?: readonly string[]; pinned?: boolean; source?: NoteSource; requestId?: string }, ctx: OperationContext): Promise<Note> {
    await this.ensureLoaded()
    const body = assertBody(input.body)
    const now = Date.now()
    let created: Note | undefined
    await this.write((document) => {
      const receipt = input.requestId === undefined ? undefined : document.receipts?.[input.requestId]
      if (receipt !== undefined) {
        const existing = document.notes.find(note => note.id === receipt)
        /* v8 ignore next -- a receipt normally points at an existing note */
        if (existing !== undefined) { created = existing; return document }
      }
      created = {
        id: `n_${randomUUID()}`,
        title: titleOf(body),
        body,
        tags: normalizeTags(input.tags),
        pinned: input.pinned === true,
        ...(input.source === undefined ? {} : { source: input.source }),
        createdAt: now,
        updatedAt: now,
        version: 1,
      }
      return {
        ...document,
        notes: [...document.notes, created],
        ...(input.requestId === undefined ? {} : { receipts: { ...(document.receipts ?? {}), [input.requestId]: created.id } }),
      }
    })
    ctx.notifyChanged()
    return created!
  }

  /** Update one note with optimistic concurrency. */
  async update(id: string, expectedVersion: number, patch: { body?: string; tags?: readonly string[]; pinned?: boolean }, ctx: OperationContext): Promise<Note> {
    await this.ensureLoaded()
    let updated: Note | undefined
    await this.write((document) => {
      const index = document.notes.findIndex((note) => note.id === id)
      if (index < 0) throw new AppError('not-found', `notes: no note ${id}`)
      const current = document.notes[index]!
      if (!live(current)) throw new AppError('not-found', `notes: no live note ${id}`)
      if (current.version !== expectedVersion) throw new AppError('stale-version', 'notes: the note changed; reload and retry')
      const body = patch.body === undefined ? current.body : assertBody(patch.body)
      updated = {
        ...current,
        body,
        title: patch.body === undefined ? current.title : titleOf(body),
        tags: patch.tags === undefined ? current.tags : normalizeTags(patch.tags),
        pinned: patch.pinned === undefined ? current.pinned : patch.pinned,
        updatedAt: Date.now(),
        version: current.version + 1,
      }
      const notes = [...document.notes]
      notes[index] = updated
      return { ...document, notes }
    })
    ctx.notifyChanged()
    return updated!
  }

  /** Soft-delete one note. */
  async remove(id: string, ctx: OperationContext): Promise<Note> {
    await this.ensureLoaded()
    let removed: Note | undefined
    await this.write((document) => {
      const index = document.notes.findIndex((note) => note.id === id)
      if (index < 0) throw new AppError('not-found', `notes: no note ${id}`)
      const current = document.notes[index]!
      if (!live(current)) { removed = current; return document }
      removed = { ...current, deletedAt: Date.now(), updatedAt: Date.now(), version: current.version + 1 }
      const notes = [...document.notes]
      notes[index] = removed
      return { ...document, notes }
    })
    ctx.notifyChanged()
    return removed!
  }

  /** Restore one soft-deleted note. */
  async restore(id: string, ctx: OperationContext): Promise<Note> {
    await this.ensureLoaded()
    let restored: Note | undefined
    await this.write((document) => {
      const index = document.notes.findIndex((note) => note.id === id)
      if (index < 0) throw new AppError('not-found', `notes: no note ${id}`)
      const current = document.notes[index]!
      const { deletedAt: _deletedAt, ...liveNote } = current
      restored = { ...liveNote, updatedAt: Date.now(), version: current.version + 1 }
      const notes = [...document.notes]
      notes[index] = restored
      return { ...document, notes }
    })
    ctx.notifyChanged()
    return restored!
  }

  /** Export every note (including soft-deleted) as JSON. */
  exportJSON(): string {
    return JSON.stringify(this.document)
  }

  /** Import a previously exported document, replacing or merging by id. */
  async importJSON(json: string, mode: 'merge' | 'overwrite', ctx: OperationContext): Promise<{ imported: number }> {
    await this.ensureLoaded()
    let parsed: unknown
    try { parsed = JSON.parse(json) } catch { throw new AppError('invalid-args', 'notes: import is not valid JSON') }
    if (typeof parsed !== 'object' || parsed === null || (parsed as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION) {
      throw new AppError('invalid-args', 'notes: unsupported import document')
    }
    const incoming = (parsed as { notes?: unknown }).notes
    if (!Array.isArray(incoming)) throw new AppError('invalid-args', 'notes: import has no notes array')
    const notes = incoming as Note[]
    const malformed = notes.some((note) =>
      typeof note?.id !== 'string' || note.id === ''
      || typeof note.body !== 'string'
      || typeof note.title !== 'string'
      || !Array.isArray(note.tags) || note.tags.some(tag => typeof tag !== 'string')
      || typeof note.pinned !== 'boolean'
      || !Number.isInteger(note.createdAt) || !Number.isInteger(note.updatedAt) || !Number.isInteger(note.version))
    if (malformed) {
      throw new AppError('invalid-args', 'notes: import contains a malformed note')
    }
    await this.write((document) => {
      if (mode === 'overwrite') return { schemaVersion: SCHEMA_VERSION, notes }
      const byId = new Map(document.notes.map((note) => [note.id, note]))
      for (const note of notes) byId.set(note.id, note)
      return { schemaVersion: SCHEMA_VERSION, notes: [...byId.values()] }
    })
    ctx.notifyChanged()
    return { imported: notes.length }
  }

  private async write(change: (document: NotesDocument) => NotesDocument): Promise<void> {
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
const bool = (description: string) => ({ type: 'boolean' as const, description })
const tags = (description: string) => ({ type: 'array' as const, items: { type: 'string' as const }, description })

/**
 * Build the notes declaration.
 * @param repository - the durable repository.
 * @returns the declaration the runtime registers.
 */
export function NotesDeclaration(repository: NotesRepository): AppDeclaration {
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
    id: 'notes',
    name: '笔记',
    description: '资料、标签、来源与检索。',
    version: '0.2.0-rc.1',
    generation: 2,
    data: { kind: 'unified', namespace: 'notes', schemaVersion: SCHEMA_VERSION, exportOp: 'exportNotes', importOp: 'importNotes' },
    capabilities: ['storage'],
    start: async (ctx) => {
      repository.attach(ctx.capabilities)
    },
    reload: async () => { await repository.load() },
    ops: {
      contextState: read('Read the current note summaries for page citations', {}, () => ({ notes: repository.list({}) })) as never,
      list: read('List note summaries', {
        query: str('Full-text query'),
        tag: str('Tag filter'),
        favorites: bool('Only pinned notes'),
        includeDeleted: bool('Include soft-deleted notes'),
      }, (args: { query?: string; tag?: string; favorites?: boolean; includeDeleted?: boolean }) => repository.list(args)) as never,
      get: read('Read one note with its body', { id: str('Note id', true) }, (args: { id: string }) => repository.get(args.id)) as never,
      search: read('Search notes', { query: str('Full-text query', true) }, (args: { query: string }) => repository.list({ query: args.query })) as never,
      searchNotes: read('Search notes for another application', { query: str('Full-text query', true) }, (args: { query: string }) => repository.list({ query: args.query })) as never,
      resolveNotes: read('Resolve note summaries by id', { ids: { type: 'array', items: { type: 'string' }, description: 'Note ids', required: true } }, (args: { ids: string[] }) => repository.resolve(args.ids)) as never,
      listTags: read('List tags with live-note counts', {}, () => repository.tags()) as never,
      create: write('Create a note', { body: str('Markdown body', true), tags: tags('Tags'), pinned: bool('Pinned'), source: { type: 'json' as const, description: 'Source reference' }, requestId: str('Idempotency key') }, (args: { body: string; tags?: string[]; pinned?: boolean; source?: NoteSource; requestId?: string }, ctx: OperationContext) => repository.create(args, ctx)) as never,
      update: write('Update a note', { id: str('Note id', true), expectedVersion: { type: 'integer', description: 'Expected note version', required: true }, body: str('Replacement body'), tags: tags('Replacement tags'), pinned: bool('Pinned') }, (args: { id: string; expectedVersion: number; body?: string; tags?: string[]; pinned?: boolean }, ctx: OperationContext) => repository.update(args.id, args.expectedVersion, args, ctx)) as never,
      delete: write('Soft-delete a note', { id: str('Note id', true) }, (args: { id: string }, ctx: OperationContext) => repository.remove(args.id, ctx)) as never,
      restore: write('Restore a soft-deleted note', { id: str('Note id', true) }, (args: { id: string }, ctx: OperationContext) => repository.restore(args.id, ctx)) as never,
      exportNotes: {
        description: 'Export all notes as JSON',
        params: {},
        result: { type: 'json', description: 'Exported JSON string' },
        effect: 'read',
        exposure: { ai: 'closed', peers: 'closed' },
        execute: async () => { await repository.ensureLoaded(); return { json: repository.exportJSON() } },
      },
      importNotes: {
        description: 'Import notes from JSON',
        params: { json: str('Exported JSON', true), mode: str('merge or overwrite') },
        result: { type: 'json', description: 'Import result' },
        effect: 'write',
        exposure: { ai: 'closed', peers: 'closed' },
        execute: (args, ctx) => repository.importJSON((args as { json: string }).json, (args as { mode?: 'merge' | 'overwrite' }).mode ?? 'merge', ctx),
      },
    },
  }
}
