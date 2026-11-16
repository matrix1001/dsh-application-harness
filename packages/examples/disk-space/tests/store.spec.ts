/**
 * The index's durable contract: schema creation and version refusal, the scan
 * row lifecycle, entry paging, duplicate replacement and the trash join. These
 * are exercised against a real SQLite file so a restart is a real reopen, not a
 * mocked one.
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import { DiskStore, SCHEMA_VERSION } from '../src/store.ts'
import type { EntryRecord } from '../src/store.ts'
import { removeTree, tempDir } from './helpers.ts'

const cleanup: string[] = []
afterEach(async () => {
  for (const path of cleanup.splice(0)) await removeTree(path)
})

/** A fresh database inside a temporary directory. */
async function openStore(): Promise<{ store: DiskStore; dir: string; path: string }> {
  const dir = await tempDir('dsh-disk-space-store-')
  cleanup.push(dir)
  const path = join(dir, 'index.db')
  return { store: new DiskStore(path), dir, path }
}

const entry = (path: string, kind: 'file' | 'dir', size: number): EntryRecord => ({
  path,
  parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
  name: path.slice(path.lastIndexOf('/') + 1),
  kind,
  size,
  mtime: 10,
})

/** The initial scan row input. */
function scanInput(scanId = 's_1') {
  return {
    scanId,
    root: '/srv/root',
    excludes: ['skip'],
    crossFileSystems: false,
    startedAt: 100,
    progress: { files: 0, dirs: 0, bytes: 0, skipped: 0, currentPath: null },
  }
}

describe('index schema', () => {
  it('creates the schema, persists it and refuses an unknown version on reopen', async () => {
    const { store, path } = await openStore()
    expect(store.latestScan()).toBeNull()
    store.close()

    const reopened = new DiskStore(path)
    expect(reopened.latestScan()).toBeNull()

    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run('2', 'schemaVersion')
    raw.close()
    reopened.close()
    expect(() => new DiskStore(path)).toThrow(AppError)
  })

  it('rolls the entry transaction back when one row violates the key', async () => {
    const { store } = await openStore()
    store.createScan(scanInput())
    expect(() => store.insertEntries('s_1', [entry('a', 'file', 1), entry('a', 'file', 1)])).toThrow()
    // The rollback left the table empty rather than half-written.
    expect(store.browse('s_1', '', 0, 10).total).toBe(0)
    store.close()
  })

  it('accepts the in-memory mode', () => {
    const store = new DiskStore(':memory:')
    expect(store.listScans(5)).toEqual([])
    store.close()
  })
})

describe('scans and entries', () => {
  it('creates, updates, settles and lists scans', async () => {
    const { store } = await openStore()
    expect(SCHEMA_VERSION).toBe(1)
    store.createScan(scanInput())
    expect(store.readScan('s_1')).toMatchObject({ scanId: 's_1', state: 'running', files: 0, endedAt: null, error: null, duplicate: null })
    store.updateProgress('s_1', { files: 1, dirs: 2, bytes: 3, skipped: 4, currentPath: 'a' })
    expect(store.readScan('s_1')?.progress).toEqual({ files: 1, dirs: 2, bytes: 3, skipped: 4, currentPath: 'a' })
    store.markCancelling('s_1')
    expect(store.readScan('s_1')?.state).toBe('cancelling')
    store.finishScan('s_1', 'completed', { files: 1, dirs: 2, bytes: 3, skipped: 4, currentPath: null }, { files: 1, dirs: 2, bytes: 3 }, null)
    expect(store.readScan('s_1')).toMatchObject({ state: 'completed', files: 1, dirs: 2, bytes: 3 })
    expect(store.readScan('s_1')?.endedAt).toBeTypeOf('number')
    expect(store.listScans(1)).toHaveLength(1)
    expect(store.readScan('missing')).toBeNull()
    store.close()
  })

  it('prunes old scan indexes without deleting trash-backed scans', async () => {
    const { store } = await openStore()
    for (let index = 1; index <= 6; index += 1) {
      store.createScan({ ...scanInput(`s_${String(index)}`), startedAt: index })
    }
    store.insertEntries('s_1', [entry('a', 'file', 1)])
    store.insertEntries('s_2', [entry('b', 'file', 2)])
    store.insertTrash({ id: 't_1', scanId: 's_6', sourcePath: 'a', trashPath: '.disk-space-trash/t_1/a', size: 1, movedAt: 10 })
    expect(store.pruneScans(2)).toBe(3)
    expect(store.readScan('s_1')).toBeNull()
    expect(store.readScan('s_3')).toBeNull()
    expect(store.readScan('s_4')).not.toBeNull()
    expect(store.readScan('s_6')).not.toBeNull()
    expect(store.listTrash()).toHaveLength(1)
    expect(() => store.pruneScans(0)).toThrow(/positive integer/u)
    store.close()
  })

  it('stores a failure and duplicate summary as JSON', async () => {
    const { store } = await openStore()
    store.createScan(scanInput())
    store.finishScan('s_1', 'failed', { files: 0, dirs: 0, bytes: 0, skipped: 0, currentPath: null }, { files: 0, dirs: 0, bytes: 0 }, { code: 'boom', message: 'nope' })
    store.setDuplicateState('s_1', 'completed', { groups: 1, wastedBytes: 2, hashedFiles: 3, skippedFiles: 4, completedAt: 5 })
    expect(store.readScan('s_1')).toMatchObject({
      state: 'failed', error: { code: 'boom', message: 'nope' },
      duplicateState: 'completed', duplicate: { groups: 1, wastedBytes: 2, hashedFiles: 3, skippedFiles: 4, completedAt: 5 },
    })
    store.close()
  })

  it('pages direct children, directories first and size descending', async () => {
    const { store } = await openStore()
    store.createScan(scanInput())
    store.insertEntries('s_1', [
      entry('a.txt', 'file', 5),
      entry('big', 'dir', 100),
      entry('small', 'dir', 1),
      entry('big/deep.bin', 'file', 100),
    ])
    expect(store.entryKind('s_1', 'big')).toBe('dir')
    expect(store.entryKind('s_1', 'a.txt')).toBe('file')
    expect(store.entryKind('s_1', 'nope')).toBeNull()
    const root = store.browse('s_1', '', 0, 2)
    expect(root.total).toBe(3)
    expect(root.entries.map(item => item.path)).toEqual(['big', 'small'])
    const second = store.browse('s_1', '', 1, 2)
    expect(second.entries.map(item => item.path)).toEqual(['small', 'a.txt'])
    expect(store.browse('s_1', 'big', 0, 10).entries.map(item => item.path)).toEqual(['big/deep.bin'])
    store.close()
  })

  it('lists large files and duplicate candidates', async () => {
    const { store } = await openStore()
    store.createScan(scanInput())
    store.insertEntries('s_1', [
      entry('a', 'file', 5),
      entry('b', 'file', 50),
      entry('empty', 'file', 0),
      entry('dir', 'dir', 500),
    ])
    expect(store.largeFiles('s_1', 1)).toMatchObject({ total: 3, files: [{ path: 'b' }] })
    expect(store.duplicateCandidates('s_1').map(item => item.path).sort()).toEqual(['a', 'b'])
    store.close()
  })

  it('replaces duplicate groups and pages them', async () => {
    const { store } = await openStore()
    store.createScan(scanInput())
    store.replaceDuplicateGroups('s_1', [
      { groupId: 'g_1', hash: 'h1', size: 10, paths: ['a', 'b'], wastedBytes: 10 },
      { groupId: 'g_2', hash: 'h2', size: 20, paths: ['c', 'd', 'e'], wastedBytes: 40 },
    ])
    expect(store.listDuplicateGroups('s_1', 0, 10)).toMatchObject({ total: 2, wastedBytes: 50 })
    expect(store.listDuplicateGroups('s_1', 0, 1).groups.map(group => group.groupId)).toEqual(['g_2'])
    expect(store.listDuplicateGroups('s_1', 1, 10).groups.map(group => group.groupId)).toEqual(['g_1'])
    store.replaceDuplicateGroups('s_1', [])
    expect(store.listDuplicateGroups('s_1', 0, 10)).toEqual({ groups: [], total: 0, wastedBytes: 0 })
    store.close()
  })

  it('stores and lists trash rows with their scan root', async () => {
    const { store } = await openStore()
    store.createScan(scanInput())
    store.insertTrash({ id: 't_1', scanId: 's_1', sourcePath: 'a', trashPath: '.disk-space-trash/t_1/a', size: 5, movedAt: 20 })
    store.insertTrash({ id: 't_2', scanId: 's_1', sourcePath: 'b', trashPath: '.disk-space-trash/t_2/b', size: 6, movedAt: 30 })
    expect(store.listTrash().map(item => item.id)).toEqual(['t_2', 't_1'])
    expect(store.getTrash('t_1')).toMatchObject({ root: '/srv/root', sourcePath: 'a' })
    expect(store.getTrash('nope')).toBeNull()
    store.deleteTrash('t_1')
    expect(store.getTrash('t_1')).toBeNull()
    store.close()
  })
})
