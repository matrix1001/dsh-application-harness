/**
 * The notes application: a small, local-first note store over the harness's
 * unified SQLite namespace. The AI and peer applications use the same public
 * operations as the page; none of them sees the repository directly.
 *
 * Attachment bytes are deliberately not part of the unified document (and so
 * not part of the platform's whole-store backup): the note carries only the
 * attachment metadata, while {@link AttachmentStore} owns the bytes in the
 * application directory the deployment binds. The application's own JSON
 * export is the attachment backup — small files inline their bytes, larger
 * exports carry metadata plus a warning.
 * @module @matrix1001/dsh-application-harness-notes/app
 */

import { randomUUID } from 'node:crypto'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { ModelPort } from '@matrix1001/dsh-application-harness-host-bridge'
import type { AppContext, AppDeclaration, OperationContext } from '@matrix1001/dsh-application-harness-runtime'
import { GatedStore } from '@matrix1001/dsh-application-harness-store'
import { TextSearchIndex } from '@deepseek-ai/dsh-util-text-search'
import {
  AttachmentStore,
  MAX_EXPORT_ATTACHMENT_BYTES,
  MAX_NOTE_ATTACHMENT_BYTES,
  decodeAttachment,
  isAttachmentId,
  isAttachmentMeta,
  sha256Of,
  type AttachmentUpload,
  type DecodedAttachment,
  type NoteAttachment,
} from './attachments.ts'

/** Where a note came from, when another application handed it over. */
export interface NoteSource {
  app: string
  id: string
  url?: string
  title?: string
}

/** One note's attachment metadata as a reader sees it. */
export interface AttachmentView extends NoteAttachment {
  /** True when the metadata exists but the bytes do not (deleted/never imported/lost). */
  missing: boolean
}

/** One note as stored. */
export interface Note {
  id: string
  title: string
  body: string
  tags: string[]
  pinned: boolean
  source?: NoteSource
  /** The attachment metadata whose bytes live in the application's attachment store. */
  attachments: NoteAttachment[]
  createdAt: number
  updatedAt: number
  version: number
  deletedAt?: number
}

/** A note read through the page/peer face: the body plus each attachment's byte status. */
export interface NoteView extends Omit<Note, 'attachments'> {
  attachments: AttachmentView[]
}

/** One upload request's receipt: which note an attachment id was created for. */
export interface AttachmentReceipt {
  noteId: string
  attachmentId: string
}

/** The whole durable document. */
export interface NotesDocument {
  schemaVersion: 2
  notes: Note[]
  /** requestId → note id, so a retried peer write returns the first result. */
  receipts?: Record<string, string>
  /** requestId → attachment receipt, so a retried upload returns the first result. */
  attachmentReceipts?: Record<string, AttachmentReceipt>
}

/** A note without its body, for lists and citations. */
export type NoteSummary = Omit<Note, 'body'>

/** The result of uploading one attachment: the updated note and the stored metadata. */
export interface AttachmentUploadResult {
  note: Note
  attachment: NoteAttachment
}

/** The result of deleting one attachment: the updated note and the removed metadata. */
export interface AttachmentDeleteResult {
  note: Note
  attachment: NoteAttachment
}

/** One attachment's download answer: bytes inline, or the missing marker. */
export interface AttachmentDownload extends NoteAttachment {
  /** True when the metadata exists but no bytes do. */
  missing: boolean
  /** Canonical base64 bytes; absent when `missing` is true. */
  dataBase64?: string
}

/** How one attachment appears in an exported JSON document. */
export interface ExportedAttachment {
  /** Canonical base64 bytes, present only while the export budget allows. */
  dataBase64?: string
  /** Why the bytes are absent: over the export budget, missing on disk, or failing their digest. */
  omitted?: 'budget' | 'missing' | 'corrupt'
}

/** The exported JSON document's shape (`schemaVersion` tracks the durable schema). */
export interface ExportedNotesDocument {
  schemaVersion: 2
  notes: Note[]
  /** Attachment bytes/metadata keyed by attachment id; every referenced id appears here. */
  attachments: Record<string, ExportedAttachment>
  /** Machine-readable omission notes (`attachment-missing:<id>`, …); the page localizes the count. */
  warnings: string[]
}

/** The export operation's result (an object type literal: it is a JSON value by construction). */
export type NotesExportResult = {
  json: string
  warnings: string[]
}

/** The import operation's result, including what happened to the attachment bytes. */
export type NotesImportResult = {
  imported: number
  attachments: {
    /** How many attachment byte files the import wrote. */
    written: number
    /** How many imported attachments have metadata but no bytes anywhere. */
    missing: number
    /** How many unreferenced byte files the post-import collection removed. */
    removed: number
  }
  warnings: string[]
}

const SCHEMA_VERSION = 2
const MAX_BODY = 100_000
const MAX_TAGS = 20
const MAX_TAG = 40
/** The one document scope this application persists (one notes document per namespace). */
const DOCUMENT_SCOPE = 'document'

function empty(): NotesDocument {
  return { schemaVersion: SCHEMA_VERSION, notes: [] }
}

/** Normalize one loaded note: every note carries an attachment metadata array, invalid entries are dropped. */
function normalizeNote(note: Note): Note {
  const attachments = note.attachments.filter(isAttachmentMeta)
  return { ...note, attachments }
}

/** Normalize one loaded document: drop invalid attachment metadata. */
function normalizeDocument(document: NotesDocument): NotesDocument {
  return { ...document, notes: document.notes.map(normalizeNote) }
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

/** The bytes one attachment list accounts for, against the per-note quota. */
function attachmentBytes(attachments: readonly NoteAttachment[]): number {
  return attachments.reduce((sum, attachment) => sum + attachment.size, 0)
}

/** One body segment an attachment cannot match: the note's own token budget. */
function oversized(attachments: readonly NoteAttachment[]): boolean {
  return attachmentBytes(attachments) > MAX_NOTE_ATTACHMENT_BYTES
}

/** The note repository: one document, one serialized writer, capability-gated. */
export class NotesRepository {
  private readonly store: GatedStore
  private readonly attachments: AttachmentStore
  private readonly model: ModelPort | undefined
  private document: NotesDocument = empty()
  private revision: number | undefined
  private loaded = false
  private queue: Promise<unknown> = Promise.resolve()

  constructor(store: GatedStore, attachments: AttachmentStore, model?: ModelPort) {
    this.store = store
    this.attachments = attachments
    this.model = model
  }

  /** Attach the application's capability door. */
  attach(access: AppContext['capabilities']): void { this.store.attach(access) }

  /** Load the durable document if this process has not done so yet. */
  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  /** Load the durable document; a missing document is an empty first run. */
  async load(): Promise<void> {
    const stored = await this.store.documents.get<NotesDocument>(DOCUMENT_SCOPE)
    if (stored === undefined) { this.document = empty(); this.revision = undefined; this.loaded = true; return }
    /* v8 ignore next -- corrupt store is a defensive branch with no normal producer */
    if (stored.value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(stored.value.notes)) {
      /* v8 ignore next -- a corrupt store is refused before any schema-dependent path */
      throw new AppError('storage-corrupt', 'notes: unsupported or malformed document')
    }
    this.document = normalizeDocument(stored.value)
    this.revision = stored.revision
    this.loaded = true
  }

  /** Summarize one note through the platform model. Read-only; never writes the note. */
  async summarize(id: string, question: string | undefined, ctx: OperationContext): Promise<{ summary: string; model?: { provider: string; model: string }; usage?: { inputTokens?: number; outputTokens?: number } }> {
    if (this.model === undefined) throw new AppError('model-unavailable', 'notes has no platform model port')
    await this.ensureLoaded()
    const note = await this.get(id)
    if (note.deletedAt !== undefined) throw new AppError('not-found', `notes: no live note ${id}`)
    const body = note.body.length > 60_000 ? `${note.body.slice(0, 60_000)}\n…` : note.body
    const ask = question === undefined || question.trim() === ''
      ? `Summarize the following note in a few sentences.\n\n${body}`
      : `Answer the question using only the following note. If the note does not contain the answer, say so.\n\nQuestion: ${question.trim()}\n\nNote:\n${body}`
    const result = await this.model.ask({
      prompt: ask,
      capabilities: ctx.capabilities,
      signal: ctx.signal,
      maxOutputTokens: 800,
      temperature: 0.2,
    })
    return {
      summary: result.text,
      ...(result.model === undefined ? {} : { model: result.model }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    }
  }

  /** All notes, including soft-deleted when asked. */
  list(input: { query?: string; tag?: string; favorites?: boolean; includeDeleted?: boolean } = {}): NoteSummary[] {
    const query = input.query?.trim() ?? ''
    const scoped = this.document.notes
      .filter((note) => input.includeDeleted === true || live(note))
      .filter((note) => input.favorites !== true || note.pinned)
      .filter((note) => input.tag === undefined || note.tags.includes(input.tag))
    // The page promises title, tags and body: the host query must cover all
    // three. The platform index supplies the normalization (NFKC, diacritics,
    // CJK) while `substring` keys keep the promise literal — a fuzzy
    // abbreviation is a separate product decision.
    const searched = query === ''
      ? scoped
      : (() => {
          const index = new TextSearchIndex(scoped, note => ({ substring: [note.title, note.body, ...note.tags] }))
          const matched = new Set(index.search(query))
          return scoped.filter(note => matched.has(note))
        })()
    return searched
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .map(summary)
  }

  /** Synchronous live-note lookup for object resolution (loaded by the caller). */
  getSync(id: string): Note {
    const note = this.find(id)
    if (note.deletedAt !== undefined) throw new AppError('not-found', `notes: no live note ${id}`)
    return note
  }

  /** One note including its body and each attachment's byte status. */
  async get(id: string): Promise<NoteView> {
    const note = this.find(id)
    const attachments = await Promise.all(note.attachments.map(async (attachment): Promise<AttachmentView> => (
      { ...attachment, missing: !(await this.attachments.exists(attachment.id)) }
    )))
    return { ...note, attachments }
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
        attachments: [],
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

  /** Update one note with optimistic concurrency; attachment metadata is preserved. */
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

  /** Soft-delete one note; its attachment bytes are deliberately retained. */
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

  /**
   * Attach one file to a live note. The bytes are committed before the note
   * metadata (a failed metadata write removes this upload's bytes); the
   * per-note quota covers the note's existing attachments. An optional
   * `requestId` replays the first upload's result instead of storing twice.
   */
  async uploadAttachment(noteId: string, input: AttachmentUpload & { requestId?: string }, ctx: OperationContext): Promise<AttachmentUploadResult> {
    await this.ensureLoaded()
    let result: AttachmentUploadResult | undefined
    await this.exclusive(async () => {
      const note = this.liveNote(noteId)
      if (input.requestId !== undefined) {
        const receipt = this.document.attachmentReceipts?.[input.requestId]
        if (receipt !== undefined) {
          if (receipt.noteId !== noteId) throw new AppError('invalid-args', 'notes: the requestId is already bound to another note')
          const existing = note.attachments.find((attachment) => attachment.id === receipt.attachmentId)
          if (existing === undefined) throw new AppError('not-found', 'notes: the replayed attachment is no longer on the note')
          result = { note: { ...note }, attachment: existing }
          return
        }
      }
      const decoded = decodeAttachment(input)
      if (attachmentBytes(note.attachments) + decoded.size > MAX_NOTE_ATTACHMENT_BYTES) {
        throw new AppError('attachment-quota', `notes: a note may carry at most ${String(MAX_NOTE_ATTACHMENT_BYTES)} attachment bytes`)
      }
      const stored = await this.attachments.persist(decoded)
      const updated: Note = {
        ...note,
        attachments: [...note.attachments, stored],
        updatedAt: Date.now(),
        version: note.version + 1,
      }
      try {
        await this.persist((document) => ({
          ...document,
          notes: document.notes.map((candidate) => candidate.id === noteId ? updated : candidate),
          ...(input.requestId === undefined ? {} : {
            attachmentReceipts: { ...(document.attachmentReceipts ?? {}), [input.requestId]: { noteId, attachmentId: stored.id } },
          }),
        }))
      } catch (error) {
        await this.attachments.remove(stored.id).catch(() => undefined)
        throw error
      }
      result = { note: updated, attachment: stored }
    })
    ctx.notifyChanged()
    return result!
  }

  /**
   * Read one attachment's bytes for download. Missing bytes are a normal
   * answer (the page shows a missing marker), while a byte file that fails its
   * recorded digest is refused as corruption.
   */
  async downloadAttachment(noteId: string, attachmentId: string): Promise<AttachmentDownload> {
    await this.ensureLoaded()
    const note = this.find(noteId)
    const attachment = note.attachments.find((candidate) => candidate.id === attachmentId)
    if (attachment === undefined) throw new AppError('not-found', `notes: no attachment ${attachmentId}`)
    if (!(await this.attachments.exists(attachment.id))) return { ...attachment, missing: true }
    const bytes = await this.attachments.read(attachment.id)
    if (sha256Of(bytes) !== attachment.sha256 || bytes.length !== attachment.size) {
      throw new AppError('storage-corrupt', `notes: attachment ${attachmentId} does not match its metadata`)
    }
    return { ...attachment, missing: false, dataBase64: Buffer.from(bytes).toString('base64') }
  }

  /** Delete one attachment's metadata and bytes from a live note. */
  async deleteAttachment(noteId: string, attachmentId: string, ctx: OperationContext): Promise<AttachmentDeleteResult> {
    await this.ensureLoaded()
    let result: AttachmentDeleteResult | undefined
    await this.exclusive(async () => {
      const note = this.liveNote(noteId)
      const removed = note.attachments.find((candidate) => candidate.id === attachmentId)
      if (removed === undefined) throw new AppError('not-found', `notes: no attachment ${attachmentId}`)
      const updated: Note = {
        ...note,
        attachments: note.attachments.filter((candidate) => candidate.id !== attachmentId),
        updatedAt: Date.now(),
        version: note.version + 1,
      }
      await this.persist((document) => ({
        ...document,
        notes: document.notes.map((candidate) => candidate.id === noteId ? updated : candidate),
      }))
      await this.attachments.remove(attachmentId)
      result = { note: updated, attachment: removed }
    })
    ctx.notifyChanged()
    return result!
  }

  /**
   * Export every note (including soft-deleted) as JSON, inlining attachment
   * bytes while the cumulative budget allows. Attachments over the budget,
   * missing on disk, or failing their recorded digest carry metadata plus an
   * `omitted` reason and a warning; the JSON is the application's own backup.
   */
  async exportJSON(): Promise<NotesExportResult> {
    await this.ensureLoaded()
    const attachments: Record<string, ExportedAttachment> = {}
    const warnings: string[] = []
    let budget = MAX_EXPORT_ATTACHMENT_BYTES
    for (const note of this.document.notes) {
      for (const attachment of note.attachments) {
        if (attachments[attachment.id] !== undefined) continue
        if (budget < attachment.size) {
          attachments[attachment.id] = { omitted: 'budget' }
          warnings.push(`attachment-omitted:${attachment.id}`)
          continue
        }
        if (!(await this.attachments.exists(attachment.id))) {
          attachments[attachment.id] = { omitted: 'missing' }
          warnings.push(`attachment-missing:${attachment.id}`)
          continue
        }
        const bytes = await this.attachments.read(attachment.id)
        if (sha256Of(bytes) !== attachment.sha256 || bytes.length !== attachment.size) {
          attachments[attachment.id] = { omitted: 'corrupt' }
          warnings.push(`attachment-corrupt:${attachment.id}`)
          continue
        }
        attachments[attachment.id] = { dataBase64: Buffer.from(bytes).toString('base64') }
        budget -= bytes.length
      }
    }
    const document: ExportedNotesDocument = { schemaVersion: SCHEMA_VERSION, notes: this.document.notes, attachments, warnings }
    return { json: JSON.stringify(document), warnings: [...warnings] }
  }

  /**
   * Import a previously exported document, replacing or merging by id. Bytes
   * carried by the export are written to this deployment's attachment store
   * under their exported ids; metadata whose bytes are absent stays a
   * metadata-only attachment (the page shows it as missing). The final document
   * decides which stored bytes are still referenced; the rest are collected.
   */
  async importJSON(json: string, mode: 'merge' | 'overwrite', ctx: OperationContext): Promise<NotesImportResult> {
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
    const malformedAttachments = notes.some((note) => note.attachments !== undefined
      && (!Array.isArray(note.attachments) || note.attachments.some((candidate) => !isAttachmentMeta(candidate))))
    if (malformedAttachments) throw new AppError('invalid-args', 'notes: import contains malformed attachment metadata')
    if (notes.some((note) => oversized(note.attachments ?? []))) {
      throw new AppError('invalid-args', 'notes: import exceeds the per-note attachment byte quota')
    }
    const normalized = notes.map(normalizeNote)
    const bytesToWrite = this.importAttachmentBytes(parsed, normalized)
    for (const item of bytesToWrite) await this.attachments.restore(item.id, item.decoded)
    await this.write((document) => {
      if (mode === 'overwrite') return { schemaVersion: SCHEMA_VERSION, notes: normalized }
      const byId = new Map(document.notes.map((note) => [note.id, note]))
      for (const note of normalized) byId.set(note.id, note)
      return { schemaVersion: SCHEMA_VERSION, notes: [...byId.values()] }
    })
    const referenced = new Set(this.document.notes.flatMap((note) => note.attachments.map((attachment) => attachment.id)))
    let removed = 0
    const warnings: string[] = []
    try {
      removed = await this.attachments.gc(referenced)
    } catch {
      warnings.push('attachment-gc-failed')
    }
    const written = new Set(bytesToWrite.map((item) => item.id))
    let missing = 0
    for (const note of normalized) {
      for (const attachment of note.attachments) {
        if (written.has(attachment.id)) continue
        if (await this.attachments.exists(attachment.id)) continue
        missing += 1
      }
    }
    ctx.notifyChanged()
    return { imported: normalized.length, attachments: { written: bytesToWrite.length, missing, removed }, warnings }
  }

  /**
   * Validate the export document's attachment section and decode the byte
   * carriers it holds. Every carrier must belong to a note's metadata and match
   * that metadata's id, digest and length.
   * @param parsed - the validated top-level import document.
   * @param notes - the validated/normalized note list.
   * @returns the byte carriers to write, in document order.
   * @throws AppError `invalid-args` for a malformed section or a metadata mismatch.
   */
  private importAttachmentBytes(parsed: unknown, notes: readonly Note[]): Array<{ id: string; decoded: DecodedAttachment }> {
    const section = (parsed as { attachments?: unknown }).attachments
    if (section === undefined) return []
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      throw new AppError('invalid-args', 'notes: import has a malformed attachment section')
    }
    const metadata = new Map<string, NoteAttachment>()
    for (const note of notes) for (const attachment of note.attachments) metadata.set(attachment.id, attachment)
    const carriers: Array<{ id: string; decoded: DecodedAttachment }> = []
    for (const [id, value] of Object.entries(section as Record<string, unknown>)) {
      if (!isAttachmentId(id)) throw new AppError('invalid-args', `notes: import has a malformed attachment id (${id})`)
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new AppError('invalid-args', `notes: import has a malformed attachment entry (${id})`)
      }
      const entry = value as { dataBase64?: unknown; omitted?: unknown }
      if (entry.dataBase64 === undefined) {
        if (typeof entry.omitted !== 'string') throw new AppError('invalid-args', `notes: import attachment entry carries neither bytes nor an omission (${id})`)
        continue
      }
      const expected = metadata.get(id)
      if (expected === undefined) throw new AppError('invalid-args', `notes: import carries bytes for an unreferenced attachment (${id})`)
      const decoded = decodeAttachment({ name: expected.name, type: expected.type, dataBase64: entry.dataBase64 as string })
      if (decoded.sha256 !== expected.sha256 || decoded.size !== expected.size) {
        throw new AppError('invalid-args', `notes: imported attachment bytes do not match their metadata (${id})`)
      }
      carriers.push({ id, decoded })
    }
    return carriers
  }

  /** Find one note (live or soft-deleted); a missing id is `not-found`. */
  private find(id: string): Note {
    const note = this.document.notes.find((candidate) => candidate.id === id)
    if (note === undefined) throw new AppError('not-found', `notes: no note ${id}`)
    return note
  }

  /** Find one live note; a soft-deleted note is not writable. */
  private liveNote(id: string): Note {
    const note = this.find(id)
    if (!live(note)) throw new AppError('not-found', `notes: no live note ${id}`)
    return note
  }

  /** Apply one change on the already-serialized snapshot (caller owns the queue). */
  private async persist(change: (document: NotesDocument) => NotesDocument): Promise<void> {
    const next = change(this.document)
    const stored = await this.store.documents.put(DOCUMENT_SCOPE, next, {
      schemaVersion: SCHEMA_VERSION,
      ...(this.revision === undefined ? {} : { expectedRevision: this.revision }),
    })
    this.document = stored.value
    this.revision = stored.revision
  }

  /** Serialize one async unit of work behind every earlier write. */
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work, work)
    this.queue = pending.then(() => undefined, () => undefined)
    return await pending
  }

  /** Apply one document change under the serialized writer. */
  private async write(change: (document: NotesDocument) => NotesDocument): Promise<void> {
    await this.exclusive(async () => { await this.persist(change) })
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
  /** The attachment operations stay closed to the AI and to peer applications: only the page manages files. */
  const local = (description: string, params: Record<string, unknown>, effect: 'read' | 'write', run: (args: never, ctx: OperationContext) => unknown) => ({
    description,
    params,
    result: { type: 'json' as const, description: 'Operation result' },
    effect,
    exposure: { ai: 'closed' as const, peers: 'closed' as const },
    execute: async (args: unknown, ctx: OperationContext) => {
      await repository.ensureLoaded()
      return run(args as never, ctx) as never
    },
  })
  return {
    id: 'notes',
    name: '笔记',
    description: '资料、标签、来源与附件。',
    version: '0.1.1-dev.0',
    generation: 2,
    data: { kind: 'unified', namespace: 'notes', schemaVersion: SCHEMA_VERSION },
    capabilities: ['storage', 'model'],
    objectTypes: { note: { description: 'A note', resolveOperation: 'resolveNote' } },
    start: async (ctx) => {
      repository.attach(ctx.capabilities)
    },
    health: async () => {
      try {
        await repository.ensureLoaded()
        return { status: 'ok' as const }
      } catch (error) {
        return { status: 'degraded' as const, reason: `notes data could not be loaded: ${String((error as Error)?.message ?? error)}` }
      }
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
      get: read('Read one note with its body and attachment byte status', { id: str('Note id', true) }, (args: { id: string }) => repository.get(args.id)) as never,
      summarize: { description: 'Summarize one note, or answer a question from it, through the platform model', params: { id: str('Note id', true), question: str('Optional question') }, result: { type: 'json' as const, description: 'Summary result' }, effect: 'read', exposure: { ai: 'confirm' as const, peers: 'closed' as const }, execute: async (args: unknown, ctx: OperationContext) => await repository.summarize((args as { id: string }).id, (args as { question?: string }).question, ctx) } as never,
      search: read('Search notes by title, tags or body', {
        query: str('Full-text query', true),
        includeDeleted: bool('Include soft-deleted notes'),
      }, (args: { query: string; includeDeleted?: boolean }) => repository.list(args)) as never,
      searchNotes: read('Search notes for another application', {
        query: str('Full-text query', true),
        includeDeleted: bool('Include soft-deleted notes'),
      }, (args: { query: string; includeDeleted?: boolean }) => repository.list(args)) as never,
      resolveNote: read('Resolve one note reference', { id: str('Note id', true) }, (args: { id: string }) => {
        const note = repository.getSync(args.id)
        return { ref: { appId: 'notes', type: 'note', id: args.id }, title: note.title, summary: note.tags.join(' · ') }
      }) as never,
      resolveNotes: read('Resolve note summaries by id', { ids: { type: 'array', items: { type: 'string' }, description: 'Note ids', required: true } }, (args: { ids: string[] }) => repository.resolve(args.ids)) as never,
      listTags: read('List tags with live-note counts', {}, () => repository.tags()) as never,
      create: write('Create a note', { body: str('Markdown body', true), tags: tags('Tags'), pinned: bool('Pinned'), source: { type: 'json' as const, description: 'Source reference' }, requestId: str('Idempotency key') }, (args: { body: string; tags?: string[]; pinned?: boolean; source?: NoteSource; requestId?: string }, ctx: OperationContext) => repository.create(args, ctx)) as never,
      update: write('Update a note', { id: str('Note id', true), expectedVersion: { type: 'integer', description: 'Expected note version', required: true }, body: str('Replacement body'), tags: tags('Replacement tags'), pinned: bool('Pinned') }, (args: { id: string; expectedVersion: number; body?: string; tags?: string[]; pinned?: boolean }, ctx: OperationContext) => repository.update(args.id, args.expectedVersion, args, ctx)) as never,
      delete: write('Soft-delete a note', { id: str('Note id', true) }, (args: { id: string }, ctx: OperationContext) => repository.remove(args.id, ctx)) as never,
      restore: write('Restore a soft-deleted note', { id: str('Note id', true) }, (args: { id: string }, ctx: OperationContext) => repository.restore(args.id, ctx)) as never,
      uploadAttachment: local('Attach one file to a note', {
        noteId: str('Note id', true),
        name: str('Original file name', true),
        type: str('MIME type (whitelist only)', true),
        dataBase64: str('Exact file bytes, canonical base64', true),
        requestId: str('Idempotency key'),
      }, 'write', (args: { noteId: string; name: string; type: string; dataBase64: string; requestId?: string }, ctx: OperationContext) => repository.uploadAttachment(args.noteId, args, ctx)) as never,
      downloadAttachment: local('Read one attachment as base64, or its missing marker', {
        noteId: str('Note id', true),
        attachmentId: str('Attachment id', true),
      }, 'read', (args: { noteId: string; attachmentId: string }) => repository.downloadAttachment(args.noteId, args.attachmentId)) as never,
      deleteAttachment: local('Delete one attachment and its bytes', {
        noteId: str('Note id', true),
        attachmentId: str('Attachment id', true),
      }, 'write', (args: { noteId: string; attachmentId: string }, ctx: OperationContext) => repository.deleteAttachment(args.noteId, args.attachmentId, ctx)) as never,
      exportNotes: {
        description: 'Export all notes as JSON, inlining attachment bytes within the export budget',
        params: {},
        result: { type: 'json', description: 'Exported JSON string and warnings' },
        effect: 'read',
        exposure: { ai: 'closed', peers: 'closed' },
        execute: async () => await repository.exportJSON(),
      },
      importNotes: {
        description: 'Import notes (and their attachment bytes) from JSON',
        params: { json: str('Exported JSON', true), mode: str('merge or overwrite') },
        result: { type: 'json', description: 'Import result' },
        effect: 'write',
        exposure: { ai: 'closed', peers: 'closed' },
        execute: async (args, ctx) => await repository.importJSON((args as { json: string }).json, (args as { mode?: 'merge' | 'overwrite' }).mode ?? 'merge', ctx),
      },
    },
  }
}
