import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_NAME,
  AttachmentStore,
  attachmentPath,
  assertAttachmentNameSafe,
  decodeAttachment,
  decodeAttachmentBase64,
  isAttachmentId,
  isAttachmentMeta,
  normalizeAttachmentName,
  normalizeAttachmentType,
  sha256Of,
  type AttachmentUpload,
  type NoteAttachment,
} from '../src/attachments.ts'

const dirs: string[] = []
const FIXTURE_ID = 'att_123e4567-e89b-42d3-a456-426614174000'
const OTHER_ID = 'att_123e4567-e89b-42d3-a456-426614174001'

/** A fresh temp directory removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'notes-attachments-'))
  dirs.push(dir)
  return dir
}

/** The strict base64 of a small text payload. */
function encoded(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

/** One valid upload input. */
function upload(overrides: Partial<AttachmentUpload> = {}): AttachmentUpload {
  return { name: 'note.txt', type: 'text/plain', dataBase64: encoded('hello attachment'), ...overrides }
}

/** One valid metadata object for a stored upload. */
function meta(overrides: Partial<NoteAttachment> = {}): NoteAttachment {
  return {
    id: FIXTURE_ID,
    name: 'note.txt',
    size: 5,
    type: 'text/plain',
    sha256: sha256Of(Buffer.from('hello', 'utf8')),
    ...overrides,
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700)
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort on a test that failed before restoring a chmod.
    }
  }
})

describe('attachment ids and paths', () => {
  it('recognizes only generated ids', () => {
    expect(isAttachmentId(FIXTURE_ID)).toBe(true)
    expect(isAttachmentId('att_123E4567-E89B-42D3-A456-426614174000')).toBe(false)
    expect(isAttachmentId('n_123e4567-e89b-42d3-a456-426614174000')).toBe(false)
    expect(isAttachmentId('')).toBe(false)
    expect(isAttachmentId(7)).toBe(false)
  })

  it('resolves inside the root and refuses traversal or malformed ids', () => {
    const root = tempDir()
    expect(attachmentPath(root, FIXTURE_ID)).toBe(join(root, FIXTURE_ID))
    // An empty id resolves to the root itself.
    expect(() => attachmentPath(root, '')).toThrow(/escapes its store/u)
    expect(() => attachmentPath(root, '.')).toThrow(/escapes its store/u)
    expect(() => attachmentPath(root, '../outside')).toThrow(/escapes its store/u)
    expect(() => attachmentPath(root, 'not-an-id')).toThrow(/malformed attachment id/u)
  })
})

describe('attachment name/type rules', () => {
  it('trims and accepts a plain name', () => {
    expect(normalizeAttachmentName('  report.pdf  ')).toBe('report.pdf')
  })

  it('refuses unsafe, blank and oversized names', () => {
    expect(() => normalizeAttachmentName(7)).toThrow(/must be a string/u)
    expect(() => normalizeAttachmentName('   ')).toThrow(/is empty/u)
    expect(() => normalizeAttachmentName('x'.repeat(MAX_ATTACHMENT_NAME + 1))).toThrow(/at most/u)
    expect(() => normalizeAttachmentName('a/b.txt')).toThrow(/unsafe/u)
    expect(() => normalizeAttachmentName('a\\b.txt')).toThrow(/unsafe/u)
    expect(() => normalizeAttachmentName('a\u0000b.txt')).toThrow(/unsafe/u)
  })

  it('normalizes the MIME type and enforces the whitelist', () => {
    expect(normalizeAttachmentType('  Text/Plain ')).toBe('text/plain')
    expect(() => normalizeAttachmentType(7)).toThrow(/must be a string/u)
    expect(() => normalizeAttachmentType('   ')).toThrow(/\(empty\) is not a permitted/u)
    expect(() => normalizeAttachmentType('application/x-msdownload')).toThrow(/is not a permitted/u)
  })

  it('refuses executable extensions even under an allowed type', () => {
    expect(() => assertAttachmentNameSafe('README')).not.toThrow()
    expect(() => assertAttachmentNameSafe('photo.png')).not.toThrow()
    expect(() => assertAttachmentNameSafe('installer.EXE')).toThrow(/executable extension/u)
  })
})

describe('attachment bytes', () => {
  it('hashes the exact bytes', () => {
    expect(sha256Of(Buffer.from('abc', 'utf8'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('decodes canonical base64 and refuses every non-canonical shape', () => {
    expect(Buffer.from(decodeAttachmentBase64(encoded('hello'))).toString('utf8')).toBe('hello')
    expect(() => decodeAttachmentBase64(7)).toThrow(/base64 string/u)
    expect(() => decodeAttachmentBase64('not base64!')).toThrow(/not canonical base64/u)
    expect(() => decodeAttachmentBase64('')).toThrow(/is empty/u)
    // Trailing bits that do not round-trip are refused even though the four
    // characters alone pass the shape test.
    expect(() => decodeAttachmentBase64('AB==')).toThrow(/not canonical base64/u)
    const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1).toString('base64')
    expect(() => decodeAttachmentBase64(oversized)).toThrow(/at most/u)
  })

  it('validates a whole upload once', () => {
    const decoded = decodeAttachment(upload())
    expect(decoded).toMatchObject({ name: 'note.txt', type: 'text/plain', size: Buffer.byteLength('hello attachment') })
    expect(decoded.sha256).toBe(sha256Of(decoded.bytes))
  })

  it('validates stored metadata in both directions', () => {
    expect(isAttachmentMeta(meta())).toBe(true)
    expect(isAttachmentMeta(null)).toBe(false)
    expect(isAttachmentMeta('att_x')).toBe(false)
    expect(isAttachmentMeta(meta({ id: 'bad' }))).toBe(false)
    expect(isAttachmentMeta(meta({ name: 7 as never }))).toBe(false)
    expect(isAttachmentMeta(meta({ name: '   ' }))).toBe(false)
    expect(isAttachmentMeta(meta({ size: '5' as never }))).toBe(false)
    expect(isAttachmentMeta(meta({ size: 1.5 }))).toBe(false)
    expect(isAttachmentMeta(meta({ size: -1 }))).toBe(false)
    expect(isAttachmentMeta(meta({ size: MAX_ATTACHMENT_BYTES + 1 }))).toBe(false)
    expect(isAttachmentMeta(meta({ type: 7 as never }))).toBe(false)
    expect(isAttachmentMeta({ ...meta(), type: 'application/x-msdownload' })).toBe(false)
    expect(isAttachmentMeta({ ...meta(), sha256: 7 })).toBe(false)
    expect(isAttachmentMeta({ ...meta(), sha256: 'ABC' })).toBe(false)
  })
})

describe('AttachmentStore', () => {
  it('creates the root lazily with 0700 and writes/reads exact bytes atomically', async () => {
    const dir = tempDir()
    const root = join(dir, 'nested', 'attachments')
    const store = new AttachmentStore(root)
    expect(existsSync(root)).toBe(false)
    // A read of a missing store does not create it.
    await expect(store.read(OTHER_ID)).rejects.toMatchObject({ code: 'not-found' })
    expect(existsSync(root)).toBe(false)
    const stored = await store.persist(decodeAttachment(upload()))
    expect(statSync(root).mode & 0o777).toBe(0o700)
    const file = join(root, stored.id)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toBe('hello attachment')
    // Only the published file remains: the temp name never survives.
    expect(readdirSync(root)).toEqual([stored.id])
    expect(Buffer.from(await store.read(stored.id)).toString('utf8')).toBe('hello attachment')
    expect(await store.exists(stored.id)).toBe(true)
    expect(await store.exists(OTHER_ID)).toBe(false)
    // The second write reuses the already-created root.
    const second = await store.persist(decodeAttachment(upload({ name: 'b.md', type: 'text/markdown', dataBase64: encoded('# b') })))
    expect(new Set(readdirSync(root))).toEqual(new Set([stored.id, second.id]))
  })

  it('restores an exported id and replaces its bytes on a repeated import', async () => {
    const dir = tempDir()
    const store = new AttachmentStore(dir)
    const first = await store.restore(FIXTURE_ID, decodeAttachment(upload()))
    expect(first.id).toBe(FIXTURE_ID)
    await expect(store.restore('not-an-id', decodeAttachment(upload()))).rejects.toMatchObject({ code: 'invalid-args' })
    const replaced = await store.restore(FIXTURE_ID, decodeAttachment(upload({ dataBase64: encoded('replacement') })))
    expect(Buffer.from(await store.read(FIXTURE_ID)).toString('utf8')).toBe('replacement')
    expect(replaced.size).toBe(Buffer.byteLength('replacement'))
  })

  it('removes bytes idempotently and collects only unreferenced id files', async () => {
    const dir = tempDir()
    const root = join(dir, 'attachments')
    const store = new AttachmentStore(root)
    const kept = await store.persist(decodeAttachment(upload()))
    const dropped = await store.persist(decodeAttachment(upload({ name: 'drop.txt' })))
    writeFileSync(join(root, 'notes.json'), '{}')
    mkdirSync(join(root, 'subdir'))
    const removed = await store.gc(new Set([kept.id]))
    expect(removed).toBe(1)
    expect(existsSync(join(root, dropped.id))).toBe(false)
    expect(readdirSync(root).sort()).toEqual([kept.id, 'notes.json', 'subdir'].sort())
    await store.remove(OTHER_ID)
    await store.remove(kept.id)
    expect(existsSync(join(root, kept.id))).toBe(false)
    // A missing root is an empty store.
    expect(await new AttachmentStore(join(dir, 'gone')).gc(new Set())).toBe(0)
  })

  it('reports I/O failures as storage errors instead of hiding them', async () => {
    const dir = tempDir()
    const root = join(dir, 'attachments')
    const store = new AttachmentStore(root)
    const stored = await store.persist(decodeAttachment(upload()))

    chmodSync(join(root, stored.id), 0o000)
    await expect(store.read(stored.id)).rejects.toMatchObject({ code: 'storage-failed' })
    chmodSync(join(root, stored.id), 0o600)

    chmodSync(root, 0o000)
    await expect(store.exists(stored.id)).rejects.toMatchObject({ code: 'storage-failed' })
    chmodSync(root, 0o700)

    chmodSync(root, 0o500)
    await expect(store.remove(stored.id)).rejects.toMatchObject({ code: 'storage-failed' })
    chmodSync(root, 0o700)

    // A read-only root fails the temp write; the cleanup unlink also fails and
    // must not mask the original failure.
    chmodSync(root, 0o500)
    await expect(store.persist(decodeAttachment(upload({ name: 'denied.txt' })))).rejects.toMatchObject({ code: 'storage-failed' })
    chmodSync(root, 0o700)

    // A directory in the target's place makes the rename fail; the temp file is
    // cleaned up.
    const collision = join(root, OTHER_ID)
    mkdirSync(collision)
    await expect(store.restore(OTHER_ID, decodeAttachment(upload()))).rejects.toMatchObject({ code: 'storage-failed' })
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(readdirSync(collision)).toEqual([])

    // A root that is actually a file cannot be listed.
    const fileRoot = join(dir, 'not-a-directory')
    writeFileSync(fileRoot, 'x')
    await expect(new AttachmentStore(fileRoot).gc(new Set())).rejects.toMatchObject({ code: 'storage-failed' })

    // A root under a regular file cannot be created.
    await expect(new AttachmentStore(join(fileRoot, 'attachments')).persist(decodeAttachment(upload()))).rejects.toMatchObject({ code: 'storage-failed' })
    rmSync(collision, { recursive: true, force: true })
  })
})
