/**
 * The durable basic-call history: one JSONL file under the harness home.
 *
 * History is best-effort, not business state: a write failure is reported, the
 * call keeps its own outcome, and the record stays in the in-memory window for
 * this run. The file is appended (never rewritten), rotates at 2 MB into
 * `history.jsonl.1`, and at startup the newest 500 valid records are loaded into
 * the read window (the current file first; `.1` only as needed).
 *
 * The queue is the runtime's own {@link BoundedHistoryQueue}: the load seeds its
 * read window with `hydrate` (never the write queue), and a record that arrives
 * while the load is in flight is buffered and queued AFTER the loaded records,
 * so restart ordering is preserved.
 * @module @matrix1001/dsh-application-harness-host-bridge/history
 */

import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isMissingFile, reasonOf } from '@matrix1001/dsh-application-harness-store/atomic'
import { BoundedHistoryQueue, type HistoryReader, type HistorySink } from '@matrix1001/dsh-application-harness-runtime'
import type { HistoryRecord } from '@matrix1001/dsh-application-harness-runtime'

/** The soft per-file ceiling: the next append rotates first once this is exceeded. */
export const HISTORY_FILE_LIMIT = 2 * 1024 * 1024

/** How many records the startup load and the read window keep. */
export const HISTORY_WINDOW = 500

/**
 * The durable history sink/reader. Writes are appended through a serialized
 * queue; reads wait for the startup load so "not loaded yet" is never shown as
 * "no records".
 */
export class FileHistory implements HistorySink, HistoryReader {
  /** Resolves when the startup load has finished (successfully or not). */
  readonly ready: Promise<void>
  private readonly store: JsonlHistoryStore
  private readonly queue: BoundedHistoryQueue
  private readonly buffered: HistoryRecord[] = []
  private loaded = false

  /**
   * @param path - the `history.jsonl` path.
   * @param report - where read/rotation/write problems are reported.
   */
  constructor(path: string, report: (problem: string) => void) {
    this.store = new JsonlHistoryStore(path, report)
    this.queue = new BoundedHistoryQueue(this.store, { capacity: HISTORY_WINDOW, onProblem: report })
    this.ready = this.start()
  }

  private async start(): Promise<void> {
    this.queue.hydrate(await this.store.load())
    this.loaded = true
    for (const record of this.buffered.splice(0)) this.queue.write(record)
  }

  /** Queue one record (buffered until the startup load has seeded the window). Never throws. */
  write(record: HistoryRecord): void {
    if (!this.loaded) {
      this.buffered.push(record)
      if (this.buffered.length > HISTORY_WINDOW) this.buffered.shift()
      return
    }
    this.queue.write(record)
  }

  /** {@link HistoryReader.recent}: the current window (empty until the load has finished). */
  recent(limit?: number, target?: string): readonly HistoryRecord[] {
    return this.queue.recent(limit, target)
  }

  /**
   * The recent records after the startup load. This is what the bridge's
   * `history()` awaits, so a reload never answers an empty list while the file
   * is still being read.
   * @param limit - maximum records (the bridge's default applies it).
   * @param target - only records targeting this application.
   * @returns the newest records first.
   */
  async history(limit?: number, target?: string): Promise<readonly HistoryRecord[]> {
    await this.ready
    // A read follows the same rule the caller expects of "recent calls": wait
    // for the queued appends, so a read right after a call sees the record the
    // file will answer on the next start.
    await this.queue.flush()
    return this.queue.recent(limit, target)
  }

  /** Wait for the load and every queued append (tests/shutdown). */
  async flush(): Promise<void> {
    await this.ready
    await this.queue.flush()
  }
}

/** The JSONL file itself: parse on load, append with rotation, one write at a time. */
class JsonlHistoryStore {
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly path: string, private readonly report: (problem: string) => void) {}

  async load(): Promise<readonly HistoryRecord[]> {
    const current = await this.read(this.path)
    let records = current.records
    let bad = current.bad
    if (records.length < HISTORY_WINDOW) {
      const older = await this.read(`${this.path}.1`)
      records = [...older.records, ...records]
      bad += older.bad
    }
    // The per-file parse counters are reported once, together, so a damaged
    // file produces one line rather than one per record.
    if (bad > 0) this.report(`history: skipped ${String(bad)} malformed line(s) in ${this.path}`)
    return records.slice(-HISTORY_WINDOW)
  }

  /** Append one batch atomically with respect to other appends (the queue drains serially). */
  append(records: readonly HistoryRecord[]): Promise<void> {
    const text = records.map(record => JSON.stringify(record)).join('\n') + '\n'
    const run = async (): Promise<void> => {
      await mkdir(dirname(this.path), { recursive: true })
      const size = await stat(this.path).then(info => info.size).catch(() => 0)
      if (size > 0 && size + Buffer.byteLength(text) > HISTORY_FILE_LIMIT) {
        const rotated = `${this.path}.1`
        await rm(rotated, { force: true })
        await rename(this.path, rotated)
      }
      await appendFile(this.path, text)
    }
    const attempt = this.chain.then(run, run)
    this.chain = attempt.catch(() => undefined)
    return attempt
  }

  private async read(path: string): Promise<{ records: HistoryRecord[]; bad: number }> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (!isMissingFile(error)) this.report(`history: ${path} cannot be read: ${reasonOf(error)}`)
      return { records: [], bad: 0 }
    }
    const records: HistoryRecord[] = []
    let bad = 0
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const record = recordOf(JSON.parse(line))
        if (record === undefined) bad += 1
        else records.push(record)
      } catch {
        bad += 1
      }
    }
    return { records, bad }
  }
}

/** Validate one JSONL line as a HistoryRecord; `undefined` when it is not one. */
function recordOf(value: unknown): HistoryRecord | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.callId !== 'string' || typeof value.target !== 'string' || typeof value.op !== 'string') return undefined
  if (typeof value.startedAt !== 'string' || typeof value.endedAt !== 'string') return undefined
  const status = value.status === 'success' ? 'success' : value.status
  if (status !== 'success' && status !== 'rejected' && status !== 'failed' && status !== 'cancelled' && status !== 'unknown') return undefined
  const caller = callerOf(value.caller)
  if (caller === undefined) return undefined
  if (value.code !== undefined && typeof value.code !== 'string') return undefined
  if (value.message !== undefined && typeof value.message !== 'string') return undefined
  return {
    callId: value.callId,
    caller,
    target: value.target,
    op: value.op,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    status: status as HistoryRecord['status'],
    ...(value.code === undefined ? {} : { code: value.code }),
    ...(value.message === undefined ? {} : { message: value.message }),
  }
}

/** Validate one stored caller. */
function callerOf(value: unknown): HistoryRecord['caller'] | undefined {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
