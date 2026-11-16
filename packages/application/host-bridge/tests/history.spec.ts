/**
 * The durable call-history file: JSONL append, rotation, the startup window,
 * malformed-line tolerance and the ordering across a restart.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileHistory, HISTORY_FILE_LIMIT, HISTORY_WINDOW } from '../src/history.ts'
import type { Caller, HistoryRecord } from '@matrix1001/dsh-application-harness-runtime'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'application-harness-history-file-'))
  dirs.push(dir)
  return dir
}

function record(op: string, over: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    callId: `c-${op}`,
    caller: { kind: 'human' },
    target: 'demo',
    op,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    status: 'success',
    ...over,
  }
}

describe('FileHistory: append, load, window', () => {
  it('round-trips records and answers newest first after a reload', async () => {
    const path = join(temp(), 'history.jsonl')
    const history = new FileHistory(path, () => {})
    history.write(record('one'))
    history.write(record('two'))
    await history.flush()
    expect(history.recent(1).map(item => item.op)).toEqual(['two'])
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
    const reloaded = new FileHistory(path, () => {})
    expect((await reloaded.history()).map(item => item.op)).toEqual(['two', 'one'])
    expect((await reloaded.history(1)).map(item => item.op)).toEqual(['two'])
    expect((await reloaded.history(50, 'demo')).map(item => item.op)).toEqual(['two', 'one'])
    expect(await reloaded.history(50, 'other')).toEqual([])
    await reloaded.flush()
  })

  it('skips malformed lines and reports them once', async () => {
    const path = join(temp(), 'history.jsonl')
    const valid = record('good')
    writeFileSync(path, [
      JSON.stringify(valid),
      'not json',
      JSON.stringify(record('bad-status', { status: 'nope' as never })),
      JSON.stringify(record('bad-caller', { caller: { kind: 'app' } as never })),
      JSON.stringify(record('bad-kind', { caller: { kind: 'weird' } as never })),
      JSON.stringify(record('bad-object-caller', { caller: 'x' as never })),
      JSON.stringify(record('bad-code', { code: 1 as never })),
      JSON.stringify(record('bad-message', { message: 1 as never })),
      JSON.stringify(record('bad-target', { target: 1 as never })),
      JSON.stringify(record('bad-op', { op: 1 as never })),
      JSON.stringify(record('bad-call', { callId: 1 as never })),
      JSON.stringify(record('bad-dates', { startedAt: 1 as never })),
      'null',
      '[]',
      '',
      JSON.stringify(record('good-2', { code: 'stale-version', message: 'why' })),
    ].join('\n') + '\n')
    const problems: string[] = []
    const history = new FileHistory(path, problem => { problems.push(problem) })
    expect((await history.history()).map(item => item.op)).toEqual(['good-2', 'good'])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('malformed')
    await history.flush()
  })

  it('accepts every caller kind and keeps only the newest window', async () => {
    const path = join(temp(), 'history.jsonl')
    const callers: Caller[] = [
      { kind: 'human' },
      { kind: 'app', appId: 'a' },
      { kind: 'background', appId: 'b' },
      { kind: 'ai' },
      { kind: 'ai', sessionId: 's', turnId: 't' },
    ]
    const lines = Array.from({ length: 600 }, (_, index) => JSON.stringify(record(`r-${index}`, { caller: callers[index % callers.length]! })))
    writeFileSync(path, lines.join('\n') + '\n')
    const history = new FileHistory(path, () => {})
    const records = await history.history()
    expect(records).toHaveLength(HISTORY_WINDOW)
    expect(records[0]!.op).toBe('r-599')
    expect(records.at(-1)!.op).toBe('r-100')
    await history.flush()
  })

  it('reads history.jsonl.1 only when the current file is below the window, and reports its bad lines', async () => {
    const path = join(temp(), 'history.jsonl')
    writeFileSync(`${path}.1`, `${JSON.stringify(record('older'))}\nnot json\n`)
    writeFileSync(path, `${JSON.stringify(record('newer'))}\n`)
    const problems: string[] = []
    const history = new FileHistory(path, problem => { problems.push(problem) })
    expect((await history.history()).map(item => item.op)).toEqual(['newer', 'older'])
    expect(problems.join('\n')).toContain('malformed')
    await history.flush()
  })

  it('rotates current to .1 before an append that would exceed the soft limit', async () => {
    const path = join(temp(), 'history.jsonl')
    const history = new FileHistory(path, () => {})
    history.write(record('big', { message: 'x'.repeat(HISTORY_FILE_LIMIT) }))
    await history.flush()
    expect(statSync(path).size).toBeGreaterThan(HISTORY_FILE_LIMIT)
    history.write(record('after'))
    await history.flush()
    expect(statSync(`${path}.1`).size).toBeGreaterThan(HISTORY_FILE_LIMIT)
    const reloaded = new FileHistory(path, () => {})
    expect((await reloaded.history()).map(item => item.op)).toEqual(['after', 'big'])
    await reloaded.flush()
  })

  it('buffers writes that arrive before the startup load and keeps the order', async () => {
    const path = join(temp(), 'history.jsonl')
    writeFileSync(path, `${JSON.stringify(record('old'))}\n`)
    const history = new FileHistory(path, () => {})
    history.write(record('new'))
    // The load has not finished: the read window is still empty (and the write
    // is buffered, not lost).
    expect(history.recent()).toEqual([])
    await history.flush()
    expect((await history.history()).map(item => item.op)).toEqual(['new', 'old'])
    expect(readFileSync(path, 'utf8').trim().split('\n').map(line => (JSON.parse(line) as HistoryRecord).op)).toEqual(['old', 'new'])
  })

  it('reports a read/write failure without throwing at the writer', async () => {
    const file = join(temp(), 'not-a-directory')
    writeFileSync(file, 'x')
    const problems: string[] = []
    const history = new FileHistory(join(file, 'history.jsonl'), problem => { problems.push(problem) })
    history.write(record('kept-in-window'))
    await history.flush()
    expect((await history.history()).map(item => item.op)).toEqual(['kept-in-window'])
    expect(problems.join('\n')).toContain('cannot be read')
    expect(problems.join('\n')).toContain('history store write failed')
  })
})

  it('bounds records buffered before the startup load finishes', async () => {
    const path = join(temp(), 'history.jsonl')
    const history = new FileHistory(path, () => {})
    for (let index = 0; index < HISTORY_WINDOW + 1; index += 1) history.write(record(`buffered-${index}`))
    await history.flush()
    expect(await history.history()).toHaveLength(HISTORY_WINDOW)
    await history.flush()
  })
