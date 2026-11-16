/**
 * The walker's rules: no symlink is followed, exclusions cut whole subtrees,
 * an unreadable directory is counted and skipped instead of failing the scan,
 * the cross-filesystem switch is honoured, and directory totals are summed
 * bottom-up. The fake filesystem seam covers the failure kinds a real temp
 * tree cannot produce on demand; one real tree covers permissions.
 */
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Dirent, Stats } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import { crossesFileSystem, walkDirectory, type ScanIo } from '../src/scanner.ts'
import { tempDir, removeTree } from './helpers.ts'

/** One fake directory entry. */
interface FakeNode {
  kind: 'dir' | 'file' | 'symlink' | 'special'
  size?: number
  dev?: number
}

/** Build the Stats shape the walker reads. */
function statsOf(node: FakeNode): Stats {
  return {
    dev: node.dev ?? 1,
    size: node.size ?? 0,
    mtimeMs: 1000,
    isDirectory: () => node.kind === 'dir',
    isFile: () => node.kind === 'file',
    isSymbolicLink: () => node.kind === 'symlink',
  } as unknown as Stats
}

/** Build one fake ScanIo over an absolute-path → node map. */
function fakeIo(tree: Record<string, FakeNode>, failReaddir = false, failLstat = false): ScanIo {
  return {
    readdir: async path => {
      if (failReaddir) throw new Error('denied')
      const prefix = path === '/' ? '/' : `${path}/`
      const names = Object.keys(tree)
        .filter(candidate => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'))
        .map(candidate => candidate.slice(prefix.length))
      return names.map(name => ({ name } as Dirent))
    },
    lstat: async path => {
      if (failLstat) throw new Error('denied')
      const node = tree[path]
      if (node === undefined) throw new Error(`missing ${path}`)
      return statsOf(node)
    },
  }
}

/** The options a fake walk uses. */
function walkOptions(root: string, signal = new AbortController().signal) {
  const progress: number[] = []
  return {
    options: {
      root,
      excludes: [] as string[],
      crossFileSystems: false,
      signal,
      onProgress: (snapshot: { files: number }) => { progress.push(snapshot.files) },
    },
    progress,
  }
}

const cleanup: string[] = []
afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await chmod(path, 0o755).catch(() => undefined)
    await removeTree(path)
  }
})

describe('cross-filesystem rule', () => {
  it('skips a foreign device only when crossing is forbidden', () => {
    expect(crossesFileSystem(2, 1, false)).toBe(true)
    expect(crossesFileSystem(1, 1, false)).toBe(false)
    expect(crossesFileSystem(2, 1, true)).toBe(false)
  })
})

describe('walkDirectory (fake filesystem)', () => {
  it('indexes files and directories, sums directory subtrees and skips symlinks and specials', async () => {
    const { options, progress } = walkOptions('/root')
    const result = await walkDirectory(options, fakeIo({
      '/root': { kind: 'dir' },
      '/root/a.txt': { kind: 'file', size: 5 },
      '/root/sub': { kind: 'dir' },
      '/root/sub/b.bin': { kind: 'file', size: 8 },
      '/root/empty': { kind: 'dir' },
      '/root/link': { kind: 'symlink' },
      '/root/pipe': { kind: 'special' },
    }))
    expect(result.files).toBe(2)
    expect(result.dirs).toBe(2)
    expect(result.bytes).toBe(13)
    expect(result.skipped).toBe(2)
    expect(result.entries.find(entry => entry.path === 'sub')?.size).toBe(8)
    expect(result.entries.find(entry => entry.path === 'empty')?.size).toBe(0)
    expect(result.entries.find(entry => entry.path === 'a.txt')?.size).toBe(5)
    expect(result.progress.currentPath).toBe('empty')
    expect(progress.length).toBeGreaterThan(0)
  })

  it('honours exclusions and the cross-filesystem switch', async () => {
    const { options } = walkOptions('/root')
    const excluded = await walkDirectory({ ...options, excludes: ['sub', 'a.txt'] }, fakeIo({
      '/root': { kind: 'dir' },
      '/root/a.txt': { kind: 'file', size: 5 },
      '/root/sub': { kind: 'dir' },
      '/root/sub/b.bin': { kind: 'file', size: 8 },
    }))
    expect(excluded.entries).toEqual([])

    const foreign = await walkDirectory(options, fakeIo({
      '/root': { kind: 'dir' },
      '/root/here': { kind: 'file', size: 1 },
      '/root/other': { kind: 'dir', dev: 2 },
      '/root/other/x': { kind: 'file', size: 9 },
    }))
    expect(foreign.entries.map(entry => entry.path)).toEqual(['here'])
    expect(foreign.skipped).toBe(1)

    const crossed = await walkDirectory({ ...options, crossFileSystems: true }, fakeIo({
      '/root': { kind: 'dir' },
      '/root/here': { kind: 'file', size: 1 },
      '/root/other': { kind: 'dir', dev: 2 },
      '/root/other/x': { kind: 'file', size: 9 },
    }))
    expect(crossed.entries.map(entry => entry.path).sort()).toEqual(['here', 'other', 'other/x'])
    expect(crossed.bytes).toBe(10)
  })

  it('counts unreadable directories and entries instead of failing', async () => {
    const { options } = walkOptions('/root')
    const denied = await walkDirectory(options, fakeIo({ '/root': { kind: 'dir' }, '/root/x': { kind: 'file' } }, true, false))
    expect(denied.skipped).toBe(1)
    expect(denied.entries).toEqual([])
    expect(denied.progress.currentPath).toBe('.')

    const io = fakeIo({ '/root': { kind: 'dir' }, '/root/x': { kind: 'file' } })
    const lstat = io.lstat
    io.lstat = async path => {
      if (path === '/root/x') throw new Error('denied')
      return await lstat(path)
    }
    const unreadableEntry = await walkDirectory(options, io)
    expect(unreadableEntry.skipped).toBe(1)
    expect(unreadableEntry.entries).toEqual([])
  })

  it('rejects a non-directory root and an already-cancelled walk', async () => {
    const { options } = walkOptions('/root')
    await expect(walkDirectory(options, fakeIo({ '/root': { kind: 'file' } }))).rejects.toThrow(AppError)

    const controller = new AbortController()
    controller.abort()
    await expect(walkDirectory(walkOptions('/root', controller.signal).options, fakeIo({ '/root': { kind: 'dir' } }))).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('cancels in the middle of a walk', async () => {
    const controller = new AbortController()
    const io = fakeIo({
      '/root': { kind: 'dir' },
      '/root/a': { kind: 'file', size: 1 },
      '/root/b': { kind: 'file', size: 1 },
    })
    const readdir = io.readdir
    io.readdir = async path => {
      if (path === '/root') controller.abort()
      return await readdir(path)
    }
    await expect(walkDirectory(walkOptions('/root', controller.signal).options, io)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('walkDirectory (real filesystem, temporary directory)', () => {
  it('walks a real tree, skips an unreadable directory and a symlink', async () => {
    const root = await tempDir()
    cleanup.push(root)
    await mkdir(join(root, 'sub'), { recursive: true })
    await mkdir(join(root, 'blocked'), { recursive: true })
    await writeFile(join(root, 'a.txt'), 'hello')
    await writeFile(join(root, 'sub', 'b.txt'), 'world!')
    await writeFile(join(root, 'blocked', 'hidden.txt'), 'nope')
    await symlink(join(root, 'a.txt'), join(root, 'link.txt'))
    await chmod(join(root, 'blocked'), 0o000)

    try {
      const result = await walkDirectory(walkOptions(root).options)
      expect(result.files).toBe(2)
      expect(result.dirs).toBe(2)
      expect(result.bytes).toBe(11)
      expect(result.skipped).toBe(2)
      expect(result.entries.find(entry => entry.path === 'sub')?.size).toBe(6)
      expect(result.entries.some(entry => entry.path === 'link.txt')).toBe(false)
    } finally {
      await chmod(join(root, 'blocked'), 0o755)
    }
  })
})
