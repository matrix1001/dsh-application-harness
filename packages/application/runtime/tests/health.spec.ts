/**
 * The platform's health-check rule book: the application declares a read-only
 * hook, the runtime runs it after start, after an import recovery and on the
 * user's explicit check, maps its result onto the public runtime/health/reason/
 * detail axis, and never lets a late or failed result overwrite newer state.
 *
 * The mapping is the contract: only an explicit `unhealthy` stops the instance
 * (activation is the user's and stays untouched); a timeout, a throw or an
 * invalid result is a diagnostic (degraded, no platform reason code); nothing
 * restarts on its own, and a stale maintenance/stop diagnostic is cleared by the
 * transition that supersedes it.
 */
import { describe, expect, it } from 'vitest'
import { ApplicationRuntime, assertDeclarable } from '../src/runtime.ts'
import type { AppDeclaration } from '../src/types.ts'
import type { AppHealthCheckResult } from '../src/types.ts'

function app(over: Partial<AppDeclaration> = {}): AppDeclaration {
  return {
    id: 'health',
    name: 'Health',
    description: 'health test',
    version: '1.0.0',
    ops: { echo: { description: 'echo', params: { text: { type: 'string', required: true } }, result: { type: 'string' }, execute: args => (args as { text: string }).text } },
    ...over,
  }
}

/** Wait until a probe holds (the scheduled check runs in a microtask/timer). */
async function until(probe: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!probe()) {
    if (Date.now() >= deadline) return
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
}

/** Let already-scheduled continuations run. */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

/** The runtime's rejection for an instance that is no longer available (stopped/stopping). */
const rejectedStopped = { status: 'rejected', error: { code: 'platform.stopping' } }

describe('health checks: start and mapping', () => {
  it('runs the hook after start and maps ok/degraded/ok onto health+detail', async () => {
    let calls = 0
    let result: AppHealthCheckResult = { status: 'ok' }
    const runtime = new ApplicationRuntime()
    const registration = await runtime.register(app({
      health: () => { calls += 1; return result },
    }))
    expect(calls).toBe(1)
    expect(registration.status()).toBe('available')
    expect(registration.health()).toBe('ok')
    expect(registration.reason()).toBeUndefined()
    expect(registration.detail()).toBeUndefined()

    result = { status: 'degraded', reason: 'the model is not configured' }
    await runtime.checkHealth('health')
    expect(calls).toBe(2)
    expect(registration.status()).toBe('available')
    expect(registration.health()).toBe('degraded')
    // The application's reason is the readable detail, NOT a platform reason code.
    expect(registration.reason()).toBeUndefined()
    expect(registration.detail()).toBe('the model is not configured')
    expect(await runtime.call({ kind: 'human' }, 'health', 'echo', { text: 'still callable' }))
      .toMatchObject({ status: 'success', result: 'still callable' })

    result = { status: 'ok' }
    await runtime.checkHealth('health')
    expect(registration.health()).toBe('ok')
    expect(registration.detail()).toBeUndefined()
  })

  it('waits for the start hook before checking, and never polls or runs per call', async () => {
    let calls = 0
    const start = Promise.withResolvers<void>()
    const runtime = new ApplicationRuntime()
    const registering = runtime.register(app({
      start: () => start.promise,
      health: () => { calls += 1; return { status: 'ok' } },
    }))
    await Promise.resolve()
    expect(calls).toBe(0)
    start.resolve()
    const registration = await registering
    expect(calls).toBe(1)
    await runtime.call({ kind: 'human' }, 'health', 'echo', { text: 'a' })
    await runtime.call({ kind: 'human' }, 'health', 'echo', { text: 'b' })
    await tick()
    expect(calls).toBe(1)
    expect(registration.status()).toBe('available')
  })

  it('refuses an explicit check when the instance is not available or is unknown', async () => {
    const runtime = new ApplicationRuntime()
    runtime.mount(app({ health: () => ({ status: 'ok' }) }), { activation: 'disabled' })
    await expect(runtime.checkHealth('health')).rejects.toThrow(/enable it/u)
    await expect(runtime.checkHealth('missing')).rejects.toThrow(/not registered/u)
    // A declaration without a hook has nothing to check and is a no-op.
    const plain = new ApplicationRuntime()
    const registration = await plain.register(app({ id: 'plain' }))
    await expect(plain.checkHealth('plain')).resolves.toBeUndefined()
    expect(registration.health()).toBe('ok')
  })

  it('refuses an explicit check while an import hold owns the instance', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(app({ pause: () => {}, resume: () => {}, health: () => ({ status: 'ok' }) }))
    await runtime.beginMaintenance('health')
    await expect(runtime.checkHealth('health')).rejects.toThrow(/held for an import/u)
    await runtime.endMaintenance('health')
    await expect(runtime.checkHealth('health')).resolves.toBeUndefined()
  })

  it('never runs the health hook for a start that failed', async () => {
    let checks = 0
    const runtime = new ApplicationRuntime()
    const registration = runtime.mount(app({
      start: () => { throw new Error('the storage is missing') },
      health: () => { checks += 1; return { status: 'ok' } },
    }))
    await until(() => registration.status() === 'failed')
    expect(checks).toBe(0)
    // The explicit enable retries the start (which fails again) and schedules a
    // check for a dead instance: the check must be a no-op, not a hook run.
    await runtime.setActivation('health', 'enabled')
    expect(checks).toBe(0)
    expect(registration.status()).toBe('failed')
    expect(registration.detail()).toBe('the storage is missing')
  })

  it('runs the check when an application is enabled again', async () => {
    let calls = 0
    const runtime = new ApplicationRuntime()
    const registration = runtime.mount(app({ health: () => { calls += 1; return { status: 'ok' } } }), { activation: 'disabled' })
    expect(calls).toBe(0)
    await runtime.setActivation('health', 'enabled')
    expect(calls).toBe(1)
    expect(registration.status()).toBe('available')
  })
})

describe('health checks: failures are diagnostics, not lifecycle', () => {
  it('reports a timeout as degraded diagnostic text with no platform reason code', async () => {
    let aborted = false
    const runtime = new ApplicationRuntime({ healthTimeoutMs: 20 })
    const registration = await runtime.register(app({
      health: (ctx) => new Promise<AppHealthCheckResult>(() => {
        ctx.signal.addEventListener('abort', () => { aborted = true }, { once: true })
      }),
    }))
    expect(aborted).toBe(true)
    expect(registration.status()).toBe('available')
    expect(registration.health()).toBe('degraded')
    expect(registration.reason()).toBeUndefined()
    expect(registration.detail()).toBe('health check timed out after 20ms')
    // A diagnostic does not block calls: the application is still available.
    expect(await runtime.call({ kind: 'human' }, 'health', 'echo', { text: 'still callable' }))
      .toMatchObject({ status: 'success', result: 'still callable' })
  })

  it('reports a thrown hook as degraded diagnostic text', async () => {
    const runtime = new ApplicationRuntime()
    const registration = await runtime.register(app({
      health: () => { throw new Error('the source probe failed') },
    }))
    expect(registration.status()).toBe('available')
    expect(registration.health()).toBe('degraded')
    expect(registration.reason()).toBeUndefined()
    expect(registration.detail()).toBe('health check failed: the source probe failed')
  })

  it('reports a thrown non-Error by its raw value and bounds a long detail', async () => {
    const raw = new ApplicationRuntime()
    const rawRegistration = await raw.register(app({
      health: () => { throw 'the probe vanished' },
    }))
    expect(rawRegistration.health()).toBe('degraded')
    expect(rawRegistration.detail()).toBe('health check failed: the probe vanished')

    const long = new ApplicationRuntime()
    const longRegistration = await long.register(app({
      health: () => { throw new Error('x'.repeat(400)) },
    }))
    const detail = longRegistration.detail() ?? ''
    expect(detail).toBe(`health check failed: ${'x'.repeat(300)}…`)
  })

  it('reports an invalid result as degraded diagnostic text', async () => {
    const values = [null, 'ok', { status: 'weird' }, { status: 'ok', reason: 7 }]
    for (const value of values) {
      const runtime = new ApplicationRuntime()
      const registration = await runtime.register(app({ health: () => value as never }))
      expect(registration.status()).toBe('available')
      expect(registration.health()).toBe('degraded')
      expect(registration.reason()).toBeUndefined()
      expect(registration.detail()).toBe('health check returned an invalid result')
    }
  })

  it('discards a result that settled after the instance was stopped', async () => {
    const gate = Promise.withResolvers<AppHealthCheckResult>()
    const runtime = new ApplicationRuntime()
    const registration = runtime.mount(app({ health: () => gate.promise }))
    await until(() => runtime.list()[0]?.status() === 'available')
    expect(await runtime.stop('health')).toBe('stopped')
    gate.resolve({ status: 'degraded', reason: 'stale report' })
    await tick()
    expect(registration.status()).toBe('stopped')
    expect(registration.health()).toBe('ok')
    expect(registration.detail()).toBeUndefined()
  })

  it('discards a previous instance’s result after a restart', async () => {
    const first = Promise.withResolvers<AppHealthCheckResult>()
    let calls = 0
    const runtime = new ApplicationRuntime()
    const registration = runtime.mount(app({
      health: () => {
        calls += 1
        return calls === 1 ? first.promise : { status: 'ok' }
      },
    }))
    await until(() => calls === 1)
    await runtime.stop('health')
    // An explicit enable restarts the stopped instance (activation stayed enabled).
    await runtime.setActivation('health', 'enabled')
    expect(calls).toBe(2)
    first.resolve({ status: 'degraded', reason: 'stale report' })
    await tick()
    expect(registration.status()).toBe('available')
    expect(registration.health()).toBe('ok')
    expect(registration.detail()).toBeUndefined()
  })

  it('joins an in-flight check instead of running the hook twice', async () => {
    const gate = Promise.withResolvers<AppHealthCheckResult>()
    let calls = 0
    const runtime = new ApplicationRuntime()
    const registering = runtime.register(app({ health: () => { calls += 1; return gate.promise } }))
    await until(() => calls === 1)
    const first = runtime.checkHealth('health')
    const second = runtime.checkHealth('health')
    gate.resolve({ status: 'ok' })
    await Promise.all([first, second, registering])
    expect(calls).toBe(1)
  })
})

describe('health checks: unhealthy', () => {
  it('stops the instance, keeps activation enabled and never restarts it by itself', async () => {
    let starts = 0
    let stops = 0
    let result: AppHealthCheckResult = { status: 'unhealthy', reason: 'git is missing' }
    const runtime = new ApplicationRuntime()
    const registration = await runtime.register(app({
      start: () => { starts += 1 },
      stop: () => { stops += 1 },
      health: () => result,
    }))
    expect(registration.status()).toBe('stopped')
    expect(registration.activation()).toBe('enabled')
    expect(registration.health()).toBe('degraded')
    expect(registration.reason()).toBe('platform.health-failed')
    expect(registration.detail()).toBe('git is missing')
    expect(stops).toBe(1)
    // A stopped instance is not callable and cannot be health-checked.
    expect(await runtime.call({ kind: 'human' }, 'health', 'echo', { text: 'x' })).toMatchObject(rejectedStopped)
    await expect(runtime.checkHealth('health')).rejects.toThrow(/enable it/u)
    // Nothing restarts it on its own.
    await tick()
    expect(starts).toBe(1)
    expect(registration.status()).toBe('stopped')
    // The user's explicit enable is the recovery (and the only restart).
    result = { status: 'ok' }
    await runtime.setActivation('health', 'enabled')
    expect(starts).toBe(2)
    expect(registration.status()).toBe('available')
    expect(registration.health()).toBe('ok')
    expect(registration.reason()).toBeUndefined()
    expect(registration.detail()).toBeUndefined()
  })

  it('clears the health-failed diagnostic when the user disables the stopped application', async () => {
    const runtime = new ApplicationRuntime()
    const registration = await runtime.register(app({
      health: () => ({ status: 'unhealthy', reason: 'required storage is broken' }),
    }))
    expect(registration.reason()).toBe('platform.health-failed')
    await runtime.setActivation('health', 'disabled')
    expect(registration.activation()).toBe('disabled')
    // An explicit disable ends the down-state's diagnostic; a fresh enable
    // starts from a clean health then reports again.
    expect(registration.health()).toBe('ok')
    expect(registration.reason()).toBeUndefined()
    expect(registration.detail()).toBeUndefined()
  })

  it('keeps stop-incomplete diagnostics when the unhealthy stop cannot finish', async () => {
    const runtime = new ApplicationRuntime({ stopBudgetMs: 10 })
    const registration = await runtime.register(app({
      start: () => { /* running, but the stop hook below hangs */ },
      stop: () => new Promise<void>(() => {}),
      health: () => ({ status: 'unhealthy', reason: 'required storage is broken' }),
    }))
    expect(registration.status()).toBe('stop-incomplete')
    expect(registration.health()).toBe('degraded')
    expect(registration.reason()).toBe('platform.stop-incomplete')
  })
})

describe('health checks: maintenance diagnostics', () => {
  it('reports updating during an import hold and re-checks on release', async () => {
    let result: AppHealthCheckResult = { status: 'ok' }
    const runtime = new ApplicationRuntime()
    const registration = await runtime.register(app({
      pause: () => {},
      resume: () => {},
      health: () => result,
    }))
    const lease = await runtime.beginMaintenance('health')
    expect(registration.health()).toBe('degraded')
    expect(registration.reason()).toBe('platform.updating')
    expect(registration.detail()).toBe('application data is being updated')
    result = { status: 'degraded', reason: 'the model is not configured' }
    await lease.release()
    expect(runtime.maintenance('health')).toBe(false)
    expect(registration.health()).toBe('degraded')
    expect(registration.reason()).toBeUndefined()
    expect(registration.detail()).toBe('the model is not configured')
  })

  it('clears a maintenance diagnostic when the hold fails or the application stops', async () => {
    const runtime = new ApplicationRuntime()
    const registration = await runtime.register(app({
      pause: () => { throw new Error('cannot pause') },
    }))
    await expect(runtime.beginMaintenance('health')).rejects.toThrow(/could not pause/u)
    expect(registration.health()).toBe('ok')
    expect(registration.reason()).toBeUndefined()
    expect(registration.detail()).toBeUndefined()

    // A stop that begins during an import hold clears it (and its diagnostics).
    const second = new ApplicationRuntime()
    const secondRegistration = await second.register(app({
      pause: () => {},
      health: () => ({ status: 'ok' }),
    }))
    await second.beginMaintenance('health')
    await second.stop('health')
    expect(secondRegistration.status()).toBe('stopped')
    expect(secondRegistration.health()).toBe('ok')
    expect(secondRegistration.reason()).toBeUndefined()
    expect(secondRegistration.detail()).toBeUndefined()
    expect(second.maintenance('health')).toBe(false)
  })

  it('discards a check interrupted by an import hold and runs a fresh one on release', async () => {
    const first = Promise.withResolvers<AppHealthCheckResult>()
    let calls = 0
    const runtime = new ApplicationRuntime()
    const registration = runtime.mount(app({
      pause: () => {},
      health: () => {
        calls += 1
        return calls === 1 ? first.promise : { status: 'ok' }
      },
    }))
    await until(() => calls === 1)
    const lease = await runtime.beginMaintenance('health')
    await lease.release()
    expect(calls).toBe(2)
    expect(registration.health()).toBe('ok')
    first.resolve({ status: 'degraded', reason: 'stale pre-import report' })
    await tick()
    expect(registration.status()).toBe('available')
    expect(registration.health()).toBe('ok')
    expect(registration.detail()).toBeUndefined()
  })

  it('skips the post-release check when a newer import hold owns the instance again', async () => {
    const resumeGate = Promise.withResolvers<void>()
    let resumes = 0
    const runtime = new ApplicationRuntime()
    await runtime.register(app({
      pause: () => {},
      resume: () => { resumes += 1; return resumeGate.promise },
      health: () => ({ status: 'ok' }),
    }))
    const first = await runtime.beginMaintenance('health')
    const released = first.release()
    // The release sets the hold clear and then awaits the resume hook; a NEW
    // hold placed while that hook is still running owns the instance again.
    await until(() => resumes === 1)
    const second = await runtime.beginMaintenance('health')
    expect(runtime.maintenance('health')).toBe(true)
    resumeGate.resolve()
    await released
    // The first release's recovery must not check an instance the new hold owns.
    expect(runtime.maintenance('health')).toBe(true)
    await second.release()
    expect(runtime.maintenance('health')).toBe(false)
  })

  it('re-checks when a failed import hold is released by endMaintenance', async () => {
    let calls = 0
    const runtime = new ApplicationRuntime()
    const registration = await runtime.register(app({
      pause: () => {},
      health: () => { calls += 1; return calls === 1 ? { status: 'ok' } : { status: 'degraded', reason: 're-read after import' } },
    }))
    expect(calls).toBe(1)
    await runtime.beginMaintenance('health')
    await runtime.endMaintenance('health')
    expect(calls).toBe(2)
    expect(registration.health()).toBe('degraded')
    expect(registration.detail()).toBe('re-read after import')
  })
})

describe('health checks: ownership races', () => {
  /** One synthetic record for the two ownership checks a settled hook runs through. */
  function raceRuntime(): { runtime: ApplicationRuntime; internals: {
    runHealthCheck(record: unknown, epoch: number): Promise<void>
    checkAfterRecovery(record: unknown): Promise<void>
  } } {
    const runtime = new ApplicationRuntime()
    const internals = runtime as unknown as {
      runHealthCheck(record: unknown, epoch: number): Promise<void>
      checkAfterRecovery(record: unknown): Promise<void>
    }
    return { runtime, internals }
  }

  it('forwards an already-aborted lifetime to the health hook', async () => {
    const { internals } = raceRuntime()
    const lifetime = new AbortController()
    lifetime.abort(new Error('the instance ended'))
    let seen: AbortSignal | undefined
    const record = {
      declaration: { id: 'health', health: (ctx: { signal: AbortSignal }) => { seen = ctx.signal; return { status: 'ok' } } },
      abort: lifetime,
      status: 'available',
      maintenance: undefined,
      healthEpoch: 1,
    }
    await internals.runHealthCheck(record, 1)
    expect(seen?.aborted).toBe(true)
  })

  it('discards a hook that settles after the instance stopped owning the check', async () => {
    const { internals } = raceRuntime()
    // The status reads: the guard at the entry, the first ownership check after
    // the wait, then the second one after the settled hook is awaited. The
    // synthetic record flips between the two checks — the race a stop or an
    // import hold wins, which no public sequence can schedule deterministically.
    let reads = 0
    const record = {
      declaration: { id: 'health', health: async () => ({ status: 'ok' as const }) },
      abort: new AbortController(),
      get status(): string { reads += 1; return reads <= 2 ? 'available' : 'stopped' },
      maintenance: undefined,
      healthEpoch: 1,
    }
    await internals.runHealthCheck(record, 1)
    expect(reads).toBe(3)
  })

  it('skips the post-recovery check while an import hold owns the instance', async () => {
    const { internals } = raceRuntime()
    let checks = 0
    const record = {
      declaration: { id: 'health', health: () => { checks += 1; return { status: 'ok' } } },
      maintenance: { token: 1 },
      status: 'available',
    }
    await internals.checkAfterRecovery(record)
    expect(checks).toBe(0)
  })
})

describe('health checks: declaration', () => {
  it('refuses a non-function health hook', () => {
    expect(() => assertDeclarable({ ...app(), health: 'nope' as never })).toThrow(/health must be a function/u)
  })
})
