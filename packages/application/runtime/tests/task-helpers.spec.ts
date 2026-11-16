import { describe, expect, it } from 'vitest'
import { ProgressReporter, SingleFlight, TaskReceipts, runPeriodically } from '../src/task-helpers.ts'

describe('task helpers', () => {
  it('shares one in-flight call per key and clears it afterwards', async () => {
    const flights = new SingleFlight()
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = flights.run('source', async () => { calls += 1; await gate; return 'ok' })
    const second = flights.run('source', async () => { calls += 1; return 'no' })
    expect(flights.busy('source')).toBe(true)
    expect(calls).toBe(1)
    expect(second).toBe(first)
    release()
    await expect(first).resolves.toBe('ok')
    expect(flights.busy('source')).toBe(false)
    await expect(flights.run('source', async () => 'again')).resolves.toBe('again')
  })

  it('runs on an interval until aborted and does not overlap a slow tick', async () => {
    const controller = new AbortController()
    const timers: Array<() => void> = []
    let runs = 0
    const stop = runPeriodically({
      intervalMs: 10,
      signal: controller.signal,
      setTimer: (fn) => { timers.push(fn); return timers.length },
      clearTimer: () => undefined,
      run: async () => { runs += 1 },
    })
    await Promise.resolve()
    expect(runs).toBe(1)
    timers.shift()?.()
    await Promise.resolve()
    expect(runs).toBe(2)
    controller.abort()
    stop()
    const before = runs
    timers.shift()?.()
    await Promise.resolve()
    expect(runs).toBe(before)
  })

  it('stops before the first tick when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let runs = 0
    const stop = runPeriodically({ intervalMs: 10, signal: controller.signal, run: () => { runs += 1 } })
    await Promise.resolve()
    expect(runs).toBe(0)
    stop()
  })
})

describe('progress reporter', () => {
  it('emits the first report immediately and holds the latest until flush', () => {
    let now = 0
    const calls: Array<{ message: string; data?: unknown }> = []
    const reporter = new ProgressReporter((message, data) => { calls.push({ message, ...(data === undefined ? {} : { data }) }) }, 100, () => now)
    reporter.push('first', { n: 1 })
    expect(calls).toEqual([{ message: 'first', data: { n: 1 } }])
    now = 10
    reporter.push('second')
    reporter.push('third')
    expect(calls).toHaveLength(1)
    reporter.flush()
    expect(calls).toEqual([{ message: 'first', data: { n: 1 } }, { message: 'third' }])
    now = 200
    reporter.push('fourth')
    expect(calls.at(-1)?.message).toBe('fourth')
  })
})

describe('task receipts', () => {
  it('replays a recorded id and evicts the oldest at capacity', () => {
    const receipts = new TaskReceipts(2)
    expect(receipts.get('a')).toBeUndefined()
    receipts.record('a', 'one')
    receipts.record('a', 'ignored')
    receipts.record('b', 'two')
    receipts.record('c', 'three')
    expect(receipts.get('a')).toBeUndefined()
    expect(receipts.get('b')).toBe('two')
    expect(receipts.get('c')).toBe('three')
  })
})

describe('task helper edges', () => {
  it('stops a periodic run that aborts during its callback and flushes an empty reporter', async () => {
    const controller = new AbortController()
    let runs = 0
    const stop = runPeriodically({
      intervalMs: 1,
      signal: controller.signal,
      run: () => { runs += 1; controller.abort() },
    })
    await new Promise<void>(resolve => { setTimeout(resolve, 10) })
    stop()
    expect(runs).toBe(1)
    const reporter = new ProgressReporter(() => undefined, 100, () => 0)
    reporter.flush()
    expect(runs).toBe(1)
  })
})

describe('periodic default timers', () => {
  it('uses the default timer pair and stops cleanly', async () => {
    const controller = new AbortController()
    let runs = 0
    const stop = runPeriodically({ intervalMs: 1, signal: controller.signal, run: () => { runs += 1 } })
    await new Promise<void>(resolve => { setTimeout(resolve, 8) })
    stop()
    expect(runs).toBeGreaterThan(1)
  })
})
