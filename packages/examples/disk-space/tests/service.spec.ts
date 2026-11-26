/**
 * The application's end-to-end scenarios over throwaway directories: a real
 * scan and its browse readers, cancellation and single-flight, duplicate
 * analysis, path validation, and the reversible trash (stage → restore →
 * conflict → purge). Every test uses a temporary root; the real home directory
 * is never scanned.
 */
import { access, chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiskSpaceService } from '../src/service.ts'
import type { ScanIo } from '../src/scanner.ts'
import type { Stats } from 'node:fs'
import { makeContext, putFile, removeTree, settleTasks, tempDir, type TestContext } from './helpers.ts'

let root: string
let workDir: string
let dbPath: string
let service: DiskSpaceService

beforeEach(async () => {
  root = await tempDir('dsh-disk-space-root-')
  workDir = await tempDir('dsh-disk-space-db-')
  dbPath = join(workDir, 'index.db')
  service = new DiskSpaceService(dbPath)
})

afterEach(async () => {
  service.close()
  await removeTree(root)
  await removeTree(workDir)
})

/** Start one scan and wait for its task to settle. */
async function scanNow(context: TestContext, directory = root, args: Record<string, unknown> = {}): Promise<string> {
  const result = await service.startScan({ dir: directory, ...args }, context.ctx)
  await settleTasks(context)
  return result.scan.scanId
}

/** Create the standard duplicate fixture: three identical 10-byte files and one solo. */
async function duplicateFixture(): Promise<void> {
  await putFile(join(root, 'dup', 'a.bin'), '0123456789')
  await putFile(join(root, 'dup', 'b.bin'), '0123456789')
  await putFile(join(root, 'dup', 'c.bin'), '0123456789')
  await putFile(join(root, 'solo.txt'), 'unique')
  await putFile(join(root, 'empty-a'), '')
  await putFile(join(root, 'empty-b'), '')
}

describe('scan', () => {
  it('walks a directory, exposes progress/readers and refuses a second heavy run', async () => {
    await putFile(join(root, 'a.txt'), 'hello')
    await putFile(join(root, 'sub', 'b.bin'), 'abcdefgh')
    await mkdir(join(root, 'empty'))
    await symlink(join(root, 'a.txt'), join(root, 'link.txt'))
    const context = makeContext()

    const started = await service.startScan({ dir: root }, context.ctx)
    expect(started.scan).toMatchObject({ root, state: 'running', duplicateState: 'idle', endedAt: null, error: null })
    expect(started.scan.scanId).toMatch(/^s_/)
    await expect(service.startScan({ dir: root }, context.ctx)).rejects.toMatchObject({ code: 'busy' })
    await settleTasks(context)

    const read = service.readScan({ scanId: started.scan.scanId }).scan!
    expect(read).toMatchObject({ state: 'completed', files: 2, dirs: 2, bytes: 13 })
    expect(read.progress).toMatchObject({ files: 2, dirs: 2, bytes: 13, skipped: 1 })
    expect(read.excludes).toEqual([])
    expect(read.crossFileSystems).toBe(false)
    expect(read.endedAt).toBeTypeOf('number')
    expect(context.notifications()).toBeGreaterThan(0)
    expect(context.progress.length).toBeGreaterThan(0)

    expect(service.readScan({}).scan?.scanId).toBe(started.scan.scanId)
    expect(service.listScans({ limit: 1 }).scans).toHaveLength(1)
    expect(service.listScans({}).scans).toHaveLength(1)

    const top = service.browseDirectory({ scanId: read.scanId })
    expect(top.total).toBe(3)
    expect(top.entries.find(entry => entry.path === 'sub')?.size).toBe(8)
    expect(top.entries.every(entry => entry.path !== 'link.txt')).toBe(true)
    expect(service.browseDirectory({ scanId: read.scanId, path: 'sub' }).entries[0]?.path).toBe('sub/b.bin')
    expect(service.browseDirectory({ scanId: read.scanId, path: '', offset: 0, limit: 2 }).entries).toHaveLength(2)
    expect(() => service.browseDirectory({ scanId: read.scanId, path: 'a.txt' })).toThrow(/not a directory/)
    expect(() => service.browseDirectory({ scanId: read.scanId, path: 'missing' })).toThrow(/no indexed path/)
    expect(() => service.browseDirectory({ scanId: 'nope' })).toThrow(/no scan/)
    expect(service.listLargeFiles({ scanId: read.scanId, limit: 1 })).toMatchObject({ total: 2, files: [{ path: 'sub/b.bin' }] })
    expect(() => service.listLargeFiles({ scanId: 'nope' })).toThrow(/no scan/)
    expect(() => service.readScan({ scanId: 'nope' })).toThrow(/no scan/)
    expect(service.readScan({ scanId: read.scanId }).scan?.scanId).toBe(read.scanId)
  })

  it('never indexes its own trash directory', async () => {
    await putFile(join(root, 'a.txt'), 'hello')
    await putFile(join(root, '.disk-space-trash', 't1', 'moved.bin'), 'hello')
    const context = makeContext()
    const scanId = await scanNow(context)
    const read = service.readScan({ scanId }).scan!
    expect(read.files).toBe(1)
    const top = service.browseDirectory({ scanId })
    expect(top.entries.map(entry => entry.path)).toEqual(['a.txt'])
  })

  it('honours exclusions and the cross-filesystem switch', async () => {
    await putFile(join(root, 'keep', 'a.txt'), 'a')
    await putFile(join(root, 'skip', 'b.txt'), 'bb')
    const context = makeContext()
    const { scan } = await service.startScan({ dir: root, excludes: ['skip'], crossFileSystems: true }, context.ctx)
    await settleTasks(context)
    const result = service.readScan({ scanId: scan.scanId }).scan!
    expect(result.excludes).toEqual(['skip'])
    expect(result.crossFileSystems).toBe(true)
    expect(service.browseDirectory({ scanId: scan.scanId }).entries.map(entry => entry.path)).toEqual(['keep'])
    await expect(service.startScan({ dir: join(root, 'missing') }, context.ctx)).rejects.toMatchObject({ code: 'invalid-root' })
  })

  it('rejects a file as the root and an invalid exclusion', async () => {
    await putFile(join(root, 'a.txt'), 'a')
    await expect(service.startScan({ dir: join(root, 'a.txt') }, makeContext().ctx)).rejects.toMatchObject({ code: 'invalid-root' })
    await expect(service.startScan({ dir: root, excludes: ['../x'] }, makeContext().ctx)).rejects.toMatchObject({ code: 'path-invalid' })
  })

  it('cancels a running scan, reports the truth and allows the next run', async () => {
    await putFile(join(root, 'a.txt'), 'a')
    const context = makeContext()
    const { scan } = await service.startScan({ dir: root }, context.ctx)
    const cancel = service.cancelScan({ scanId: scan.scanId })
    expect(cancel.cancelled).toBe(true)
    expect(cancel.scan.state).toBe('cancelling')
    await settleTasks(context)
    expect(service.readScan({ scanId: scan.scanId }).scan?.state).toBe('cancelled')
    expect(context.errors[0]).toMatchObject({ name: 'AbortError' })

    // A settled scan reports that there was nothing to cancel.
    expect(service.cancelScan({ scanId: scan.scanId })).toMatchObject({ cancelled: false })
    expect(service.cancelScan({})).toMatchObject({ cancelled: false })
    expect(() => service.cancelScan({ scanId: 'nope' })).toThrow(/no scan/)
    expect(() => service.cancelScan({ scanId: 'other' })).toThrow(/no scan/)

    // The single-flight slot was released, so a new scan can run.
    const again = await service.startScan({ dir: root }, context.ctx)
    await settleTasks(context)
    expect(service.readScan({ scanId: again.scan.scanId }).scan?.state).toBe('completed')
  })

  it('cancels when the shell aborts the task signal and when no scan exists yet', async () => {
    await putFile(join(root, 'a.txt'), 'a')
    expect(() => service.cancelScan({})).toThrow(/no scan/)
    const aborted = makeContext({ abortTasks: true })
    const { scan } = await service.startScan({ dir: root }, aborted.ctx)
    await settleTasks(aborted)
    expect(service.readScan({ scanId: scan.scanId }).scan?.state).toBe('cancelled')

    // The listener path: the shell aborts a task that is already running.
    const running = makeContext()
    const second = await service.startScan({ dir: root }, running.ctx)
    running.tasks[0]!.controller.abort()
    await settleTasks(running)
    expect(service.readScan({ scanId: second.scan.scanId }).scan?.state).toBe('cancelled')
  })

  it('records a failed scan with a readable reason', async () => {
    const failingIo: ScanIo = {
      readdir: async () => { throw new Error('unreachable') },
      lstat: async () => { throw new Error('disk went away') },
    }
    const failing = new DiskSpaceService(dbPath, { io: { scan: failingIo } })
    const context = makeContext()
    const { scan } = await failing.startScan({ dir: root }, context.ctx)
    await settleTasks(context)
    expect(failing.readScan({ scanId: scan.scanId }).scan).toMatchObject({ state: 'failed', error: { code: 'scan-failed', message: 'disk went away' } })

    const stringThrow: ScanIo = {
      readdir: async () => [],
      lstat: async () => { throw 'plain string' },
    }
    const second = new DiskSpaceService(dbPath, { io: { scan: stringThrow } })
    const secondContext = makeContext()
    const started = await second.startScan({ dir: root }, secondContext.ctx)
    await settleTasks(secondContext)
    expect(second.readScan({ scanId: started.scan.scanId }).scan?.error?.message).toBe('plain string')
    second.close()
    failing.close()
  })

  it('records an AppError failure with its own code', async () => {
    const notDirectory: ScanIo = {
      readdir: async () => [],
      lstat: async () => ({ isDirectory: () => false } as unknown as Stats),
    }
    const failing = new DiskSpaceService(dbPath, { io: { scan: notDirectory } })
    const context = makeContext()
    const { scan } = await failing.startScan({ dir: root }, context.ctx)
    await settleTasks(context)
    expect(failing.readScan({ scanId: scan.scanId }).scan?.error?.code).toBe('invalid-root')
    failing.close()
  })
})

describe('duplicate analysis', () => {
  it('hashes only same-size candidates and reports groups and wasted bytes', async () => {
    await duplicateFixture()
    const context = makeContext()
    const scanId = await scanNow(context)
    const started = service.startDuplicateAnalysis({ scanId }, context.ctx)
    expect(started.scan.duplicateState).toBe('running')
    await settleTasks(context)
    const scan = service.readScan({ scanId }).scan!
    expect(scan.duplicateState).toBe('completed')
    expect(scan.duplicate).toMatchObject({ groups: 1, wastedBytes: 20, hashedFiles: 3, skippedFiles: 0 })
    expect(scan.duplicate?.completedAt).toBeTypeOf('number')

    const groups = service.listDuplicateGroups({ scanId })
    expect(groups).toMatchObject({ total: 1, wastedBytes: 20 })
    expect(groups.groups[0]?.paths).toEqual(['dup/a.bin', 'dup/b.bin', 'dup/c.bin'])
    expect(groups.groups[0]?.size).toBe(10)
    expect(() => service.listDuplicateGroups({ scanId: 'nope' })).toThrow(/no scan/)
    expect(service.listDuplicateGroups({ scanId, offset: 0, limit: 1 }).groups).toHaveLength(1)
  })

  it('requires a completed scan, refuses a second run, and accepts a minSize filter', async () => {
    await duplicateFixture()
    const context = makeContext()
    expect(() => service.startDuplicateAnalysis({ scanId: 'nope' }, context.ctx)).toThrow(/no scan/)
    const { scan } = await service.startScan({ dir: root }, context.ctx)
    expect(() => service.startDuplicateAnalysis({ scanId: scan.scanId }, context.ctx)).toThrow(/completed scan/)
    await settleTasks(context)

    const running = service.startDuplicateAnalysis({ scanId: scan.scanId }, context.ctx)
    expect(() => service.startDuplicateAnalysis({ scanId: scan.scanId }, context.ctx)).toThrow(/another scan/)
    await settleTasks(context)
    expect(running.scan.duplicateState).toBe('running')

    const filtered = service.startDuplicateAnalysis({ scanId: scan.scanId, minSize: 10 }, context.ctx)
    expect(filtered.scan.duplicateState).toBe('running')
    await settleTasks(context)
    expect(service.readScan({ scanId: scan.scanId }).scan?.duplicate).toMatchObject({ groups: 0, wastedBytes: 0 })
  })

  it('skips an unreadable candidate, cancels a run and records a failed run', async () => {
    await duplicateFixture()
    const context = makeContext()
    const scanId = await scanNow(context)
    await chmod(join(root, 'dup', 'b.bin'), 0o000)
    service.startDuplicateAnalysis({ scanId }, context.ctx)
    await settleTasks(context)
    expect(service.readScan({ scanId }).scan?.duplicate).toMatchObject({ groups: 1, skippedFiles: 1, wastedBytes: 10 })
    await chmod(join(root, 'dup', 'b.bin'), 0o644)

    const cancelling = makeContext()
    service.startDuplicateAnalysis({ scanId }, cancelling.ctx)
    expect(service.cancelScan({ scanId }).cancelled).toBe(true)
    await settleTasks(cancelling)
    expect(service.readScan({ scanId }).scan?.duplicateState).toBe('cancelled')

    const failing = makeContext({ throwOnProgress: true })
    service.startDuplicateAnalysis({ scanId }, failing.ctx)
    await settleTasks(failing)
    expect(service.readScan({ scanId }).scan?.duplicateState).toBe('failed')

    // Cancelling from the last progress report hits the post-hash abort check.
    const afterHash = makeContext({
      onProgress: (_message, data) => {
        const payload = data as { hashed?: number; total?: number }
        if (payload.hashed !== undefined && payload.hashed === payload.total) service.cancelScan({ scanId })
      },
    })
    service.startDuplicateAnalysis({ scanId }, afterHash.ctx)
    await settleTasks(afterHash)
    expect(service.readScan({ scanId }).scan?.duplicateState).toBe('cancelled')
  })
})

describe('trash', () => {
  it('stages, lists, restores and purges one file', async () => {
    await putFile(join(root, 'a.txt'), 'hello')
    const context = makeContext()
    const scanId = await scanNow(context)
    const staged = await service.stageEntries({ scanId, paths: ['a.txt'] }, context.ctx)
    expect(staged.staged).toHaveLength(1)
    expect(staged.staged[0]).toMatchObject({ scanId, sourcePath: 'a.txt', size: 5 })
    await expect(access(join(root, 'a.txt'))).rejects.toThrow()
    expect(service.listTrash({}).entries).toHaveLength(1)
    expect(service.listTrash({}).entries[0]?.root).toBe(root)

    const restored = await service.restoreTrash({ id: staged.staged[0]!.id }, context.ctx)
    expect(restored.restored).toMatchObject({ id: staged.staged[0]!.id, path: 'a.txt' })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello')
    expect(service.listTrash({}).entries).toHaveLength(0)

    const again = await service.stageEntries({ scanId, paths: ['a.txt'] }, context.ctx)
    await service.purgeTrash({ id: again.staged[0]!.id }, context.ctx)
    expect(service.listTrash({}).entries).toHaveLength(0)
    await expect(access(join(root, 'a.txt'))).rejects.toThrow()
    await expect(service.restoreTrash({ id: 'nope' }, context.ctx)).rejects.toMatchObject({ code: 'not-found' })
    await expect(service.purgeTrash({ id: 'nope' }, context.ctx)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('never overwrites on restore: the conflict is reported and the copy stays in the trash', async () => {
    await putFile(join(root, 'a.txt'), 'hello')
    const context = makeContext()
    const scanId = await scanNow(context)
    const staged = await service.stageEntries({ scanId, paths: ['a.txt'] }, context.ctx)
    await putFile(join(root, 'a.txt'), 'new-content')
    await expect(service.restoreTrash({ id: staged.staged[0]!.id }, context.ctx)).rejects.toMatchObject({ code: 'restore-conflict' })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new-content')
    expect(service.listTrash({}).entries).toHaveLength(1)
  })

  it('stages a directory, validates every source before moving and reports a failed move', async () => {
    await mkdir(join(root, 'old'), { recursive: true })
    await writeFile(join(root, 'old', 'inner.txt'), 'x')
    await putFile(join(root, 'a.txt'), 'hello')
    const context = makeContext()
    const scanId = await scanNow(context)

    const directory = await service.stageEntries({ scanId, paths: ['old'] }, context.ctx)
    expect(directory.staged[0]).toMatchObject({ sourcePath: 'old', size: 0 })
    expect((await service.restoreTrash({ id: directory.staged[0]!.id }, context.ctx)).restored.path).toBe('old')

    await expect(service.stageEntries({ scanId, paths: [] }, context.ctx)).rejects.toMatchObject({ code: 'invalid-args' })
    for (const bad of [['../outside'], ['/etc/passwd']]) {
      await expect(service.stageEntries({ scanId, paths: bad }, context.ctx)).rejects.toMatchObject({ code: 'path-invalid' })
    }
    await expect(service.stageEntries({ scanId, paths: ['.disk-space-trash/x'] }, context.ctx)).rejects.toMatchObject({ code: 'invalid-args' })
    await expect(service.stageEntries({ scanId, paths: ['missing.txt'] }, context.ctx)).rejects.toMatchObject({ code: 'not-found' })

    // A file where the trash directory should be makes the move fail without
    // touching the source.
    await removeTree(join(root, '.disk-space-trash'))
    await writeFile(join(root, '.disk-space-trash'), 'not a directory')
    await expect(service.stageEntries({ scanId, paths: ['a.txt'] }, context.ctx)).rejects.toMatchObject({ code: 'stage-failed' })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('hello')
    await settleTasks(context)
  })

  it('does not stage the root itself', async () => {
    await putFile(join(root, 'a.txt'), 'a')
    const context = makeContext()
    const scanId = await scanNow(context)
    await expect(service.stageEntries({ scanId, paths: [''] }, context.ctx)).rejects.toMatchObject({ code: 'invalid-args' })
  })
})

describe('argument guards', () => {
  it('rejects malformed operation arguments', async () => {
    await expect(service.startScan(null, makeContext().ctx)).rejects.toMatchObject({ code: 'invalid-args' })
    await expect(service.startScan({}, makeContext().ctx)).rejects.toMatchObject({ code: 'invalid-args' })
    expect(() => service.readScan(null)).toThrow(/must be an object/)
    expect(() => service.listScans({ limit: 0 })).toThrow(/integer between/)
    expect(() => service.browseDirectory({ scanId: 'x', limit: 501 })).toThrow(/integer between/)
    expect(() => service.listDuplicateGroups({ scanId: 'x', offset: -1 })).toThrow(/integer between/)
    await expect(service.stageEntries({ scanId: 'x' }, makeContext().ctx)).rejects.toMatchObject({ code: 'invalid-args' })
  })
})
