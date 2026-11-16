/**
 * The directory walk. It never follows a symbolic link, never descends into an
 * excluded path, skips unreadable entries instead of failing the whole scan,
 * and honours the cross-filesystem switch. Directory byte totals are summed
 * bottom-up after the walk so the browse and treemap readers can read one
 * indexed row per directory.
 * @module
 */

import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import { lstat, readdir } from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import { join } from 'node:path'
import type { ScanProgress } from './types.ts'
import { depthOf, isExcluded, joinRelative, parentPathOf } from './paths.ts'

/** The filesystem seam (injected by tests that need a failure the real fs will not produce). */
export interface ScanIo {
  /** Read one directory's entries. */
  readdir: (path: string) => Promise<Dirent[]>
  /** Read one path's metadata without following symlinks. */
  lstat: (path: string) => Promise<Stats>
}

/** The production filesystem seam. */
export const nodeScanIo: ScanIo = {
  readdir: async path => await readdir(path, { withFileTypes: true }),
  lstat: async path => await lstat(path),
}

/** One walked entry, ready for the store. */
export interface WalkEntry {
  /** Root-relative path. */
  path: string
  /** Root-relative parent. */
  parentPath: string
  /** Basename. */
  name: string
  /** File or directory. */
  kind: 'file' | 'dir'
  /** Logical bytes (a directory's subtree total after aggregation). */
  size: number
  /** Modification time. */
  mtime: number
}

/** The complete walk result. */
export interface WalkResult {
  /** Every indexed entry. */
  entries: WalkEntry[]
  /** Indexed files. */
  files: number
  /** Indexed directories. */
  dirs: number
  /** Indexed files' logical bytes. */
  bytes: number
  /** Entries skipped by policy or by an unreadable path. */
  skipped: number
  /** The last progress snapshot. */
  progress: ScanProgress
}

/** The walk inputs. */
export interface WalkOptions {
  /** The canonical absolute root. */
  root: string
  /** Root-relative exclusions. */
  excludes: readonly string[]
  /** Whether the walk may enter another filesystem. */
  crossFileSystems: boolean
  /** The scan's cancellation signal. */
  signal: AbortSignal
  /** Called after every directory (the service persists the snapshot). */
  onProgress: (progress: ScanProgress) => void
}

/** Throw the browser-compatible cancellation error the task layer recognises. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('cancelled', 'AbortError')
}

/**
 * Whether one child directory crosses a filesystem boundary the scan refuses
 * to enter.
 * @param childDevice - the child's device id.
 * @param rootDevice - the scan root's device id.
 * @param crossFileSystems - whether crossing is allowed.
 * @returns whether the child is skipped by the filesystem rule.
 */
export function crossesFileSystem(childDevice: number, rootDevice: number, crossFileSystems: boolean): boolean {
  return !crossFileSystems && childDevice !== rootDevice
}

/**
 * Walk one directory tree.
 * @param options - the walk inputs.
 * @param io - the filesystem seam (the real one by default).
 * @returns the indexed entries and totals.
 * @throws AppError when the root is not a directory.
 * @throws DOMException when the signal aborts.
 */
export async function walkDirectory(options: WalkOptions, io: ScanIo = nodeScanIo): Promise<WalkResult> {
  const rootStat = await io.lstat(options.root)
  if (!rootStat.isDirectory()) {
    throw new AppError('invalid-root', `disk-space: ${options.root} is not a directory`)
  }
  const rootDevice = rootStat.dev
  const entries: WalkEntry[] = []
  let files = 0
  let dirs = 0
  let bytes = 0
  let skipped = 0
  let currentPath: string | null = null
  const progress = (): ScanProgress => ({ files, dirs, bytes, skipped, currentPath })

  const visit = async (relative: string, absolute: string): Promise<void> => {
    throwIfAborted(options.signal)
    currentPath = relative === '' ? '.' : relative
    let children: Dirent[]
    try {
      children = await io.readdir(absolute)
    } catch {
      skipped += 1
      options.onProgress(progress())
      return
    }
    for (const child of children) {
      throwIfAborted(options.signal)
      const childRelative = joinRelative(relative, child.name)
      if (isExcluded(childRelative, options.excludes)) continue
      const childAbsolute = join(absolute, child.name)
      let childStat: Stats
      try {
        childStat = await io.lstat(childAbsolute)
      } catch {
        skipped += 1
        continue
      }
      if (childStat.isSymbolicLink()) {
        skipped += 1
        continue
      }
      if (childStat.isDirectory()) {
        if (crossesFileSystem(childStat.dev, rootDevice, options.crossFileSystems)) {
          skipped += 1
          continue
        }
        entries.push({
          path: childRelative,
          parentPath: parentPathOf(childRelative),
          name: child.name,
          kind: 'dir',
          size: 0,
          mtime: Math.trunc(childStat.mtimeMs),
        })
        dirs += 1
        await visit(childRelative, childAbsolute)
        continue
      }
      if (childStat.isFile()) {
        entries.push({
          path: childRelative,
          parentPath: parentPathOf(childRelative),
          name: child.name,
          kind: 'file',
          size: childStat.size,
          mtime: Math.trunc(childStat.mtimeMs),
        })
        files += 1
        bytes += childStat.size
        continue
      }
      skipped += 1
    }
    options.onProgress(progress())
  }

  await visit('', options.root)

  // Directory totals are summed bottom-up: every child's aggregated bytes go
  // to its indexed parent, so a top-level directory already carries its whole
  // subtree when the page draws the treemap.
  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  const ordered = [...entries].sort((a, b) => depthOf(b.path) - depthOf(a.path))
  for (const entry of ordered) {
    const parent = byPath.get(entry.parentPath)
    if (parent !== undefined) parent.size += entry.size
  }

  return { entries, files, dirs, bytes, skipped, progress: progress() }
}
