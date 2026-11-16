/**
 * Basic operation history: an independent, capacity-bounded best-effort queue.
 *
 * History answers "who called what, when, and how it ended" — it is not
 * business state, and it is never a precondition for a call: a full queue or a
 * failing store reports a problem and drops the record, and the business call
 * finishes with its own result regardless.
 * @module @matrix1001/dsh-application-harness-runtime
 */

import type { HistoryRecord, HistorySink } from './runtime.ts'

/** One durable writer the queue drains into. */
export interface HistoryStore {
  /** Append records (called with a batch; must not throw for a full store — the queue reports). */
  append(records: readonly HistoryRecord[]): Promise<void>
}

/**
 * The read side of basic history: the recent records a sink still holds in
 * memory. Reading history is a convenience over the sink, never a second
 * store — a sink that keeps no window simply does not implement this, and
 * {@link ApplicationRuntime.recentHistory} then answers empty rather than
 * inventing records.
 */
export interface HistoryReader {
  /**
   * Up to `limit` most recent records, newest first. `limit` absent = whatever
   * window the reader keeps. A `target` narrows the window to the records whose
   * TARGET is that application BEFORE the limit is taken, so "the newest N
   * calls of X" is a question the reader answers — filtering a global window
   * elsewhere cannot (a busy application would crowd X out of it).
   * @param limit - maximum records to return.
   * @param target - the application whose calls to answer; absent = every target.
   */
  recent(limit?: number, target?: string): readonly HistoryRecord[]
}

/** The newest `limit` records of one oldest-first window, newest first, optionally of one target. */
function newestFirst(
  records: readonly HistoryRecord[], limit: number | undefined, target?: string,
): readonly HistoryRecord[] {
  const window = target === undefined ? records : records.filter(record => record.target === target)
  const count = limit ?? window.length
  if (count <= 0) return []
  return window.slice(-count).reverse()
}

/** Options of {@link BoundedHistoryQueue}. */
export interface HistoryQueueOptions {
  /** How many records may wait before the oldest are dropped. */
  readonly capacity?: number
  /** Called when a record is dropped (full queue) or a write fails. */
  readonly onProblem?: (problem: string) => void
}

/**
 * The bounded queue. Callers hand it records synchronously; a background drain
 * writes them in arrival order. Dropping (a full queue) and write failures are
 * reported through `onProblem` — neither is ever thrown at the caller, and
 * neither changes the outcome of the call that produced the record.
 */
export class BoundedHistoryQueue implements HistorySink, HistoryReader {
  private readonly pending: HistoryRecord[] = []
  /** The most recent records seen (queued or already written), oldest first; the read window. */
  private readonly window: HistoryRecord[] = []
  private readonly capacity: number
  private readonly onProblem: (problem: string) => void
  private draining: Promise<void> | undefined
  private dropped = 0

  constructor(private readonly store: HistoryStore, options: HistoryQueueOptions = {}) {
    this.capacity = options.capacity ?? 256
    this.onProblem = options.onProblem ?? (() => {})
  }

  /** Queue one record; never blocks, never throws. */
  write(record: HistoryRecord): void {
    if (this.pending.length >= this.capacity) {
      this.pending.shift()
      this.dropped += 1
      this.onProblem(`history queue full (capacity ${String(this.capacity)}): dropped the oldest record (${String(this.dropped)} dropped so far)`)
    }
    this.pending.push(record)
    this.window.push(record)
    if (this.window.length > this.capacity) this.window.shift()
    this.draining ??= this.drain()
  }

  /** {@link HistoryReader.recent}: the newest records the queue has seen, written or still queued. */
  recent(limit?: number, target?: string): readonly HistoryRecord[] {
    return newestFirst(this.window, limit, target)
  }

  /**
   * Seed the read window with records loaded from durable history (oldest
   * first). They enter the window only — never the pending queue — so loading
   * history at startup cannot re-write the records it just read.
   * @param records - the loaded records, oldest first.
   */
  hydrate(records: readonly HistoryRecord[]): void {
    for (const record of records) this.window.push(record)
    while (this.window.length > this.capacity) this.window.shift()
  }

  /** Wait for everything queued so far to be written (tests and shutdown). */
  async flush(): Promise<void> {
    while (this.draining !== undefined) await this.draining
  }

  /** How many records were dropped because the queue was full. */
  get droppedCount(): number {
    return this.dropped
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const batch = this.pending.splice(0, this.pending.length)
        try {
          await this.store.append(batch)
        } catch (error) {
          this.onProblem(`history store write failed (${String(batch.length)} record(s) lost): ${String((error as Error)?.message ?? error)}`)
        }
      }
    } finally {
      this.draining = undefined
    }
  }
}

/**
 * An in-memory sink that keeps the most recent records (development and tests).
 */
export class MemoryHistory implements HistorySink, HistoryReader {
  private readonly records: HistoryRecord[] = []

  constructor(private readonly limit = 1_000) {}

  write(record: HistoryRecord): void {
    this.records.push(record)
    if (this.records.length > this.limit) this.records.shift()
  }

  /** The records kept, oldest first. */
  all(): readonly HistoryRecord[] {
    return [...this.records]
  }

  /** {@link HistoryReader.recent}: the newest records kept, newest first. */
  recent(limit?: number, target?: string): readonly HistoryRecord[] {
    return newestFirst(this.records, limit, target)
  }
}
