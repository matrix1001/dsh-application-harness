/**
 * The additive contract layer: durable data descriptions and operation-level
 * peer declarations. These tests pin the registration checks and the one
 * permission path that reads the declared operation list.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ApplicationRuntime, assertDeclarable, declaredCallOps } from '../src/runtime.ts'
import type { AppDeclaration, Caller, OperationContext } from '../src/types.ts'

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
        exposure: { peers: 'open' },
        execute: (args) => (args as { text: string }).text,
      },
    },
    ...over,
  }
}

const asApp = (appId: string): Caller => ({ kind: 'app', appId })
const at = '2026-01-01T00:00:00.000Z'

describe('data declarations', () => {
  it('accepts the four data forms', () => {
    expect(() => assertDeclarable(app('none', { generation: 2, data: { kind: 'none' } }))).not.toThrow()
    expect(() => assertDeclarable(app('unified', {
      generation: 2,
      data: { kind: 'unified', namespace: 'unified', schemaVersion: 1, exportOp: 'echo', importOp: 'echo', secretFields: ['token'] },
    }))).not.toThrow()
    expect(() => assertDeclarable(app('own', {
      generation: 2,
      data: { kind: 'own-sqlite', path: 'own/index.db', schemaVersion: 2, backup: 'exclude' },
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
    expect(() => assertDeclarable(app('export', { generation: 2, data: { kind: 'unified', namespace: 'export', schemaVersion: 1, exportOp: 'nope' } }))).toThrow(/exportOp/u)
    expect(() => assertDeclarable(app('import', { generation: 2, data: { kind: 'unified', namespace: 'import', schemaVersion: 1, importOp: 'nope' } }))).toThrow(/importOp/u)
    expect(() => assertDeclarable(app('secret', { generation: 2, data: { kind: 'unified', namespace: 'secret', schemaVersion: 1, secretFields: [''] } }))).toThrow(/secretFields/u)
    expect(() => assertDeclarable(app('secret-dup', { generation: 2, data: { kind: 'unified', namespace: 'secret-dup', schemaVersion: 1, secretFields: ['a', 'a'] } }))).toThrow(/secretFields/u)
    expect(() => assertDeclarable(app('namespace', { generation: 2, data: { kind: 'unified', namespace: 'Bad Namespace', schemaVersion: 1 } }))).toThrow(/namespace/u)
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
    await runtime.register(app('first', { generation: 2, data: { kind: 'unified', namespace: 'shared', schemaVersion: 1 } }))
    await expect(runtime.register(app('second', { generation: 2, data: { kind: 'unified', namespace: 'shared', schemaVersion: 1 } }))).rejects.toThrow(/collides/u)
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
    await runtime.grant({ caller: asApp('caller'), capabilities: ['target#echo'], grantedAt: at })
    expect(await runtime.call(asApp('caller'), 'target', 'echo', { text: 'ok' })).toMatchObject({ status: 'success', result: 'ok' })

    await runtime.register(app('other', {
      calls: [{ app: 'target', ops: ['other'] }],
    }))
    await runtime.grant({ caller: asApp('other'), capabilities: ['target#echo'], grantedAt: at })
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
    await runtime.grant({ caller: asApp('alpha'), capabilities: ['beta#relay'], grantedAt: at })
    await runtime.grant({ caller: asApp('beta'), capabilities: ['alpha#relay'], grantedAt: at })
    const outcome = await runtime.call({ kind: 'human' }, 'alpha', 'relay', {})
    expect(outcome).toMatchObject({ status: 'success', result: { status: 'success', result: { status: 'rejected', error: { code: 'platform.call-cycle' } } } })
  })

  it('gates reads and writes to declared fields and refuses undeclared names', async () => {
    const values = new Map<string, string>()
    const runtime = new ApplicationRuntime({
      secrets: {
        names: async () => [...values.keys()],
        has: async (_appId, name) => values.has(name),
        get: async (_appId, name) => values.get(name),
        set: async (_appId, name, value) => { values.set(name, value) },
        delete: async (_appId, name) => values.delete(name),
      },
    })
    await runtime.register(app('keeper', {
      generation: 2,
      capabilities: ['storage'],
      data: { kind: 'unified', namespace: 'keeper', schemaVersion: 1, secretFields: ['token'] },
      ops: {
        probe: {
          description: 'probe',
          params: {},
          result: { type: 'json' },
          exposure: {},
          execute: async (_args, ctx) => {
            await ctx.secrets.set('token', 'value')
            const value = await ctx.secrets.get('token')
            return { has: await ctx.secrets.has('token'), ...(value === undefined ? {} : { value }), names: [...await ctx.secrets.names()] }
          },
        },
        bad: {
          description: 'bad',
          params: {},
          result: { type: 'json' },
          exposure: {},
          execute: (async (_args: unknown, ctx: OperationContext) => await ctx.secrets.get('other')) as never,
        },
      },
    }))
    await runtime.grant({ caller: asApp('keeper'), capabilities: ['capability:storage'], grantedAt: at })
    expect(await runtime.call({ kind: 'human' }, 'keeper', 'probe', {})).toMatchObject({ status: 'success', result: { has: true, value: 'value', names: ['token'] } })
    expect(await runtime.call({ kind: 'human' }, 'keeper', 'bad', {})).toMatchObject({ status: 'failed', error: { code: 'app.secret-undeclared' } })
  })
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

describe('application secrets without a host store', () => {
  it('reads unset defaults and refuses writes', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(app('keeper', {
      generation: 2,
      capabilities: ['storage'],
      data: { kind: 'unified', namespace: 'keeper', schemaVersion: 1, secretFields: ['token'] },
      ops: {
        probe: {
          description: 'probe',
          params: {},
          result: { type: 'json' },
          exposure: {},
          execute: async (_args, ctx) => ({
            names: [...await ctx.secrets.names()],
            has: await ctx.secrets.has('token'),
            value: await ctx.secrets.get('token') ?? null,
            deleted: await ctx.secrets.delete('token'),
            set: await ctx.secrets.set('token', 'x').then(() => 'ok', (error: Error) => error.message),
          }),
        },
      },
    }))
    await runtime.grant({ caller: asApp('keeper'), capabilities: ['capability:storage'], grantedAt: at })
    expect(await runtime.call({ kind: 'human' }, 'keeper', 'probe', {})).toMatchObject({
      status: 'success',
      result: { names: [], has: false, value: null, deleted: false, set: expect.stringContaining('no secret store') },
    })
  })

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
