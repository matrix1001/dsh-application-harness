/**
 * The duplicate-finder's own rules, isolated from the service: same-size
 * candidates only, unreadable files counted and skipped, a group needs two
 * copies with the same hash, and a cancelled signal stops the run.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findDuplicates } from '../src/duplicates.ts'
import type { DuplicateCandidate } from '../src/types.ts'
import { removeTree, tempDir } from './helpers.ts'

const cleanup: string[] = []
afterEach(async () => {
  for (const path of cleanup.splice(0)) await removeTree(path)
})

/** Build a candidate list for the given files. */
function candidates(files: Array<[string, string]>): DuplicateCandidate[] {
  return files.map(([path, content]) => ({ path, size: Buffer.byteLength(content) }))
}

describe('findDuplicates', () => {
  it('groups same-hash candidates, sorts groups by wasted bytes and avoids cross-hash matches', async () => {
    const root = await tempDir('dsh-disk-space-dup-')
    cleanup.push(root)
    const files: Array<[string, string]> = [
      ['a1', '0123456789'],
      ['a2', '0123456789'],
      ['a3', '0123456789'],
      ['big1', '01234567890123456789'],
      ['big2', '01234567890123456789'],
      ['same-size-1', 'aaa'],
      ['same-size-2', 'bbb'],
    ]
    for (const [path, content] of files) await writeFile(join(root, path), content)
    const progress: Array<[number, number]> = []
    const result = await findDuplicates({
      root,
      candidates: candidates(files),
      minSize: 0,
      signal: new AbortController().signal,
      onProgress: (hashed, total) => { progress.push([hashed, total]) },
    })
    expect(result.groups).toHaveLength(2)
    expect(result.groups).toHaveLength(2)
    expect(result.groups.find(group => group.paths.includes('a1'))).toMatchObject({ groupId: 'g_2', size: 10, wastedBytes: 20, paths: ['a1', 'a2', 'a3'] })
    expect(result.groups.find(group => group.paths.includes('big1'))).toMatchObject({ size: 20, wastedBytes: 20, paths: ['big1', 'big2'] })
    expect(result.wastedBytes).toBe(40)
    expect(result.hashedFiles).toBe(7)
    expect(result.skippedFiles).toBe(0)
    expect(progress.at(-1)).toEqual([7, 7])
  })

  it('honours minSize, skips an unreadable candidate and rejects a cancelled signal', async () => {
    const root = await tempDir('dsh-disk-space-dup-')
    cleanup.push(root)
    const files: Array<[string, string]> = [
      ['a1', '0123456789'],
      ['a2', '0123456789'],
    ]
    for (const [path, content] of files) await writeFile(join(root, path), content)
    const missing: DuplicateCandidate[] = [{ path: 'gone', size: 10 }]
    const result = await findDuplicates({
      root,
      candidates: [...candidates(files), ...missing],
      minSize: 10,
      signal: new AbortController().signal,
      onProgress: () => {},
    })
    expect(result.groups).toEqual([])
    expect(result.hashedFiles).toBe(0)

    const unreadable = await findDuplicates({
      root,
      candidates: [...candidates(files), ...missing],
      minSize: 0,
      signal: new AbortController().signal,
      onProgress: () => {},
    })
    expect(unreadable.skippedFiles).toBe(1)
    expect(unreadable.hashedFiles).toBe(2)
    expect(unreadable.groups).toHaveLength(1)

    const controller = new AbortController()
    controller.abort()
    await expect(findDuplicates({
      root,
      candidates: candidates(files),
      minSize: 0,
      signal: controller.signal,
      onProgress: () => {},
    })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
