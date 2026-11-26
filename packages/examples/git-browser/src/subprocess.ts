/**
 * The application's process seam: one fixed-argv `git` command supervised by
 * the **platform** subprocess service (`ctx.subprocess`). The platform owns the
 * spawn, the execution world, cancellation, process-group termination and the
 * range wait; this module owns what a *git reader* means: the binary argv
 * prefix, the per-stream byte cap, the wall-clock deadline and the error
 * vocabulary (`git-missing`, `timeout`).
 *
 * Output is capped at 1 MiB per stream and the excess is dropped from the
 * TAIL — the opposite of the platform collect mode, which keeps a bounded tail
 * because diagnostics cluster at the end. A truncated `status` must keep its
 * branch header and a truncated `log` its newest commits; the fact is reported
 * as `truncated` on every result, and the application turns it into
 * `output-too-large` where a prefix would be a lie.
 * @module @matrix1001/dsh-application-harness-git-browser/subprocess
 */

import { Buffer } from 'node:buffer'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** The default per-stream capture cap (1 MiB). */
export const DEFAULT_MAX_BYTES = 1024 * 1024

/** The default wall-clock deadline for one git read (ms). */
export const DEFAULT_TIMEOUT_MS = 10_000

/**
 * The grace window (ms) between the abort's `SIGTERM` and the escalating
 * `SIGKILL`, handed to the platform's termination procedure.
 */
export const KILL_GRACE_MS = 5_000

/** How long a cancelled/timed-out run waits for its managed range to empty. */
export const CANCEL_WAIT_MS = KILL_GRACE_MS + 1_000

/** The capability door the runner uses (a structural subset of the runtime's). */
export interface GitCapabilityDoor {
  /** Run `work` only when the application may use `process`. */
  use<T>(name: string, work: () => T | Promise<T>): Promise<T>
}

/** What one git command needs from its caller. */
export interface GitRunContext {
  /** The call's cancellation request. */
  readonly signal: AbortSignal
  /** The application's capability door. */
  readonly capabilities: GitCapabilityDoor
}

/** One git child's exit facts and capped output. */
export interface GitCommandResult {
  /** The exit code (`null` when killed by a signal). */
  readonly code: number | null
  /** The terminating signal (`null` on a normal exit). */
  readonly signal: NodeJS.Signals | null
  /** Captured standard output (decoded UTF-8, capped). */
  readonly stdout: string
  /** Captured standard error (decoded UTF-8, capped). */
  readonly stderr: string
  /** Whether either stream was truncated at the byte cap. */
  readonly truncated: boolean
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number
}

/**
 * The one call this application makes on its process seam. {@link
 * GitProcessRunner} satisfies it over the platform subprocess service, and the
 * app specs hand it a scripted executor instead.
 */
export interface GitCommandRunner {
  /** Run one git command (without the binary as `argv[0]`). */
  run(argv: readonly string[], ctx: GitRunContext): Promise<GitCommandResult>
}

/** The platform subprocess shape this module spawns through. */
export interface SubprocessSpawner {
  /** Start one managed child process from a fully-specified spec. */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

/** The runner's configuration. */
export interface GitProcessOptions {
  /** The platform subprocess service (`ctx.subprocess`). */
  readonly subprocess: SubprocessSpawner
  /** The git binary to run (default `git`). */
  readonly gitBinary?: string
  /** Per-run wall-clock deadline in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  readonly timeoutMs?: number
  /** Per-stream capture cap in bytes (default {@link DEFAULT_MAX_BYTES}). */
  readonly maxBytes?: number
}

/** One thrown value's message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The caller's own cancellation (the runtime reads this name as a cancellation). */
function cancellationError(): Error {
  return Object.assign(new Error('git-browser command was cancelled'), { name: 'AbortError' })
}

/** A byte-capped UTF-8 accumulator (the excess is dropped, not buffered). */
class ByteCap {
  private readonly chunks: Buffer[] = []
  private size = 0
  /** Whether the cap dropped anything. */
  truncated = false

  constructor(private readonly cap: number) {}

  /** Append one chunk, dropping whatever exceeds the cap. */
  push(chunk: Buffer): void {
    const room = this.cap - this.size
    if (room <= 0) {
      this.truncated = true
      return
    }
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room))
      this.size = this.cap
      this.truncated = true
      return
    }
    this.chunks.push(chunk)
    this.size += chunk.length
  }

  /** The captured text. */
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/** Run one git command through the platform subprocess service. */
export class GitProcessRunner implements GitCommandRunner {
  private readonly subprocess: SubprocessSpawner
  private readonly gitBinary: string
  private readonly maxBytes: number
  private readonly timeoutMs: number

  constructor(options: GitProcessOptions) {
    this.subprocess = options.subprocess
    this.gitBinary = options.gitBinary ?? 'git'
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * Run one command under the platform's supervision.
   * @param argv - the git arguments (without the binary).
   * @param ctx - the call's cancellation request and capability door.
   * @returns the exit facts and the capped output.
   * @throws AppError `git-missing` / `timeout` / `invalid-config`, or an
   *   AbortError when the caller cancelled.
   */
  async run(argv: readonly string[], ctx: GitRunContext): Promise<GitCommandResult> {
    // The cap and the deadline are resolved first: a bad setting is a
    // configuration bug, not a permission question.
    const cap = this.cap()
    const timeout = this.timeout()
    // Spawning a child is this application's use of the platform's `process`
    // capability: the door is the runtime's own binding, so an application the
    // user has not allowed to run processes never spawns one.
    return await ctx.capabilities.use('process', async () => await this.spawn(argv, ctx.signal, cap, timeout))
  }

  /** The one place a git child is spawned (the guarded half of {@link run}). */
  private async spawn(argv: readonly string[], callerSignal: AbortSignal, cap: number, timeoutMs: number): Promise<GitCommandResult> {
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([callerSignal, deadline])
    let timedOut = false
    let aborted = false
    deadline.addEventListener('abort', () => { timedOut = true }, { once: true })
    signal.addEventListener('abort', () => { aborted = true }, { once: true })
    if (signal.aborted) throw cancellationError()

    const startedAt = Date.now()
    let handle: SubprocessHandle
    try {
      handle = this.subprocess.spawn({
        argv: [this.gitBinary, ...argv],
        cwd: process.cwd(),
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: KILL_GRACE_MS,
        signal,
        env: { GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANG: 'C' },
      })
    } catch (error) {
      throw new AppError('git-missing', `git could not start ${this.gitBinary}: ${messageOf(error)}`)
    }

    const stdout = new ByteCap(cap)
    const stderr = new ByteCap(cap)
    handle.stdout?.on('data', (chunk: Buffer) => { stdout.push(chunk) })
    handle.stderr?.on('data', (chunk: Buffer) => { stderr.push(chunk) })

    let outcome: Awaited<SubprocessHandle['done']>
    try {
      outcome = await handle.done
    } catch (error) {
      if (!timedOut && !aborted) throw new AppError('git-missing', `git could not run: ${messageOf(error)}`)
      await handle.waitForExit(AbortSignal.timeout(CANCEL_WAIT_MS))
      if (timedOut) throw new AppError('timeout', `git exceeded its ${String(timeoutMs)} ms deadline`)
      throw cancellationError()
    }
    if (timedOut) {
      await handle.waitForExit(AbortSignal.timeout(CANCEL_WAIT_MS))
      throw new AppError('timeout', `git exceeded its ${String(timeoutMs)} ms deadline`)
    }
    if (aborted) {
      await handle.waitForExit(AbortSignal.timeout(CANCEL_WAIT_MS))
      throw cancellationError()
    }
    return {
      code: outcome.exitCode,
      signal: outcome.signal,
      stdout: stdout.text(),
      stderr: stderr.text(),
      truncated: stdout.truncated || stderr.truncated,
      durationMs: Date.now() - startedAt,
    }
  }

  /** The resolved deadline, validated once per run. */
  private timeout(): number {
    const timeout = this.timeoutMs
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new AppError('invalid-config', `git-browser timeoutMs must be a positive safe integer (got ${String(timeout)})`)
    }
    return timeout
  }

  /** The resolved cap, validated once per run (fail closed, never cap on a nonsense number). */
  private cap(): number {
    const cap = this.maxBytes
    if (!Number.isSafeInteger(cap) || cap < 0) {
      throw new AppError('invalid-config', `git-browser maxBytes must be a non-negative safe integer (got ${String(cap)})`)
    }
    return cap
  }
}
