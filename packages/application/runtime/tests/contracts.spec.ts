/**
 * The additive contract layer: durable data descriptions and operation-level
 * peer declarations. These tests pin the registration checks and the one
 * permission path that reads the declared operation list.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ApplicationRuntime, assertDeclarable, declaredCallOps } from '../src/runtime.ts'
import type { AppDeclaration, Caller } from '../src/types.ts'

function app(id: string, over: Partial<AppDeclaration> = {}): AppDeclaration {
  return {
    id,
    name: id,
    description: `${id} app`,
    version: '1.0.0',
    ops: {
      echo: {
        description: 'echo',
        params: { text: { type: 'string', required: true } },
        result: { type: 'string' },
        effect: 'read',
        exposure: { peers: 'open' },
        execute: (args) => (args as { text: string }).text,
      },
    },
    ...over,
  }
}

const asApp = (appId: string): Caller => ({ kind: 'app', appId })

describe('operation declarations', () => {
  it('requires generation 2 operations to declare effect and leaves generation 1 on the write default', () => {
    const { effect: _effect, ...withoutEffect } = app('no-effect').ops.echo!
    const ops = { echo: withoutEffect }
    expect(() => assertDeclarable(app('no-effect', { generation: 2, data: { kind: 'none' }, ops }))).toThrow(/must declare effect/u)
    expect(() => assertDeclarable(app('legacy', { ops }))).not.toThrow()
  })
})

describe('data declarations', () => {
  it('accepts the four data forms', () => {
    expect(() => assertDeclarable(app('none', { generation: 2, data: { kind: 'none' } }))).not.toThrow()
    expect(() => assertDeclarable(app('unified', {
      generation: 2,
      data: { kind: 'unified', namespace: 'unified', schemaVersion: 1 },
    }))).not.toThrow()
    expect(() => assertDeclarable(app('own', {
      generation: 2,
      data: { kind: 'own-sqlite', path: 'own/index.db', schemaVersion: 2 },
    }))).not.toThrow()
    expect(() => assertDeclarable(app('files', {
      generation: 2,
      data: { kind: 'files', path: 'files', schemaVersion: 1 },
    }))).not.toThrow()
  })

  it('refuses a generation 2 app without data', () => {
    expect(() => assertDeclarable(app('missing', { generation: 2 }))).toThrow(/must declare data/u)
    expect(() => assertDeclarable(app('bad-generation', { generation: 0 }))).toThrow(/positive integer/u)
    expect(() => assertDeclarable(app('bad-generation-two', { generation: 1.5 }))).toThrow(/positive integer/u)
  })

  it('refuses malformed data fields', () => {
    expect(() => assertDeclarable(app('none-fields', { generation: 2, data: { kind: 'none', namespace: 'x' } }))).toThrow(/cannot carry storage fields/u)
    expect(() => assertDeclarable(app('schema', { generation: 2, data: { kind: 'unified', namespace: 'schema' } }))).toThrow(/schemaVersion/u)
    expect(() => assertDeclarable(app('schema-zero', { generation: 2, data: { kind: 'own-sqlite', path: 'x', schemaVersion: 0 } }))).toThrow(/schemaVersion/u)
    expect(() => assertDeclarable(app('namespace', { generation: 2, data: { kind: 'unified', namespace: 'Bad Namespace', schemaVersion: 1 } }))).toThrow(/namespace/u)
    expect(() => assertDeclarable(app('other-id', { generation: 2, data: { kind: 'unified', namespace: 'different', schemaVersion: 1 } }))).toThrow(/must equal/u)
  })

  it('refuses a unified description with a path and an own description without one', () => {
    expect(() => assertDeclarable(app('u-path', { generation: 2, data: { kind: 'unified', namespace: 'u-path', path: 'x', schemaVersion: 1 } }))).toThrow(/requires a namespace and no path/u)
    expect(() => assertDeclarable(app('u-no-ns', { generation: 2, data: { kind: 'unified', schemaVersion: 1 } }))).toThrow(/requires a namespace and no path/u)
    expect(() => assertDeclarable(app('o-no-path', { generation: 2, data: { kind: 'own-sqlite', schemaVersion: 1 } }))).toThrow(/requires a path and no namespace/u)
    expect(() => assertDeclarable(app('o-ns', { generation: 2, data: { kind: 'own-sqlite', namespace: 'o-ns', path: 'x', schemaVersion: 1 } }))).toThrow(/requires a path and no namespace/u)
  })

  it('refuses absolute, parent and empty own paths', () => {
    for (const path of ['/tmp/x', '../x', 'a/../b', '', 'a\\b']) {
      expect(() => assertDeclarable(app(`p-${String(path.length)}`, { generation: 2, data: { kind: 'own-sqlite', path, schemaVersion: 1 } }))).toThrow(/relative path/u)
    }
  })

  it('refuses two applications sharing a data location', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(app('none', { generation: 2, data: { kind: 'none' } }))
    await runtime.register(app('own-first', { generation: 2, data: { kind: 'own-sqlite', path: 'x', schemaVersion: 1 } }))
    await expect(runtime.register(app('own-second', { generation: 2, data: { kind: 'files', path: 'x', schemaVersion: 1 } }))).rejects.toThrow(/collides/u)
  })
})

describe('operation-level calls', () => {
  it('reads legacy and explicit declarations', () => {
    expect(declaredCallOps(app('a', { calls: ['b'] }), 'b')).toBe('all')
    expect(declaredCallOps(app('a', { calls: [{ app: 'b', ops: ['echo'] }] }), 'b')).toEqual(['echo'])
    expect(declaredCallOps(app('a'), 'b')).toBeUndefined()
  })

  it('allows only the declared operation', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(app('target'))
    await runtime.register(app('caller', { calls: [{ app: 'target', ops: ['echo'] }] }))
    expect(await runtime.call(asApp('caller'), 'target', 'echo', { text: 'ok' })).toMatchObject({ status: 'success', result: 'ok' })

    await runtime.register(app('other', {
      calls: [{ app: 'target', ops: ['other'] }],
    }))
    expect(await runtime.call(asApp('other'), 'target', 'echo', { text: 'no' })).toMatchObject({ status: 'rejected', error: { code: 'platform.not-open-to-caller' } })
  })

  it('refuses malformed or duplicate call declarations', () => {
    expect(() => assertDeclarable(app('self', { calls: [{ app: 'self', ops: ['echo'] }] }))).toThrow(/call to itself/u)
    expect(() => assertDeclarable(app('empty', { calls: [{ app: 'x', ops: [] }] }))).toThrow(/no operations/u)
    expect(() => assertDeclarable(app('dup-op', { calls: [{ app: 'x', ops: ['echo', 'echo'] }] }))).toThrow(/repeats/u)
    expect(() => assertDeclarable(app('bad-op', { calls: [{ app: 'x', ops: ['1bad'] }] }))).toThrow(/malformed operation/u)
    expect(() => assertDeclarable(app('dup-app', { calls: [{ app: 'x', ops: ['echo'] }, 'x'] }))).toThrow(/more than once/u)
    expect(() => assertDeclarable(app('bad-app', { calls: ['Bad App'] }))).toThrow(/malformed call target/u)
  })
})

describe('peer call safety', () => {
  const peerApp = (id: string, calls: NonNullable<AppDeclaration['calls']>, run: (ctx: { call: (target: string, op: string, args: Record<string, never>) => Promise<unknown> }) => Promise<unknown>): AppDeclaration => ({
    id,
    name: id,
    description: `${id} app`,
    version: '1.0.0',
    calls,
    ops: {
      relay: {
        description: 'relay',
        params: {},
        result: { type: 'json' },
        exposure: { peers: 'open' },
        execute: async (_args, ctx) => await run(ctx) as never,
      },
    },
  })

  it('refuses a peer cycle before it can recurse', async () => {
    const runtime = new ApplicationRuntime()
    const a = peerApp('alpha', [{ app: 'beta', ops: ['relay'] }], async ctx => await ctx.call('beta', 'relay', {}))
    const b = peerApp('beta', [{ app: 'alpha', ops: ['relay'] }], async ctx => await ctx.call('alpha', 'relay', {}))
    await runtime.register(a)
    await runtime.register(b)
    const outcome = await runtime.call({ kind: 'human' }, 'alpha', 'relay', {})
    expect(outcome).toMatchObject({ status: 'success', result: { status: 'success', result: { status: 'rejected', error: { code: 'platform.call-cycle' } } } })
  })

})

  it('carries the source call chain into a background task', async () => {
    const runtime = new ApplicationRuntime()
    const alpha: AppDeclaration = {
      id: 'alpha', name: 'alpha', description: 'alpha app', version: '1.0.0',
      calls: [{ app: 'beta', ops: ['relay'] }],
      ops: {
        relay: {
          description: 'relay', params: {}, result: { type: 'json' }, exposure: { peers: 'open' },
          execute: async (_args, ctx) => ({ status: (await ctx.call('beta', 'relay', {})).status }),
        },
      },
    }
    const beta: AppDeclaration = {
      id: 'beta', name: 'beta', description: 'beta app', version: '1.0.0',
      calls: [{ app: 'alpha', ops: ['relay'] }],
      ops: {
        relay: {
          description: 'relay', params: {}, result: { type: 'json' }, exposure: { peers: 'open' },
          execute: async (_args, ctx) => {
            const handle = ctx.startTask({ kind: 'trace', title: 'trace' }, async task => {
              const outcome = await task.call('alpha', 'relay', {})
              return { code: outcome.status === 'rejected' ? outcome.error?.code ?? '' : outcome.status }
            })
            await handle.done
            return { done: true }
          },
        },
      },
    }
    await runtime.register(alpha)
    await runtime.register(beta)
    expect(await runtime.call({ kind: 'human' }, 'alpha', 'relay', {})).toMatchObject({ status: 'success' })
    expect(runtime.tasks('beta')).toMatchObject([
      { state: 'succeeded', resultSummary: { code: 'platform.call-cycle' } },
    ])
  })

describe('peer call depth', () => {
  it('refuses a chain at the configured nesting limit', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(app('deep'))
    const chain = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    expect(await runtime.call({ kind: 'human' }, 'deep', 'echo', { text: 'x' }, undefined, undefined, chain))
      .toMatchObject({ status: 'rejected', error: { code: 'platform.call-depth' } })
  })
})

describe('calls without a contract', () => {
  it('walks a caller with no calls to its target without a contract', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(app('target'))
    await runtime.register(app('caller'))
    expect(await runtime.call(asApp('caller'), 'target', 'echo', { text: 'x' })).toMatchObject({ status: 'rejected', error: { code: 'platform.not-open-to-caller' } })
  })
})

describe('mount helpers', () => {
  it('refuses to mount without the runtime service', async () => {
    const { mountApplication } = await import('../src/index.ts')
    const ctx = new Context()
    await expect(mountApplication(ctx, app('orphan'))).rejects.toThrow(/application runtime/u)
    await ctx.fiber.dispose()
  })
})
