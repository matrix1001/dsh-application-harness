/**
 * The platform subprocess seam under the application's policy: a scripted
 * producer stands in for the platform provider, so spawn ordering, the byte
 * cap, the deadline, cancellation and the error vocabulary are all driven
 * deterministically — without depending on the machine's git.
 */
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  CANCEL_WAIT_MS, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, GitProcessRunner, KILL_GRACE_MS,
} from '../src/subprocess.ts'
import type { GitRunContext } from '../src/subprocess.ts'

/** One scripted handle: the streams, the outcome promise and the calls the runner made. */
interface FakeHandle extends SubprocessHandle {
  out: (text: string) => void
  err: (text: string) => void
  settle: (outcome: SubprocessOutcome) => void
  fail: (error: unknown) => void
  terminates: number
  waits: number
}

/** Build a handle the test drives by hand. */
function fakeHandle(options: { streams?: boolean } = {}): FakeHandle {
  const withStreams = options.streams !== false
  const stdout = withStreams ? new PassThrough() : undefined
  const stderr = withStreams ? new PassThrough() : undefined
  const { promise, resolve, reject } = Promise.withResolvers<SubprocessOutcome>()
  const handle: FakeHandle = {
    stdin: undefined,
    stdout,
    stderr,
    control: undefined,
    collected: {},
    done: promise,
    terminate: () => { handle.terminates += 1 },
    waitForExit: async () => { handle.waits += 1; return true },
    out: (text) => { stdout?.write(text) },
    err: (text) => { stderr?.write(text) },
    settle: (outcome) => { resolve(outcome) },
    fail: (error) => { reject(error) },
    terminates: 0,
    waits: 0,
  }
  // The runner attaches its own handler; keep a test's scripted rejection from
  // surfacing as an unhandled rejection instead of a clean assertion.
  handle.done.catch(() => {})
  return handle
}

/** The scripted producer plus the specs it received. */
interface FakeSpawner {
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  specs: SubprocessSpawnSpec[]
  handles: FakeHandle[]
}

/** Build a producer that honours the abort like a cooperative child unless told otherwise. */
function fakeSpawner(options: { honorAbort?: boolean; throwOnSpawn?: unknown; handle?: FakeHandle } = {}): FakeSpawner {
  const specs: SubprocessSpawnSpec[] = []
  const handles: FakeHandle[] = []
  return {
    specs,
    handles,
    spawn: (spec) => {
      if (options.throwOnSpawn !== undefined) throw options.throwOnSpawn
      specs.push(spec)
      const handle = options.handle ?? fakeHandle()
      if (options.honorAbort !== false) {
        spec.signal?.addEventListener('abort', () => { handle.settle({ exitCode: null, signal: 'SIGTERM' }) }, { once: true })
      }
      handles.push(handle)
      return handle
    },
  }
}

/** The run context (capability allowed). */
function context(signal: AbortSignal = new AbortController().signal): GitRunContext {
  return {
    signal,
    capabilities: { use: async (_name, work) => await work() },
  }
}

afterEach(() => { vi.useRealTimers() })

describe('GitProcessRunner', () => {
  it('spawns git with the fixed environment and returns the closed process facts', async () => {
    const spawner = fakeSpawner()
    const runner = new GitProcessRunner({ subprocess: spawner })
    const running = runner.run(['status', '-z'], context())
    const handle = spawner.handles[0]!
    handle.out('out')
    handle.err('err')
    handle.settle({ exitCode: 0, signal: null })
    const result = await running
    expect(result).toMatchObject({ code: 0, signal: null, stdout: 'out', stderr: 'err', truncated: false })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(spawner.specs[0]).toMatchObject({
      argv: ['git', 'status', '-z'],
      graceMs: KILL_GRACE_MS,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      env: { GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANG: 'C' },
    })
    expect(DEFAULT_MAX_BYTES).toBe(1024 * 1024)
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000)
    expect(CANCEL_WAIT_MS).toBe(KILL_GRACE_MS + 1_000)
  })

  it('uses the configured binary, deadline and cap', async () => {
    const spawner = fakeSpawner()
    const runner = new GitProcessRunner({ subprocess: spawner, gitBinary: '/usr/bin/git', timeoutMs: 1_000, maxBytes: 8 })
    const running = runner.run(['log'], context())
    spawner.handles[0]!.settle({ exitCode: 0, signal: null })
    await running
    expect(spawner.specs[0]!.argv[0]).toBe('/usr/bin/git')
  })

  it('does not spawn when the process capability is refused', async () => {
    const spawner = fakeSpawner()
    const runner = new GitProcessRunner({ subprocess: spawner })
    const refused = new AppError('capability-not-approved', 'no')
    const ctx: GitRunContext = {
      signal: new AbortController().signal,
      capabilities: { use: async () => { throw refused } },
    }
    await expect(runner.run(['status'], ctx)).rejects.toBe(refused)
    expect(spawner.specs).toEqual([])
  })

  it('reports a synchronous spawn failure as git-missing', async () => {
    const spawner = fakeSpawner({ throwOnSpawn: new Error('ENOENT') })
    const runner = new GitProcessRunner({ subprocess: spawner })
    await expect(runner.run(['status'], context())).rejects.toMatchObject({ code: 'git-missing' })
  })

  it('reports a rejected child outcome as git-missing', async () => {
    const spawner = fakeSpawner()
    const runner = new GitProcessRunner({ subprocess: spawner })
    const running = runner.run(['status'], context())
    spawner.handles[0]!.fail('provider failed')
    await expect(running).rejects.toMatchObject({ code: 'git-missing' })
  })

  it('turns a missed deadline into timeout and waits for the range', async () => {
    const spawner = fakeSpawner()
    const runner = new GitProcessRunner({ subprocess: spawner, timeoutMs: 5 })
    const running = runner.run(['status'], context())
    await expect(running).rejects.toMatchObject({ code: 'timeout' })
    expect(spawner.handles[0]!.waits).toBe(1)
  })

  it('turns a rejected child after the deadline into timeout', async () => {
    const spawner = fakeSpawner({ honorAbort: false })
    const runner = new GitProcessRunner({ subprocess: spawner, timeoutMs: 5 })
    const running = runner.run(['status'], context())
    setTimeout(() => { spawner.handles[0]!.fail(new Error('killed')) }, 15)
    await expect(running).rejects.toMatchObject({ code: 'timeout' })
    expect(spawner.handles[0]!.waits).toBe(1)
  })

  it('reports a caller cancellation as an AbortError after the range empties', async () => {
    const controller = new AbortController()
    const spawner = fakeSpawner()
    const runner = new GitProcessRunner({ subprocess: spawner })
    const running = runner.run(['status'], context(controller.signal))
    setTimeout(() => { controller.abort() }, 5)
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawner.handles[0]!.waits).toBe(1)
  })

  it('turns a rejected child after a cancellation into an AbortError', async () => {
    const controller = new AbortController()
    const spawner = fakeSpawner({ honorAbort: false })
    const runner = new GitProcessRunner({ subprocess: spawner })
    const running = runner.run(['status'], context(controller.signal))
    setTimeout(() => {
      controller.abort()
      spawner.handles[0]!.fail(new Error('killed'))
    }, 5)
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawner.handles[0]!.waits).toBe(1)
  })

  it('never spawns for an already-cancelled call', async () => {
    const controller = new AbortController()
    controller.abort()
    const spawner = fakeSpawner()
    const runner = new GitProcessRunner({ subprocess: spawner })
    await expect(runner.run(['status'], context(controller.signal))).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawner.specs).toEqual([])
  })

  it('caps each stream from the tail and reports truncation', async () => {
    const zero = fakeSpawner()
    const zeroRunner = new GitProcessRunner({ subprocess: zero, maxBytes: 0 })
    const zeroRun = zeroRunner.run(['status'], context())
    zero.handles[0]!.out('anything')
    zero.handles[0]!.settle({ exitCode: 0, signal: null })
    expect(await zeroRun).toMatchObject({ stdout: '', truncated: true })

    const partial = fakeSpawner()
    const partialRunner = new GitProcessRunner({ subprocess: partial, maxBytes: 4 })
    const partialRun = partialRunner.run(['status'], context())
    partial.handles[0]!.out('abcdef')
    partial.handles[0]!.settle({ exitCode: 0, signal: null })
    expect(await partialRun).toMatchObject({ stdout: 'abcd', truncated: true })

    const stderrOnly = fakeSpawner()
    const stderrRunner = new GitProcessRunner({ subprocess: stderrOnly, maxBytes: 3 })
    const stderrRun = stderrRunner.run(['status'], context())
    stderrOnly.handles[0]!.err('abcdef')
    stderrOnly.handles[0]!.settle({ exitCode: 0, signal: null })
    expect(await stderrRun).toMatchObject({ stdout: '', stderr: 'abc', truncated: true })
  })

  it('tolerates a provider handle with no streams', async () => {
    const spawner = fakeSpawner({ handle: fakeHandle({ streams: false }) })
    const runner = new GitProcessRunner({ subprocess: spawner })
    const running = runner.run(['status'], context())
    spawner.handles[0]!.settle({ exitCode: 0, signal: null })
    expect(await running).toMatchObject({ stdout: '', stderr: '', truncated: false })
  })

  it('refuses a malformed byte cap or deadline as invalid-config', async () => {
    const spawner = fakeSpawner()
    await expect(new GitProcessRunner({ subprocess: spawner, maxBytes: -1 }).run(['status'], context()))
      .rejects.toMatchObject({ code: 'invalid-config' })
    await expect(new GitProcessRunner({ subprocess: spawner, maxBytes: 1.5 }).run(['status'], context()))
      .rejects.toMatchObject({ code: 'invalid-config' })
    await expect(new GitProcessRunner({ subprocess: spawner, timeoutMs: 0 }).run(['status'], context()))
      .rejects.toMatchObject({ code: 'invalid-config' })
    await expect(new GitProcessRunner({ subprocess: spawner, timeoutMs: 1.5 }).run(['status'], context()))
      .rejects.toMatchObject({ code: 'invalid-config' })
    expect(spawner.specs).toEqual([])
  })
})
