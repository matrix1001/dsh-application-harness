/**
 * The durable-write primitive: `writeFileDurable` (write + fsync) and
 * `writeFileAtomic` (temp + fsync + rename) — the single home for a protocol
 * that used to be copied per package (arch-review 2026-09-15,
 * `durable-document-write-protocol-not-shared-and-weaker-in-apps`). The
 * failure branches are exercised for real: an unwritable parent makes the temp
 * write fail AND the cleanup unlink fail (the swallow that must not mask the
 * original error).
 *
 * The shared seam the two candidate-then-rename repositories sit on is here
 * and the two file-error helpers (`isMissingFile` / `reasonOf`).
 * exercised for real against the filesystem, not through a double.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isMissingFile, reasonOf, writeFileAtomic, writeFileDurable } from '../src/atomic.ts'

const dirs: string[] = []

/** A fresh temp directory removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-atomic-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('writeFileDurable', () => {
  it('writes the complete content and leaves no temp file behind', async () => {
    const dir = tempDir()
    const path = join(dir, 'doc.json')
    await writeFileDurable(path, '{"中文":"内容"}')
    expect(readFileSync(path, 'utf8')).toBe('{"中文":"内容"}')
    expect(readdirSync(dir)).toEqual(['doc.json'])
  })

  it('honours an explicit file mode for the durable write and the atomic publish', async () => {
    const dir = tempDir()
    // The kernel ANDs the requested mode with the process umask, so derive the
    // expected bits from a default-mode (0o666) probe file: 0o640 is a subset
    // of 0o666, and the probe leaves exactly the umask's surviving bits.
    const probe = join(dir, 'probe.json')
    writeFileSync(probe, '')
    const expected = 0o640 & (statSync(probe).mode & 0o777)
    const direct = join(dir, 'direct.json')
    await writeFileDurable(direct, 'direct', 0o640)
    expect(statSync(direct).mode & 0o777).toBe(expected)
    const atomic = join(dir, 'atomic.json')
    await writeFileAtomic(atomic, 'atomic', 0o640)
    expect(readFileSync(atomic, 'utf8')).toBe('atomic')
    expect(statSync(atomic).mode & 0o777).toBe(expected)
  })
})

describe('writeFileAtomic', () => {
  it('creates parents, publishes by rename, and never leaves the temp name behind', async () => {
    const dir = tempDir()
    const path = join(dir, 'nested', 'deep', 'doc.json')
    await writeFileAtomic(path, 'first')
    expect(readFileSync(path, 'utf8')).toBe('first')
    // A second write replaces in place (the temp name is per-attempt).
    await writeFileAtomic(path, 'second')
    expect(readFileSync(path, 'utf8')).toBe('second')
    expect(readdirSync(join(dir, 'nested', 'deep'))).toEqual(['doc.json'])
  })

  it('surfaces the write failure and survives a failing cleanup unlink (unwritable parent)', async () => {
    const dir = tempDir()
    const path = join(dir, 'doc.json')
    chmodSync(dir, 0o500) // read+execute only: the temp write fails with EACCES
    await expect(writeFileAtomic(path, 'nope')).rejects.toThrow(/EACCES|permission/i)
    chmodSync(dir, 0o700)
    // The cleanup unlink also failed (nothing was created) — and the ORIGINAL
    // error is what surfaced, not the cleanup's.
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('cleans its temp file when the rename fails (the target is a directory)', async () => {
    const dir = tempDir()
    const path = join(dir, 'doc.json')
    mkdirSync(path) // a directory at the target: rename(2) refuses
    await expect(writeFileAtomic(path, 'x')).rejects.toThrow(/EISDIR|ENOTDIR|directory|EACCES|EPERM/i)
    // Only the directory remains: this attempt's temp file was removed.
    expect(readdirSync(dir)).toEqual(['doc.json'])
  })

  it('replaces an existing file in one step (the old content is never torn)', async () => {
    const dir = tempDir()
    const path = join(dir, 'doc.json')
    writeFileSync(path, '旧内容')
    await writeFileAtomic(path, '新内容')
    expect(readFileSync(path, 'utf8')).toBe('新内容')
  })
})

describe('the shared vocabulary of a document repository', () => {
  it('isMissingFile is true only for an object carrying code ENOENT', () => {
    expect(isMissingFile(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe(true)
    expect(isMissingFile(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe(false)
    // Not an object at all — the first guard short-circuits.
    expect(isMissingFile('ENOENT')).toBe(false)
    // An object whose code cannot be read — `null` is the value that would
    // otherwise blow the property read up.
    expect(isMissingFile(null)).toBe(false)
  })

  it('reasonOf takes an Error message and stringifies everything else', () => {
    expect(reasonOf(new Error('磁盘满了'))).toBe('磁盘满了')
    expect(reasonOf('磁盘满了')).toBe('磁盘满了')
  })

})
