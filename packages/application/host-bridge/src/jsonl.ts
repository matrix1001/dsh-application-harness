/**
 * Shared JSONL helpers for the host's bounded control-plane files: one line
 * per record, a 2 MB rotation sibling, and malformed lines that are counted
 * rather than aborting the whole load.
 * @module
 */

import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isMissingFile, reasonOf } from '@matrix1001/dsh-application-harness-store/atomic'
import type { Caller } from './types.ts'

/** Read one JSONL file, counting malformed lines; a missing file is empty. */
export async function readJsonl<T>(
  path: string,
  parse: (value: unknown) => T | undefined,
  report: (problem: string) => void,
  label: string,
): Promise<{ records: T[]; bad: number }> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (!isMissingFile(error)) report(`${label}: ${path} cannot be read: ${reasonOf(error)}`)
    return { records: [], bad: 0 }
  }
  const records: T[] = []
  let bad = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = parse(JSON.parse(line))
      if (record === undefined) bad += 1
      else records.push(record)
    } catch {
      bad += 1
    }
  }
  return { records, bad }
}

/** Append one batch, rotating the current file to `.1` first when `limit` would be exceeded. */
export async function appendRotated(path: string, text: string, limit: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const size = await stat(path).then(info => info.size).catch(() => 0)
  if (size > 0 && size + Buffer.byteLength(text) > limit) {
    const rotated = `${path}.1`
    await rm(rotated, { force: true })
    await rename(path, rotated)
  }
  await appendFile(path, text)
}

/** Whether a value is a plain object (never an array or null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one stored caller. */
export function callerOf(value: unknown): Caller | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'human') return { kind: 'human' }
  if (value.kind === 'app' || value.kind === 'background') {
    return typeof value.appId === 'string' && value.appId !== '' ? { kind: value.kind, appId: value.appId } : undefined
  }
  if (value.kind !== 'ai') return undefined
  return {
    kind: 'ai',
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    ...(typeof value.turnId === 'string' ? { turnId: value.turnId } : {}),
  }
}
