/**
 * The runtime's edges: the paths a happy call never walks — a stop racing a
 * confirmation, a re-entrant stop, background identity, an unsubscribe, and
 * the Cordis face itself.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'
import { ApplicationRuntime } from '../src/runtime.ts'
import type { ConfirmationPort, GrantStorePort } from '../src/runtime.ts'
import { BoundedHistoryQueue } from '../src/history.ts'
import { apply, Config, mountApplication, name, opCapability, platformCapability } from '../src/index.ts'
import type { AppDeclaration, Caller, CallOutcome } from '../src/types.ts'

const asUser: Caller = { kind: 'human' }

/** An application whose echo operation answers with its argument. */
function app(id: string, over: Partial<AppDeclaration> = {}): AppDeclaration {
  return {
    id,
    name: id,
    description: `${id} app`,
    version: '1.0.0',
    ops: {
      echo: {
        description: 'returns its argument',
        params: { text: { type: 'string', required: true } },
        result: { type: 'string' },
        execute: (args) => (args as { text: string }).text,
      },
    },
    ...over,
  }
}

/** Poll until `probe` holds: a late lifecycle path settles a few turns after the work ends. */
async function until(probe: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!probe()) {
    if (Date.now() >= deadline) return
    await new Promise((resolve) => { setTimeout(resolve, 2) })
  }
}

describe('reload after an external data write', () => {
  it('runs the available application hook, is a no-op without one, and refuses an unavailable app', async () => {
    const runtime = new ApplicationRuntime()
    let reloads = 0
    await runtime.register(app('reloadable', { reload: () => { reloads += 1 } }))
    await runtime.reload('reloadable')
    expect(reloads).toBe(1)

    await runtime.register(app('plain'))
    await expect(runtime.reload('plain')).resolves.toBeUndefined()

    await expect(runtime.reload('missing')).rejects.toThrow(/not registered/)
    await runtime.stop('reloadable')
    await expect(runtime.reload('reloadable')).rejects.toThrow(/not available/)
  })
})

describe('stop re-entry and late health', () => {
  it('does not run the stop hook twice while the first hook is still in flight', async () => {
    const runtime = new ApplicationRuntime({ stopBudgetMs: 10 })
    let hooks = 0
    let release: (() => void) | undefined
    await runtime.register(app('slow-stop', {
      stop: async () => { hooks += 1; await new Promise<void>((resolve) => { release = resolve }) },
    }))
    const first = await runtime.stop('slow-stop')
    expect(first).toBe('stop-incomplete')
    const second = await runtime.stop('slow-stop')
    expect(second).toBe('stop-incomplete')
    expect(hooks).toBe(1)
    release?.()
    await until(() => runtime.list()[0]?.status() === 'stopped')
    expect(runtime.list()[0]?.status()).toBe('stopped')
  })

  it('uses a readable fallback when an unhealthy report carries no reason', async () => {
    const runtime = new ApplicationRuntime()
    const registration = await runtime.register(app('health-no-reason', { health: async () => ({ status: 'unhealthy' }) }))
    expect(registration.status()).toBe('stopped')
    expect(registration.reason()).toBe('platform.health-failed')
    expect(registration.detail()).toBe('the application reported unhealthy')
  })

  it('keeps the health-failed diagnosis when the stop finishes late', async () => {
    const runtime = new ApplicationRuntime({ stopBudgetMs: 10 })
    let release: (() => void) | undefined
    let healthy = true
    const registration = await runtime.register(app('health-late', {
      health: async () => healthy ? { status: 'ok' } : { status: 'unhealthy', reason: 'db gone' },
      ops: {
        echo: {
          description: 'waits',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: async () => { await new Promise<void>((resolve) => { release = resolve }); return 'ok' },
        },
      },
    }))
    const call = runtime.call(asUser, 'health-late', 'echo', { text: 'x' })
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    healthy = false
    await runtime.checkHealth('health-late')
    expect(registration.status()).toBe('stop-incomplete')
    release?.()
    await call
    await until(() => registration.status() === 'stopped')
    expect(registration.status()).toBe('stopped')
    expect(registration.health()).toBe('degraded')
    expect(registration.reason()).toBe('platform.health-failed')
    expect(registration.detail()).toBe('db gone')
  })
})

describe('service face', () => {
  it('provides ctx.applications, honouring the row config', async () => {
    const ctx = new Context()
    expect(name).toBe('application-runtime')
    expect(Config({})).toBeTruthy()
    apply(ctx, {})
    const runtime = ctx.applications
    expect(runtime).toBeInstanceOf(ApplicationRuntime)
    await runtime!.register(app('one'))
    expect(runtime!.list().map((entry) => entry.declaration.id)).toEqual(['one'])
    expect(runtime!.list()[0]?.status()).toBe('available')
    expect(runtime!.list()[0]?.detail()).toBeUndefined()

    const broken = new Context()
    apply(broken, {})
    await broken.applications!.register(app('broken', { start: () => { throw new Error('no storage') } }))
    expect(broken.applications!.list()[0]?.status()).toBe('failed')
    expect(broken.applications!.list()[0]?.detail()).toBe('no storage')

    // The row mounts the bounded in-memory history window (the D5 defect: the
    // runtime alone keeps none, and nothing else installed one, so every read
    // of recent history answered empty).
    await runtime!.call(asUser, 'one', 'echo', { text: 'x' })
    expect(runtime!.recentHistory().map((entry) => entry.op)).toEqual(['echo'])

    const configured = new Context()
    apply(configured, { stopBudgetMs: 1 })
    expect(configured.applications).toBeInstanceOf(ApplicationRuntime)

    // The row's health timeout is the runtime's own: a hook that outlives it is
    // a bounded diagnostic, not an endless start.
    const healthConfigured = new Context()
    apply(healthConfigured, { healthTimeoutMs: 5 })
    const slowHealth = await healthConfigured.applications!.register(app('slow-health', {
      health: () => new Promise(() => {}),
    }))
    expect(slowHealth.detail()).toBe('health check timed out after 5ms')
  })

  it('routes runtime problems to the context logger', async () => {
    const ctx = new Context()
    const warned: string[] = []
    ctx.logger.warn = ((...args: unknown[]) => { warned.push(args.map(String).join(' ')) }) as typeof ctx.logger.warn
    apply(ctx, {})
    const runtime = ctx.applications!
    runtime.useHistory({ write: () => { throw new Error('sink broke') } })
    await runtime.register(app('one'))
    await runtime.call(asUser, 'one', 'echo', { text: 'x' })
    expect(warned.join(' ')).toContain('sink broke')
    // A problem with a detail prints both parts.
    runtime.useHistory({ write: () => { throw new Error('again') } })
    await runtime.call(asUser, 'one', 'echo', { text: 'x' })
    expect(warned.join(' ')).toContain('again')
  })

  it('accepts the declared unified namespace and refuses another one', async () => {
    const ctx = new Context()
    apply(ctx, {})
    ctx.provide('applicationStore', { openForMount: () => ({ attach: () => {} }) } as never)
    const declaration = (store: (namespace: string) => unknown): AppDeclaration => {
      store('one')
      return app('one', { data: { kind: 'unified', namespace: 'one', schemaVersion: 1 } })
    }
    await expect(mountApplication(ctx, declaration)).resolves.toBeDefined()
    await expect(mountApplication(ctx, (store: (namespace: string) => unknown) => {
      store('one')
      return app('two', { data: { kind: 'unified', namespace: 'two', schemaVersion: 1 } })
    })).rejects.toThrow(/only its own declared unified namespace/u)
    await expect(mountApplication(ctx, (store: (namespace: string) => unknown) => {
      store('plain')
      return app('plain')
    })).rejects.toThrow(/only its own declared unified namespace/u)
  })

  it('mounts an application as a row and allows loading it again after the row unloads', async () => {
    const ctx = new Context()
    apply(ctx, {})
    const runtime = ctx.applications!
    const row = (): Plugin => ({
      name: 'row',
      apply: async (scope: Context) => { await mountApplication(scope, app('workbook')) },
    })
    const first = ctx.plugin(row())
    await first
    expect(runtime.list().map((entry) => entry.declaration.id)).toEqual(['workbook'])
    await first.dispose()
    // The unload stopped the application AND dropped its registration. Without
    // that, loading the row again answers `already registered` (the defect this
    // covers) — or would alias whatever the old instance left running.
    expect(runtime.list()).toEqual([])
    const second = ctx.plugin(row())
    await second
    expect(runtime.list().map((entry) => entry.declaration.id)).toEqual(['workbook'])
    await second.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps a registration whose work outlives the unload, and drops it when the work ends', async () => {
    const ctx = new Context()
    apply(ctx, { stopBudgetMs: 10 })
    const runtime = ctx.applications!
    let finish: (() => void) | undefined
    const busy: AppDeclaration = {
      ...app('busy'),
      ops: {
        echo: {
          description: 'never ends until released',
          params: { text: { type: 'string', required: true } },
          result: { type: 'string' },
          execute: async () => { await new Promise<void>((resolve) => { finish = resolve }); return 'late' },
        },
      },
    }
    const warned: string[] = []
    ctx.logger.warn = ((...args: unknown[]) => { warned.push(args.map(String).join(' ')) }) as typeof ctx.logger.warn
    const handle = ctx.plugin({
      name: 'busy-row',
      apply: async (scope: Context) => { await mountApplication(scope, busy) },
    } satisfies Plugin)
    await handle
    const work = runtime.call(asUser, 'busy', 'echo', { text: 'x' })
    await handle.dispose()
    // The work is still running: the registration stays (a second load of the
    // same id is refused rather than aliasing a live instance), and the row
    // says so.
    expect(runtime.list().map((entry) => entry.declaration.id)).toEqual(['busy'])
    expect(warned.join(' ')).toContain('busy')
    await expect(runtime.register(app('busy'))).rejects.toThrow(/already registered/u)
    finish?.()
    await work
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(runtime.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('cancels and releases an application whose row unloads while it is still starting', async () => {
    const ctx = new Context()
    apply(ctx, { stopBudgetMs: 5 })
    const runtime = ctx.applications!
    const warned: string[] = []
    ctx.logger.warn = ((...args: unknown[]) => { warned.push(args.map(String).join(' ')) }) as typeof ctx.logger.warn
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let signal: AbortSignal | undefined
    const declaration = app('slow-start', {
      start: (hooks) => { signal = hooks.signal; entered.resolve(); return release.promise },
    })
    const row = ctx.plugin({
      name: 'slow-row',
      apply: async (scope: Context) => { await mountApplication(scope, declaration) },
    } satisfies Plugin)
    // The row is loaded while its application is still starting: the row's load
    // is not the application's start.
    await row
    await entered.promise
    expect(runtime.list().map((entry) => entry.status())).toEqual(['starting'])

    await row.dispose()
    // The unload reached the start: it was cancelled, the stop budget ran out
    // with the start still running (reported, never called "stopped"), and the
    // registration stays — a second load of this id must be refused rather than
    // alias an instance that may still be starting.
    expect(signal?.aborted).toBe(true)
    expect(runtime.list().map((entry) => entry.status())).toEqual(['stop-incomplete'])
    expect(warned.join(' ')).toContain('slow-start')
    await expect(runtime.register(declaration)).rejects.toThrow(/already registered/u)

    // The late start result never reopens it; when the work really ends the
    // registration is dropped, so the id can be loaded again.
    release.resolve()
    await until(() => runtime.list().length === 0)
    const again = ctx.plugin({
      name: 'slow-row',
      apply: async (scope: Context) => { await mountApplication(scope, app('slow-start')) },
    } satisfies Plugin)
    await again
    expect(runtime.list().map((entry) => entry.declaration.id)).toEqual(['slow-start'])
    await again.dispose()
    await ctx.fiber.dispose()
  })

  it('reports a start that fails after its row unloaded without reopening the application', async () => {
    const ctx = new Context()
    apply(ctx, { stopBudgetMs: 5 })
    const runtime = ctx.applications!
    const warned: string[] = []
    ctx.logger.warn = ((...args: unknown[]) => { warned.push(args.map(String).join(' ')) }) as typeof ctx.logger.warn
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const row = ctx.plugin({
      name: 'failing-row',
      apply: async (scope: Context) => {
        await mountApplication(scope, app('late-fail', {
          start: async () => { entered.resolve(); await release.promise; throw new Error('no storage') },
        }))
      },
    } satisfies Plugin)
    await row
    await entered.promise
    await row.dispose()
    // The failure lands after the stop took over: it is reported, never written
    // over the lifecycle — the application stays stopped for callers.
    release.resolve()
    await until(() => warned.some((line) => line.includes('start failed after its stop began')))
    expect(warned.join(' ')).toContain('no storage')
    expect(runtime.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('never releases an instance of an id the failed row never mounted', async () => {
    const ctx = new Context()
    apply(ctx, {})
    const runtime = ctx.applications!
    const errors: string[] = []
    ctx.logger.error = ((...args: unknown[]) => { errors.push(args.map(String).join(' ')) }) as typeof ctx.logger.error
    const load = (label: string): Plugin => ({
      name: label,
      apply: async (scope: Context) => { await mountApplication(scope, app('same')) },
    })
    const first = ctx.plugin(load('first'))
    await first
    // A second row for the same id cannot mount: its registration never
    // happened, so its unload must not stop, nor unregister, the instance the
    // first row owns.
    const second = ctx.plugin(load('second'))
    expect(await second.then(() => undefined, (error: Error) => error.message)).toContain('already registered')
    expect(errors.join(' ')).toContain('already registered')
    await second.dispose()
    expect(runtime.list().map((entry) => entry.status())).toEqual(['available'])
    await first.dispose()
    expect(runtime.list()).toEqual([])
    await ctx.fiber.dispose()
  })
})

describe('background identity', () => {
  it('applies the peer rules to a background caller exactly as to the application', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register({ ...app('target'), ops: { echo: { ...app('target').ops.echo!, exposure: { peers: 'confirm' } } } })
    await runtime.register(app('closed-target'))
    let toTarget: CallOutcome | undefined
    let toClosed: CallOutcome | undefined
    await runtime.register({
      ...app('owner'),
      calls: ['target', 'closed-target'],
      start: (ctx) => {
        // Background work is a task; the grant is installed just after the
        // start, so the task waits for it before calling.
        ctx.startTask({ kind: 'peer-call', title: 'probe peers' }, async (taskCtx) => {
          await new Promise((resolve) => { setTimeout(resolve, 10) })
          toTarget = await taskCtx.call('target', 'echo', { text: 'bg' })
          toClosed = await taskCtx.call('closed-target', 'echo', { text: 'bg' })
        })
      },
    })
    await runtime.setPolicy('target', 'echo', 'allow')
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    // The declared+granted target answers; the undeclared one is refused.
    expect(toTarget).toMatchObject({ status: 'success', result: 'bg' })
    expect(toClosed).toMatchObject({ status: 'rejected' })
    expect(await runtime.stop('owner')).toBe('stopped')
  })

  it('applies the operation policy to applications and their background work', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register({ ...app('target'), ops: { echo: { ...app('target').ops.echo!, exposure: { peers: 'confirm' } } } })
    await runtime.register({ ...app('owner'), calls: ['target'] })
    const background: Caller = { kind: 'background', appId: 'owner' }
    expect(await runtime.call(background, 'target', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })
    await runtime.setPolicy('target', 'echo', 'allow')
    expect(await runtime.call(background, 'target', 'echo', { text: 'x' })).toMatchObject({ status: 'success' })
    expect(await runtime.call({ kind: 'app', appId: 'owner' }, 'target', 'echo', { text: 'x' })).toMatchObject({ status: 'success' })
    // The policy is per operation, not per caller: forbid blocks every caller.
    await runtime.setPolicy('target', 'echo', 'forbid')
    expect(await runtime.call(background, 'target', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })
    expect(await runtime.call({ kind: 'app', appId: 'owner' }, 'target', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })
  })

  it('asks the user for a peer call that requires confirmation, and honours a refusal', async () => {
    let answer: 'allowed-once' | 'denied' = 'allowed-once'
    const asked: string[] = []
    const port: ConfirmationPort = {
      ask: (request) => { asked.push(request.capability); return Promise.resolve(answer) },
    }
    const runtime = new ApplicationRuntime()
    runtime.useConfirmation(port)
    await runtime.register({
      ...app('target'),
      ops: { echo: { ...app('target').ops.echo!, exposure: { peers: 'confirm' } } },
    })
    await runtime.register({ ...app('owner'), calls: ['target'] })
    expect(await runtime.call({ kind: 'app', appId: 'owner' }, 'target', 'echo', { text: 'x' })).toMatchObject({ status: 'success' })
    answer = 'denied'
    expect(await runtime.call({ kind: 'app', appId: 'owner' }, 'target', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })
    expect(asked).toEqual(['target#echo', 'target#echo'])
  })

  it('a call waiting on confirmation is refused when the application stops meanwhile', async () => {
    let release: (() => void) | undefined
    let asked: (() => void) | undefined
    const askedOnce = new Promise<void>((resolve) => { asked = resolve })
    const port: ConfirmationPort = {
      ask: () => {
        asked?.()
        return new Promise((resolve) => { release = () => { resolve('allowed-once') } })
      },
    }
    const runtime = new ApplicationRuntime()
    runtime.useConfirmation(port)
    await runtime.register({
      ...app('target'),
      ops: { echo: { ...app('target').ops.echo!, exposure: { peers: 'confirm' } } },
    })
    await runtime.register({ ...app('owner'), calls: ['target'] })
    const pending = runtime.call({ kind: 'app', appId: 'owner' }, 'target', 'echo', { text: 'x' })
    await askedOnce
    const stopping = runtime.stop('target')
    release?.()
    // The stop ends the pending request: the late "allow" is an answer to a
    // decision that is over, and the operation does not run.
    expect(await pending).toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })
    expect(await stopping).toBe('stopped')
  })

  it('re-checks a policy changed while the confirmation was open', async () => {
    const runtime = new ApplicationRuntime()
    runtime.useConfirmation({
      ask: async () => {
        await runtime.setPolicy('target', 'echo', 'forbid')
        return 'allowed-once'
      },
    })
    await runtime.register({
      ...app('target'),
      ops: { echo: { ...app('target').ops.echo!, exposure: { peers: 'confirm' } } },
    })
    await runtime.register({ ...app('owner'), calls: ['target'] })
    await expect(runtime.call({ kind: 'app', appId: 'owner' }, 'target', 'echo', { text: 'x' }))
      .resolves.toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })
  })

  it('drops a confirmation whose caller cancels while it waits', async () => {
    const controller = new AbortController()
    let asked: (() => void) | undefined
    const askedOnce = new Promise<void>((resolve) => { asked = resolve })
    const port: ConfirmationPort = {
      ask: (request) => new Promise((resolve) => {
        asked?.()
        if (request.signal.aborted) { resolve('cancelled'); return }
        request.signal.addEventListener('abort', () => { resolve('cancelled') }, { once: true })
      }),
    }
    const runtime = new ApplicationRuntime()
    runtime.useConfirmation(port)
    await runtime.register({
      ...app('target'),
      ops: { echo: { ...app('target').ops.echo!, exposure: { peers: 'confirm' } } },
    })
    await runtime.register({ ...app('owner'), calls: ['target'] })
    const pending = runtime.call({ kind: 'app', appId: 'owner' }, 'target', 'echo', { text: 'x' }, controller.signal)
    await askedOnce
    controller.abort()
    expect(await pending).toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })
  })
})

describe('stops, unsubscribes and grants', () => {
  it('answers a second stop with the first stop’s result', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(app('one'))
    const first = runtime.stop('one')
    const second = runtime.stop('one')
    expect(await first).toBe(await second)
  })

  it('stops a listener that unsubscribed from change notices', async () => {
    const runtime = new ApplicationRuntime()
    const seen: string[] = []
    const dispose = runtime.onChange((notice) => { seen.push(notice.appId) })
    dispose()
    await runtime.register({
      ...app('writer'),
      start: (ctx) => { ctx.notifyChanged() },
    })
    expect(seen).toEqual([])
  })

  it('still delivers a stop hook\'s change notice while stopping', async () => {
    const runtime = new ApplicationRuntime()
    const seen: string[] = []
    runtime.onChange((notice) => { seen.push(notice.appId) })
    await runtime.register(app('one', {
      stop: (ctx) => { ctx.notifyChanged() },
    }))
    expect(await runtime.stop('one')).toBe('stopped')
    expect(seen).toEqual(['one'])
  })

  it('revokes a platform capability by exact name', async () => {
    const runtime = new ApplicationRuntime()
    const caller: Caller = { kind: 'app', appId: 'owner' }
    await runtime.grant({ caller, capabilities: ['capability:model'], grantedAt: '2026-01-01T00:00:00.000Z' })
    expect(await runtime.grantsOf()).toHaveLength(1)
    await runtime.revoke(caller, 'capability:model')
    expect(await runtime.grantsOf()).toEqual([])
  })

  it('treats a cancel that arrived before the confirmation as an answer never given', async () => {
    const controller = new AbortController()
    controller.abort()
    let asked = false
    const port: ConfirmationPort = { ask: () => { asked = true; return Promise.resolve('allowed-once') } }
    const runtime = new ApplicationRuntime()
    runtime.useConfirmation(port)
    await runtime.register({
      ...app('target'),
      ops: { echo: { ...app('target').ops.echo!, exposure: { peers: 'confirm' } } },
    })
    await runtime.register({ ...app('owner'), calls: ['target'] })
    expect(await runtime.call({ kind: 'app', appId: 'owner' }, 'target', 'echo', { text: 'x' }, controller.signal))
      .toMatchObject({ status: 'cancelled', error: { code: 'platform.cancelled' } })
    expect(asked).toBe(false)
  })

  it('tracks background work started by an operation, and awaits it at stop', async () => {
    const runtime = new ApplicationRuntime()
    let ran = false
    await runtime.register({
      ...app('one'),
      ops: {
        echo: {
          ...app('one').ops.echo!,
          execute: (args, ctx) => {
            ctx.startTask({ kind: 'test', title: 'operation background' }, async () => { await new Promise((resolve) => { setTimeout(resolve, 5) }); ran = true })
            return (args as { text: string }).text
          },
        },
      },
    })
    expect(await runtime.call(asUser, 'one', 'echo', { text: 'x' })).toMatchObject({ status: 'success' })
    expect(await runtime.stop('one')).toBe('stopped')
    expect(ran).toBe(true)
  })

  it('persists a revoke through the grant store, and keeps the capabilities not named', async () => {
    const saved: string[][] = []
    const store: GrantStorePort = {
      list: () => Promise.resolve([]),
      save: (grants) => { saved.push(grants.flatMap((grant) => grant.capabilities)); return Promise.resolve() },
    }
    const runtime = new ApplicationRuntime()
    runtime.useGrantStore(store)
    const caller: Caller = { kind: 'app', appId: 'owner' }
    await runtime.grant({ caller, capabilities: ['capability:model', 'capability:network'], grantedAt: '2026-01-01T00:00:00.000Z' })
    await runtime.revoke(caller, 'capability:model')
    expect(await runtime.grantsOf()).toMatchObject([{ capabilities: ['capability:network'] }])
    await runtime.revoke(caller, 'capability:network')
    expect(await runtime.grantsOf()).toEqual([])
    expect(saved).toEqual([['capability:model', 'capability:network'], ['capability:network'], []])
  })
})

describe('best-effort paths report without changing the outcome', () => {
  it('reports every problem even when the thrown value is not an Error', async () => {
    const problems: string[] = []
    const runtime = new ApplicationRuntime({ onProblem: (problem) => { problems.push(problem) } })
    runtime.useHistory({ write: () => { throw 'plain failure' } })
    runtime.useConfirmation({ ask: () => { throw 'channel string' } })
    runtime.onProgress(() => { throw 'progress string' })
    runtime.onChange(() => { throw 'listener string' })
    await runtime.register(app('broken', { start: () => { throw 'start string' } }))
    await runtime.register(app('one', {
      stop: () => { throw 'stop string' },
      ops: {
        echo: {
          ...app('one').ops.echo!,
          exposure: { ai: 'confirm' },
          execute: (_args, ctx) => {
            ctx.startTask({ kind: 'test', title: 'operation background' }, async () => { throw 'background string' })
            ctx.reportProgress('working')
            ctx.notifyChanged()
            throw 'operation string'
          },
        },
      },
    }))
    expect(await runtime.call({ kind: 'ai' }, 'one', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })
    expect(await runtime.call(asUser, 'one', 'echo', { text: 'x' })).toMatchObject({ status: 'failed', error: { code: 'platform.execution-failed', message: 'operation string' }})
    // The hook threw a bare string: the failure is still reported as a failed
    // cleanup, never as a stop that succeeded.
    expect(await runtime.stop('one')).toBe('stop-incomplete')
    expect(problems.join(' | ')).toContain('plain failure')
    expect(problems.join(' | ')).toContain('channel string')
    expect(problems.join(' | ')).toContain('progress string')
    expect(problems.join(' | ')).toContain('listener string')
    expect(problems.join(' | ')).toContain('stop string')
    // A start failure is not a "problem": it is the application's own state,
    // visible through the registration.
    const broken = runtime.list().find((entry) => entry.declaration.id === 'broken')
    expect(broken?.status()).toBe('failed')
    expect(broken?.detail()).toBe('start string')

    const asyncHistory = new ApplicationRuntime({ onProblem: (problem) => { problems.push(problem) } })
    asyncHistory.useHistory({ write: () => Promise.reject('async plain failure') })
    await asyncHistory.register(app('one'))
    await asyncHistory.call(asUser, 'one', 'echo', { text: 'x' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(problems.join(' | ')).toContain('async plain failure')

    const storeRuntime = new ApplicationRuntime()
    storeRuntime.useGrantStore({ list: () => Promise.resolve([]), save: () => Promise.reject('save string') })
    await expect(storeRuntime.grant({ caller: { kind: 'app', appId: 'owner' }, capabilities: ['capability:model'], grantedAt: '' })).rejects.toBe('save string')
  })

  it('stays silent when a history write fails and no reporter is installed', async () => {
    // No reporter installed: a problem is still swallowed (never thrown at a
    // caller) — the runtime survives reporting failures too.
    const quiet = new ApplicationRuntime()
    quiet.useHistory({ write: () => { throw new Error('ignored') } })
    await quiet.register(app('one'))
    expect(await quiet.call(asUser, 'one', 'echo', { text: 'x' })).toMatchObject({ status: 'success' })

    // The bounded queue's own defaults behave the same way.
    const queue = new BoundedHistoryQueue({ append: () => Promise.reject('store string') })
    queue.write({ callId: 'a', caller: asUser, target: 't', op: 'o', startedAt: '', endedAt: '', status: 'success' })
    await queue.flush()
  })

  it('hydrates only the newest window without re-writing the loaded records', async () => {
    const appended: unknown[] = []
    const queue = new BoundedHistoryQueue({ append: async (records) => { appended.push(...records) } }, { capacity: 2 })
    const record = (callId: string) => ({ callId, caller: asUser, target: 't', op: 'o', startedAt: '', endedAt: '', status: 'success' as const })
    queue.hydrate([record('a'), record('b'), record('c')])
    expect(queue.recent().map(item => item.callId)).toEqual(['c', 'b'])
    await queue.flush()
    expect(appended).toEqual([])
  })

  it('answers unavailable while an application is still starting', async () => {
    const runtime = new ApplicationRuntime()
    let release: (() => void) | undefined
    const registering = runtime.register(app('starting', { start: () => new Promise<void>((resolve) => { release = resolve }) }))
    expect(await runtime.call(asUser, 'starting', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.unavailable' } })
    release?.()
    await registering
    expect(await runtime.call(asUser, 'starting', 'echo', { text: 'x' })).toMatchObject({ status: 'success' })
  })

  it('cancels in-flight work when the application stops', async () => {
    const runtime = new ApplicationRuntime({ stopBudgetMs: 200 })
    let sawAbort = false
    await runtime.register(app('one', {
      ops: {
        echo: {
          ...app('one').ops.echo!,
          execute: async (args, ctx) => {
            // Poll rather than listen: the request can arrive before this
            // operation starts (the stop began while the call was checked).
            while (!ctx.signal.aborted) await new Promise((resolve) => { setTimeout(resolve, 1) })
            sawAbort = true
            return (args as { text: string }).text
          },
        },
      },
    }))
    const call = runtime.call(asUser, 'one', 'echo', { text: 'x' })
    expect(await runtime.stop('one')).toBe('stopped')
    expect(await call).toMatchObject({ status: 'success' })
    expect(sawAbort).toBe(true)
  })

  it('leaves a grant for another target alone when revoking', async () => {
    const runtime = new ApplicationRuntime()
    const caller: Caller = { kind: 'app', appId: 'owner' }
    await runtime.grant({ caller, capabilities: ['capability:model'], grantedAt: '' })
    await runtime.grant({ caller, capabilities: ['capability:network'], grantedAt: '' })
    await runtime.revoke(caller, 'capability:model')
    expect(await runtime.grantsOf()).toMatchObject([{ capabilities: ['capability:network'] }])
  })
})

describe('platform capability entry', () => {
  it('answers undeclared, not-approved and allow, and revokes the capability by name', async () => {
    const runtime = new ApplicationRuntime()
    const owner: Caller = { kind: 'app', appId: 'owner' }
    const background: Caller = { kind: 'background', appId: 'owner' }
    await runtime.register({ ...app('owner'), capabilities: ['model'] })
    await runtime.register(app('plain'))

    expect(opCapability('target', 'echo')).toBe('target#echo')
    expect(platformCapability('model')).toBe('capability:model')
    // Not an application identity at all.
    expect(await runtime.checkCapability(asUser, 'model')).toBe('undeclared')
    // An application that never declared it.
    expect(await runtime.checkCapability({ kind: 'app', appId: 'plain' }, 'model')).toBe('undeclared')
    expect(await runtime.checkCapability({ kind: 'app', appId: 'ghost' }, 'model')).toBe('undeclared')
    // Declared, not approved yet — and the same for background work.
    expect(await runtime.checkCapability(owner, 'model')).toBe('not-approved')
    expect(await runtime.checkCapability(background, 'model')).toBe('not-approved')
    await runtime.grant({ caller: owner, capabilities: [platformCapability('model')], grantedAt: '2026-01-01T00:00:00.000Z' })
    expect(await runtime.checkCapability(owner, 'model')).toBe('allow')
    // The application and its background work are one principal: one approval
    // covers the capability wherever the application uses it.
    expect(await runtime.checkCapability(background, 'model')).toBe('allow')
    // Revoking one capability by name takes the approval away again.
    await runtime.revoke(owner, platformCapability('model'))
    expect(await runtime.checkCapability(owner, 'model')).toBe('not-approved')
  })

  it('revokes everything a caller was granted, leaving other callers untouched', async () => {
    const runtime = new ApplicationRuntime()
    const owner: Caller = { kind: 'app', appId: 'owner' }
    const other: Caller = { kind: 'app', appId: 'other' }
    await runtime.grant({ caller: owner, capabilities: [platformCapability('model')], grantedAt: '' })
    await runtime.grant({ caller: other, capabilities: [platformCapability('model')], grantedAt: '' })
    await runtime.revoke(owner)
    expect(await runtime.grantsOf()).toMatchObject([{ caller: other, capabilities: [platformCapability('model')] }])
  })
})

describe('capability use (the entry-side check)', () => {
  /** An application whose `use` operation reaches the model through its capability face. */
  function modelApp(id: string, over: Partial<AppDeclaration> = {}): AppDeclaration {
    return {
      id,
      name: id,
      description: `${id} app`,
      version: '1.0.0',
      capabilities: ['model'],
      ops: {
        use: {
          description: 'uses the declared capability',
          params: {},
          result: { type: 'string' },
          execute: async (_args, ctx) => await ctx.capabilities.use('model', () => { used += 1; return 'answer' }),
        },
      },
      ...over,
    }
  }
  let used = 0

  it('refuses a declared-but-unapproved use, and the panel’s own grant makes it work', async () => {
    used = 0
    const runtime = new ApplicationRuntime()
    await runtime.register(modelApp('analyst'))
    // The approval is the USER's, given in the applications panel — a use never
    // asks for itself, so an unapproved capability simply does not run.
    expect(await runtime.call(asUser, 'analyst', 'use', {})).toMatchObject({ status: 'failed', error: { code: 'app.capability-not-approved' } })
    expect(used).toBe(0)
    expect(await runtime.grantsOf()).toEqual([])

    // The panel's grant is exactly this record; the very same call works after.
    await runtime.grant({ caller: { kind: 'app', appId: 'analyst' }, capabilities: [platformCapability('model')], grantedAt: '2026-01-01T00:00:00.000Z' })
    expect(await runtime.call(asUser, 'analyst', 'use', {})).toMatchObject({ status: 'success', result: 'answer' })
    expect(used).toBe(1)

    // A revoke takes it away: the next use is refused before the capability is
    // touched, and no confirmation channel is consulted at any point.
    const asked: string[] = []
    runtime.useConfirmation({ ask: (request) => { asked.push(request.capability); return Promise.resolve('allowed-once') } })
    await runtime.revoke({ kind: 'app', appId: 'analyst' }, platformCapability('model'))
    expect(await runtime.call(asUser, 'analyst', 'use', {})).toMatchObject({ status: 'failed', error: { code: 'app.capability-not-approved' } })
    expect(used).toBe(1)
    expect(asked).toEqual([])
  })

  it('refuses a use of a capability the application never declared, without asking anyone', async () => {
    used = 0
    const asked: string[] = []
    const runtime = new ApplicationRuntime()
    runtime.useConfirmation({ ask: (request) => { asked.push(request.capability); return Promise.resolve('allowed-once') } })
    await runtime.register({
      ...modelApp('undeclared'),
      capabilities: [],
    })
    expect(await runtime.call(asUser, 'undeclared', 'use', {})).toMatchObject({ status: 'failed', error: { code: 'app.capability-undeclared' } })
    expect(used).toBe(0)
    expect(asked).toEqual([])
    // No grant exists for an undeclared capability, and the use still refuses.
    expect(await runtime.call(asUser, 'undeclared', 'use', {})).toMatchObject({ status: 'failed', error: { code: 'app.capability-undeclared' } })
    expect(used).toBe(0)
  })

  it('binds the face to the application: a caller’s capability grant never travels with the call', async () => {
    used = 0
    const asked: string[] = []
    const runtime = new ApplicationRuntime()
    runtime.useConfirmation({ ask: (request) => { asked.push(request.capability); return Promise.resolve('allowed-once') } })
    // The peer application declares the model capability; the caller does not.
    await runtime.register(modelApp('peer', {
      ops: {
        use: {
          description: 'uses the declared capability',
          params: {},
          result: { type: 'string' },
          exposure: { peers: 'confirm' },
          execute: async (_args, ctx) => await ctx.capabilities.use('model', () => { used += 1; return 'answer' }),
        },
      },
    }))
    await runtime.register({
      ...app('caller', { calls: ['peer'] }),
      capabilities: ['model'],
      ops: {
        relay: {
          description: 'calls the peer as this application',
          params: {},
          result: { type: 'string' },
          execute: async (_args, ctx) => JSON.stringify(await ctx.call('peer', 'use', {})),
        },
      },
    })
    await runtime.grant({ caller: { kind: 'app', appId: 'caller' }, capabilities: [platformCapability('model')], grantedAt: '' })
    // The peer's use is checked against the PEER's declaration and grants, not
    // the caller's — the caller's model grant does not travel with the call,
    // and only the peer CALL itself was asked about (a use never asks).
    const outcome = await runtime.call(asUser, 'caller', 'relay', {})
    expect(used).toBe(0)
    expect(asked).toEqual(['peer#use'])
    expect(JSON.stringify(outcome)).toContain('capability-not-approved')
  })
})

describe('bounded history defaults', () => {
  it('works without options and flushes an idle queue', async () => {
    const written: string[] = []
    const queue = new BoundedHistoryQueue({ append: (records) => { written.push(...records.map((r) => r.callId)); return Promise.resolve() } })
    await queue.flush()
    queue.write({ callId: 'a', caller: asUser, target: 't', op: 'o', startedAt: '', endedAt: '', status: 'success' })
    await queue.flush()
    expect(written).toEqual(['a'])
    expect(queue.droppedCount).toBe(0)
  })
})
