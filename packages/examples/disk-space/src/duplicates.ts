/**
 * Duplicate-file analysis over one completed index. Only files that share a
 * size are hashed; a file whose content cannot be read is skipped and counted
 * instead of failing the analysis. The resulting groups carry the logically
 * reclaimable bytes (`size × (copies − 1)`), never a claim about physical
 * space.
 * @module
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { DuplicateCandidate, DuplicateGroup } from './types.ts'
import { resolveInside } from './paths.ts'

/** The hashing seam (tests inject a failure the real fs will not produce). */
export interface DuplicateIo {
  /** Hash one absolute path's complete content (sha256 hex). */
  hashFile: (path: string) => Promise<string>
}

/** The sha256 streaming implementation. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** The production hashing seam. */
export const nodeDuplicateIo: DuplicateIo = { hashFile: sha256File }

/** The analysis inputs. */
export interface DuplicateOptions {
  /** The canonical scan root. */
  root: string
  /** The indexed non-empty file candidates. */
  candidates: readonly DuplicateCandidate[]
  /** Only files strictly larger than this many bytes. */
  minSize: number
  /** The scan's cancellation signal. */
  signal: AbortSignal
  /** Called after every hashed file. */
  onProgress: (hashed: number, total: number) => void
}

/** The analysis result. */
export interface DuplicateResult {
  /** The groups, wasted bytes descending. */
  groups: DuplicateGroup[]
  /** Files hashed. */
  hashedFiles: number
  /** Files skipped because their content could not be read. */
  skippedFiles: number
  /** Every group's wasted bytes. */
  wastedBytes: number
}

/** Throw the browser-compatible cancellation error the task layer recognises. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('cancelled', 'AbortError')
}

/**
 * Find duplicate files among the indexed candidates.
 * @param options - the candidates and the analysis rules.
 * @param io - the hashing seam (the real one by default).
 * @returns the duplicate groups and the read counters.
 * @throws DOMException when the signal aborts.
 */
export async function findDuplicates(options: DuplicateOptions, io: DuplicateIo = nodeDuplicateIo): Promise<DuplicateResult> {
  throwIfAborted(options.signal)
  const bySize = new Map<number, string[]>()
  for (const candidate of options.candidates) {
    if (candidate.size <= options.minSize) continue
    const paths = bySize.get(candidate.size)
    if (paths === undefined) bySize.set(candidate.size, [candidate.path])
    else paths.push(candidate.path)
  }

  const found: Array<{ hash: string; size: number; paths: string[] }> = []
  let hashedFiles = 0
  let skippedFiles = 0
  let hashed = 0
  const total = [...bySize.values()].filter(paths => paths.length > 1).reduce((sum, paths) => sum + paths.length, 0)

  for (const [size, paths] of [...bySize.entries()].sort((a, b) => b[0] - a[0])) {
    if (paths.length < 2) continue
    const byHash = new Map<string, string[]>()
    for (const path of paths) {
      throwIfAborted(options.signal)
      try {
        const hash = await io.hashFile(resolveInside(options.root, path))
        const same = byHash.get(hash)
        if (same === undefined) byHash.set(hash, [path])
        else same.push(path)
        hashedFiles += 1
      } catch {
        skippedFiles += 1
      }
      hashed += 1
      options.onProgress(hashed, total)
    }
    for (const [hash, samePaths] of byHash) {
      if (samePaths.length < 2) continue
      found.push({ hash, size, paths: samePaths.sort() })
    }
  }

  const groups = found
    .map((group, index) => ({
      groupId: `g_${String(index + 1)}`,
      hash: group.hash,
      size: group.size,
      paths: group.paths,
      wastedBytes: group.size * (group.paths.length - 1),
    }))
    .sort((a, b) => b.wastedBytes - a.wastedBytes)

  return {
    groups,
    hashedFiles,
    skippedFiles,
    wastedBytes: groups.reduce((sum, group) => sum + group.wastedBytes, 0),
  }
}
