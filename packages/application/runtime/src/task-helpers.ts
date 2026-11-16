/**
 * Small application-side task helpers. They do not replace the runtime's task
 * protocol (`startTask`, snapshots, cancellation); they only remove the repeated
 * single-flight and periodic-timer bookkeeping around it.
 * @module @matrix1001/dsh-application-harness-runtime/task-helpers
 */

/** De-duplicate work by a business key (a source id, a scan root, a workspace). */
export class SingleFlight {
  private readonly inFlight = new Map<string, Promise<unknown>>()

  /**
   * Run one work item per key; a concurrent caller joins the running promise.
   * @param key - the resource key.
   * @param work - the work to run when no call is in flight.
   * @returns the shared result.
   */
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key)
    if (existing !== undefined) return existing as Promise<T>
    const pending = work().finally(() => {
      /* v8 ignore next -- only this call can own the key while its promise is pending */
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key)
    })
    this.inFlight.set(key, pending)
    return pending
  }

  /** Whether one key currently has work in flight. */
  busy(key: string): boolean { return this.inFlight.has(key) }
}

/** What a periodic helper needs from the caller. */
export interface PeriodicOptions {
  readonly intervalMs: number
  readonly signal: AbortSignal
  readonly run: () => void | Promise<void>
  /** Injectable timers for tests; defaults to the global functions. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

/**
 * Run one callback on a fixed interval until the signal aborts. A slow callback
 * delays the next tick instead of overlapping itself.
 * @param options - interval, abort signal and callback.
 * @returns a stop function (also idempotent with the abort signal).
 */
export function runPeriodically(options: PeriodicOptions): () => void {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  let stopped = false
  let handle: unknown
  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (handle !== undefined) clearTimer(handle)
  }
  const tick = async (): Promise<void> => {
    if (stopped || options.signal.aborted) return
    try { await options.run() } catch { /* the caller owns reporting; the timer continues */ }
    if (stopped || options.signal.aborted) return
    handle = setTimer(() => { void tick() }, options.intervalMs)
  }
  options.signal.addEventListener('abort', stop, { once: true })
  void tick()
  return stop
}

/** One progress snapshot waiting for the throttle window. */
export interface PendingProgress {
  readonly message: string
  readonly data?: unknown
}

/**
 * Throttle task progress: the first report is immediate, later reports replace
 * one pending snapshot, and `flush` emits the latest one. A dropped intermediate
 * report is intended — progress is a control-plane projection, not a log.
 */
export class ProgressReporter {
  private last = Number.NEGATIVE_INFINITY
  private pending: PendingProgress | undefined

  /**
   * @param report - the runtime's task progress writer.
   * @param intervalMs - minimum interval between writes.
   * @param now - injectable clock for tests.
   */
  constructor(
    private readonly report: (message: string, data?: unknown) => void,
    private readonly intervalMs = 250,
    private readonly now: () => number = Date.now,
  ) {}

  /** Report one progress snapshot, or hold it until the window opens. */
  push(message: string, data?: unknown): void {
    const now = this.now()
    if (this.pending === undefined && now - this.last >= this.intervalMs) {
      this.last = now
      this.report(message, data)
      return
    }
    /* v8 ignore next -- both data-present and data-absent are exercised; v8 attributes the ternary oddly */
    this.pending = { message, ...(data === undefined ? {} : { data }) }
  }

  /** Emit a held snapshot immediately (a terminal state should not wait). */
  flush(): void {
    const pending = this.pending
    if (pending === undefined) return
    this.pending = undefined
    this.last = this.now()
    this.report(pending.message, pending.data)
  }
}

/** A bounded receipt table: requestId → the business record it created. */
export class TaskReceipts {
  private readonly receipts = new Map<string, string>()

  /**
   * @param capacity - how many receipts to retain (oldest dropped first).
   */
  constructor(private readonly capacity = 200) {}

  /** The business id recorded for a request, when the request already ran. */
  get(requestId: string): string | undefined { return this.receipts.get(requestId) }

  /** Remember one request's result; re-recording the same key is a no-op. */
  record(requestId: string, id: string): void {
    if (this.receipts.has(requestId)) return
    this.receipts.set(requestId, id)
    while (this.receipts.size > this.capacity) {
      const oldest = this.receipts.keys().next().value
      /* v8 ignore next -- the while guard proves an entry exists */
      if (oldest === undefined) break
      this.receipts.delete(oldest)
    }
  }
}
