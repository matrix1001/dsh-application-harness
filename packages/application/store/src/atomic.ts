/**
 * The harness's durable-write primitive, in two layers:
 *
 * - {@link writeFileDurable} — write one file's complete content and **fsync**
 *   it before closing (the durability half);
 * - {@link writeFileAtomic} — parent-directory creation, a unique sibling temp
 *   name, the durable write, and a rename over the target, so the path only
 *   ever names the complete old or the complete new content.
 *
 * It lives with the persistence store (the harness's own durable artifact) and
 * its `./atomic` subpath is what an application's own document store takes:
 * one home for a protocol that used to be re-implemented per package — and the
 * application-side copies had quietly dropped the fsync (arch-review
 * 2026-09-15, `durable-document-write-protocol-not-shared-and-weaker-in-apps`).
 * The temp name is unique per attempt (`<path>.<pid>.<seq>.tmp`), so two
 * writers can never share one — the trade is that a CRASH mid-write can leave
 * that one temp file behind (the failure path removes it itself). It is inert:
 * nothing ever reads it, no later write collides with it, and it sits next to
 * the document it was writing.
 *
 * Deliberate boundaries (each keeps its own composition of these primitives):
 * the store's own `set()` runs {@link writeFileAtomic}; and the disk-analysis /
 * workbook repositories interleave cancellation checkpoints between the temp
 * write and the rename (their `io.writeFile` seams take {@link writeFileDurable}
 * as the default).
 *
 * The shared vocabulary is {@link isMissingFile} / {@link reasonOf}. The
 * candidate-then-rename composition stays with each caller: nothing here writes
 * a document on its own.
 * @module @matrix1001/dsh-application-harness-store/atomic
 */

import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

/** A per-process sequence making each temp name unique (two writers never share one). */
let tempSeq = 0

/**
 * Write `text` to `path` and fsync it before returning: the bytes are durable
 * when this resolves, so a crash right after cannot leave the file short.
 * @param path - the file to write (created or truncated).
 * @param text - its complete new content.
 * @returns when the content is written and synced.
 */
export async function writeFileDurable(path: string, text: string, mode?: number): Promise<void> {
  const handle = mode === undefined ? await open(path, 'w') : await open(path, 'w', mode)
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Replace `path` with `text` atomically: create the parent directories, write
 * the content to a unique sibling temp file ({@link writeFileDurable}, so it is
 * fsync'd), then rename it over the target. A reader of `path` sees the
 * complete old or the complete new document, never a torn one; a failure
 * removes this attempt's temp file (best effort — the original error is the one
 * that surfaces) and leaves the target untouched.
 * @param path - the document to replace.
 * @param text - its complete new content.
 * @returns when the rename has published the content.
 */
export async function writeFileAtomic(path: string, text: string, mode?: number): Promise<void> {
  tempSeq += 1
  const tmp = `${path}.${String(process.pid)}.${String(tempSeq)}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFileDurable(tmp, text, mode)
    await rename(tmp, path)
  } catch (error) {
    // Best-effort cleanup: a failing unlink (its own disappearance, a
    // permission wall) must not mask the write failure being surfaced.
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

/**
 * Whether a read failure means "no document yet" (the first write creates it).
 * @param error - the value a read threw.
 * @returns whether it is the missing-file error (`code: 'ENOENT'`).
 */
export function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * The readable reason of an unknown thrown value.
 * @param error - the thrown value (an `Error`, or anything else).
 * @returns its message, or the value stringified.
 */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
