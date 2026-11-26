/**
 * The notes application's own attachment byte store.
 *
 * The note document (the unified application store) keeps only the metadata of
 * each attachment — `{ id, name, size, type, sha256 }` — while the bytes live in
 * an application-owned directory the deployment binds with
 * `dshHomePath('application-harness/notes/attachments')` and lists in its
 * `homeFiles`. That split is deliberate: the platform's whole-store backup is
 * the unified SQLite namespace alone, so attachment bytes are backed up by the
 * application's own JSON export (small files inline as base64) and the
 * deployment's home directory — never by the platform.
 *
 * This module owns the byte-layer rules, stated once:
 *
 * - a file id is generated here (`att_<uuid>`); a path is resolved only under
 *   the store root, so an imported/garbage metadata id cannot escape it;
 * - writes are atomic (unique temp name → write + fsync → rename), so a reader
 *   never sees a torn attachment;
 * - input is canonical base64 only, bounded by {@link MAX_ATTACHMENT_BYTES} and
 *   restricted to {@link ALLOWED_ATTACHMENT_TYPES}; executable extensions are
 *   refused even under an allowed type;
 * - the content digest (`sha256`) is the metadata's integrity claim, verified
 *   on download/export;
 * - {@link AttachmentStore.gc} removes every stored byte no note references.
 *
 * The directory is created lazily (mode 0700) on the first write; reads never
 * create it, so a deployment that never attaches a file leaves no directory.
 * @module @matrix1001/dsh-application-harness-notes/attachments
 */

import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { isMissingFile, reasonOf } from '@matrix1001/dsh-application-harness-store/atomic'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'

/** Largest single attachment, in bytes (2 MiB). */
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024
/** Largest attachment total one note may carry, in bytes (20 MiB). */
export const MAX_NOTE_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** Largest attachment-byte total one JSON export inlines, in bytes (8 MiB). */
export const MAX_EXPORT_ATTACHMENT_BYTES = 8 * 1024 * 1024
/** Longest display name an attachment may carry, in characters. */
export const MAX_ATTACHMENT_NAME = 200

/** The one shape a generated/imported attachment id has. */
const ATTACHMENT_ID = /^att_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
/** Canonical base64: full groups plus one correctly padded final group (if any). */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
/** A lowercase hex SHA-256 digest. */
const SHA256 = /^[0-9a-f]{64}$/u
/** Characters that would make a display name unsafe once it becomes a path or a download name. */
const UNSAFE_NAME = /[\\/\u0000-\u001f\u007f]/u

/**
 * The MIME types a note attachment may carry. A whitelist (not a blacklist):
 * anything not named here is refused, including every executable/script type.
 */
const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/pdf',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/markdown',
  'text/plain',
])

/**
 * Executable/script extensions refused even when the declared MIME type is on
 * the whitelist (the download name is user-visible, and a future extractor must
 * never treat one of these as runnable).
 */
const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  'app', 'bat', 'cjs', 'cmd', 'com', 'dll', 'dmg', 'exe', 'jar', 'js', 'mjs', 'msi', 'ps1', 'scr', 'sh', 'so', 'vbs',
])

/** One attachment's durable metadata; the bytes are not part of the note document. */
export interface NoteAttachment {
  /** The generated file id (`att_<uuid>`), also the byte file's name. */
  id: string
  /** The original display name (used for download; never a path). */
  name: string
  /** Exact byte length. */
  size: number
  /** Normalized MIME type, always one of {@link ALLOWED_TYPES}. */
  type: string
  /** Lowercase hex SHA-256 of the exact bytes. */
  sha256: string
}

/** One upload as an operation argument: strict canonical base64 plus a declared name/type. */
export interface AttachmentUpload {
  name: string
  type: string
  dataBase64: string
}

/** One validated upload, decoded once so the caller can quota-check and persist it. */
export interface DecodedAttachment {
  name: string
  type: string
  bytes: Uint8Array
  size: number
  sha256: string
}

/** A per-process temp-name sequence, so two writes never share a temp file. */
let tempSeq = 0

/**
 * Whether a value is one of this store's generated attachment ids.
 * @param value - the candidate (store or import input).
 * @returns whether it matches the id shape.
 */
export function isAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && ATTACHMENT_ID.test(value)
}

/**
 * Resolve one attachment id against the store root, refusing anything that
 * resolves outside it (a traversal id can only come from tampered document
 * metadata, but the byte layer never trusts its caller).
 * @param root - the store's absolute root directory.
 * @param id - the attachment id to resolve.
 * @returns the absolute path of the byte file.
 * @throws AppError `invalid-args` for a traversal or malformed id.
 */
export function attachmentPath(root: string, id: string): string {
  const path = resolve(root, id)
  const rel = relative(root, path)
  if (rel === '' || rel.startsWith('..')) throw new AppError('invalid-args', `notes: attachment path escapes its store (${id})`)
  if (!isAttachmentId(id)) throw new AppError('invalid-args', `notes: malformed attachment id (${id})`)
  return path
}

/**
 * Normalize one attachment display name.
 * @param name - the untrusted name.
 * @returns the trimmed, safe name.
 * @throws AppError `invalid-args` for a missing, oversized or unsafe name.
 */
export function normalizeAttachmentName(name: unknown): string {
  if (typeof name !== 'string') throw new AppError('invalid-args', 'notes: attachment name must be a string')
  const normalized = name.trim()
  if (normalized === '') throw new AppError('invalid-args', 'notes: attachment name is empty')
  if (normalized.length > MAX_ATTACHMENT_NAME) throw new AppError('invalid-args', `notes: attachment name must be at most ${String(MAX_ATTACHMENT_NAME)} characters`)
  if (UNSAFE_NAME.test(normalized)) throw new AppError('invalid-args', 'notes: attachment name contains an unsafe character')
  return normalized
}

/**
 * Normalize one attachment MIME type against the whitelist.
 * @param type - the untrusted type.
 * @returns the trimmed lowercase type.
 * @throws AppError `invalid-args` for a non-string, `attachment-type` for a type outside the whitelist.
 */
export function normalizeAttachmentType(type: unknown): string {
  if (typeof type !== 'string') throw new AppError('invalid-args', 'notes: attachment type must be a string')
  const normalized = type.trim().toLowerCase()
  if (!ALLOWED_TYPES.has(normalized)) throw new AppError('attachment-type', `notes: ${normalized === '' ? '(empty)' : normalized} is not a permitted attachment type`)
  return normalized
}

/**
 * Refuse an executable/script extension even under an allowed MIME type.
 * @param name - an already normalized display name.
 * @throws AppError `attachment-type` for a blocked extension.
 */
export function assertAttachmentNameSafe(name: string): void {
  const dot = name.lastIndexOf('.')
  if (dot >= 0 && BLOCKED_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) {
    throw new AppError('attachment-type', `notes: ${name} has an executable extension`)
  }
}

/**
 * The SHA-256 digest the metadata carries, as lowercase hex.
 * @param bytes - the exact attachment bytes.
 * @returns the digest.
 */
export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Decode one upload's bytes, refusing anything that is not canonical base64 or
 * that exceeds {@link MAX_ATTACHMENT_BYTES}. An empty payload is refused too —
 * an attachment with no bytes has nothing to back up or download.
 * @param dataBase64 - the declared bytes.
 * @returns the decoded bytes.
 * @throws AppError `invalid-args` for a non-canonical payload, `attachment-too-large` over the limit.
 */
export function decodeAttachmentBase64(dataBase64: unknown): Uint8Array {
  if (typeof dataBase64 !== 'string') throw new AppError('invalid-args', 'notes: attachment data must be a base64 string')
  if (!BASE64.test(dataBase64)) throw new AppError('invalid-args', 'notes: attachment data is not canonical base64')
  const bytes = Buffer.from(dataBase64, 'base64')
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new AppError('attachment-too-large', `notes: an attachment may be at most ${String(MAX_ATTACHMENT_BYTES)} bytes`)
  if (bytes.length === 0) throw new AppError('invalid-args', 'notes: attachment data is empty')
  if (bytes.toString('base64') !== dataBase64) throw new AppError('invalid-args', 'notes: attachment data is not canonical base64')
  return bytes
}

/**
 * Validate one upload completely (name, type, extension, bytes) and decode it.
 * @param input - the untrusted operation argument.
 * @returns the validated upload with its size and digest.
 * @throws AppError `invalid-args` / `attachment-type` / `attachment-too-large`.
 */
export function decodeAttachment(input: AttachmentUpload): DecodedAttachment {
  const name = normalizeAttachmentName(input.name)
  const type = normalizeAttachmentType(input.type)
  assertAttachmentNameSafe(name)
  const bytes = decodeAttachmentBase64(input.dataBase64)
  return { name, type, bytes, size: bytes.length, sha256: sha256Of(bytes) }
}

/**
 * Whether one value is well-formed attachment metadata (as stored in the note
 * document, as imported, or as exported). Used to normalize a loaded document
 * (drop junk) and to refuse a malformed import.
 * @param value - the untrusted candidate.
 * @returns whether it is a complete {@link NoteAttachment}.
 */
export function isAttachmentMeta(value: unknown): value is NoteAttachment {
  if (typeof value !== 'object' || value === null) return false
  const meta = value as Record<string, unknown>
  if (!isAttachmentId(meta['id'])) return false
  const name = meta['name']
  if (typeof name !== 'string' || name.trim() === '') return false
  const size = meta['size']
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) return false
  const type = meta['type']
  if (typeof type !== 'string' || !ALLOWED_TYPES.has(type)) return false
  const sha256 = meta['sha256']
  return typeof sha256 === 'string' && SHA256.test(sha256)
}

/**
 * Write one file durably: open (mode 0600), write the complete bytes, fsync,
 * close. The rename that publishes it is the caller's.
 * @param path - the temp file to write.
 * @param bytes - the exact content.
 * @returns when the bytes are on disk and synced.
 */
async function writeDurable(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'w', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * The attachment byte store: one root directory, generated ids, atomic writes,
 * integrity-checked reads and unreferenced-file collection. It performs no
 * document bookkeeping — the note repository owns which ids are referenced.
 */
export class AttachmentStore {
  private readonly root: string
  private rootReady = false

  /** @param root - the absolute directory the deployment binds for attachment bytes. */
  constructor(root: string) {
    this.root = resolve(root)
  }

  /**
   * Durably store a decoded upload under a freshly generated id.
   * @param decoded - the validated bytes and metadata.
   * @returns the stored attachment's metadata.
   * @throws AppError `storage-failed` when the bytes cannot be written.
   */
  async persist(decoded: DecodedAttachment): Promise<NoteAttachment> {
    return await this.write(`att_${randomUUID()}`, decoded)
  }

  /**
   * Durably store an imported attachment under its exported id (an import must
   * keep the id its note metadata names).
   * @param id - the exported attachment id.
   * @param decoded - the validated bytes and metadata.
   * @returns the stored attachment's metadata.
   * @throws AppError `invalid-args` for a malformed id, `storage-failed` when the bytes cannot be written.
   */
  async restore(id: string, decoded: DecodedAttachment): Promise<NoteAttachment> {
    if (!isAttachmentId(id)) throw new AppError('invalid-args', `notes: malformed attachment id (${id})`)
    return await this.write(id, decoded)
  }

  /**
   * Read one attachment's exact bytes.
   * @param id - the attachment id from the note metadata.
   * @returns the bytes.
   * @throws AppError `invalid-args` for a bad id, `not-found` when no bytes exist, `storage-failed` for an I/O failure.
   */
  async read(id: string): Promise<Uint8Array> {
    const path = attachmentPath(this.root, id)
    try {
      return await readFile(path)
    } catch (error) {
      if (isMissingFile(error)) throw new AppError('not-found', `notes: no attachment bytes ${id}`)
      throw new AppError('storage-failed', `notes: could not read attachment ${id}: ${reasonOf(error)}`)
    }
  }

  /**
   * Whether the bytes for one id exist.
   * @param id - the attachment id from the note metadata.
   * @returns whether the byte file exists.
   * @throws AppError `invalid-args` for a bad id, `storage-failed` for an I/O failure.
   */
  async exists(id: string): Promise<boolean> {
    const path = attachmentPath(this.root, id)
    try {
      await access(path)
      return true
    } catch (error) {
      if (isMissingFile(error)) return false
      throw new AppError('storage-failed', `notes: could not inspect attachment ${id}: ${reasonOf(error)}`)
    }
  }

  /**
   * Remove one attachment's bytes; removing an already-missing file is a no-op.
   * @param id - the attachment id.
   * @throws AppError `invalid-args` for a bad id, `storage-failed` for an I/O failure.
   */
  async remove(id: string): Promise<void> {
    const path = attachmentPath(this.root, id)
    try {
      await unlink(path)
    } catch (error) {
      if (isMissingFile(error)) return
      throw new AppError('storage-failed', `notes: could not delete attachment ${id}: ${reasonOf(error)}`)
    }
  }

  /**
   * Remove every stored byte file whose id is not in `referenced`. A missing
   * root is an empty store; non-attachment entries (stray temp files, junk) are
   * left alone.
   * @param referenced - the attachment ids the (post-import) document references.
   * @returns how many files were removed.
   * @throws AppError `storage-failed` when the root cannot be listed.
   */
  async gc(referenced: ReadonlySet<string>): Promise<number> {
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch (error) {
      if (isMissingFile(error)) return 0
      throw new AppError('storage-failed', `notes: could not list attachment bytes: ${reasonOf(error)}`)
    }
    let removed = 0
    for (const entry of entries) {
      if (!isAttachmentId(entry) || referenced.has(entry)) continue
      await this.remove(entry)
      removed += 1
    }
    return removed
  }

  /**
   * Atomically publish one byte file: write a unique sibling temp file
   * durably, then rename it over the id path. A failure removes this attempt's
   * temp file (best effort — the original failure is what surfaces).
   * @param id - the attachment id (already validated).
   * @param decoded - the validated content.
   * @returns the stored metadata.
   */
  private async write(id: string, decoded: DecodedAttachment): Promise<NoteAttachment> {
    await this.ensureRoot()
    const target = attachmentPath(this.root, id)
    tempSeq += 1
    const temp = `${target}.${String(process.pid)}.${String(tempSeq)}.tmp`
    try {
      await writeDurable(temp, decoded.bytes)
      await rename(temp, target)
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw new AppError('storage-failed', `notes: could not store attachment ${id}: ${reasonOf(error)}`)
    }
    return { id, name: decoded.name, size: decoded.size, type: decoded.type, sha256: decoded.sha256 }
  }

  /**
   * Create the store root lazily (recursive, mode 0700) before the first write.
   * A failed creation is not cached, so a later write retries it.
   * @throws AppError `storage-failed` when the directory cannot be created.
   */
  private async ensureRoot(): Promise<void> {
    if (this.rootReady) return
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new AppError('storage-failed', `notes: could not create the attachment directory: ${reasonOf(error)}`)
    }
    this.rootReady = true
  }
}
