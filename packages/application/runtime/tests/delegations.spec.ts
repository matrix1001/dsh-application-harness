import { describe, expect, it } from 'vitest'
import { ApplicationRuntime } from '../src/index.ts'
import type { AppDeclaration, AppDelegation, DelegationCreateInput, DelegationPort } from '../src/index.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const at = '2026-01-01T00:00:00.000Z'

/** One in-memory delegation record. */
function record(appId: string, id: string, over: Partial<AppDelegation> = {}): AppDelegation {
  return {
    id,
    appId,
    title: `title ${id}`,
    instructions: `instructions ${id}`,
    status: 'pending',
    createdAt: at,
    updatedAt: at,
    ...over,
  }
}

/** The fake host store the runtime binds; every method records the application it spoke for. */
function fakePort(): { port: DelegationPort; calls: string[]; store: Map<string, AppDelegation> } {
  const store = new Map<string, AppDelegation>()
  const calls: string[] = []
  let serial = 0
  const port: DelegationPort = {
    create: async (appId, input: DelegationCreateInput) => {
      calls.push(`create:${appId}`)
      const created = record(appId, `delegation-${String(++serial)}`, { title: input.title, instructions: input.instructions })
      store.set(created.id, created)
      return created
    },
    list: async (appId) => {
      calls.push(`list:${appId}`)
      return [...store.values()].filter(entry => entry.appId === appId)
    },
    read: async (appId, id) => {
      calls.push(`read:${appId}:${id}`)
      const found = store.get(id)
      return found !== undefined && found.appId === appId ? found : undefined
    },
    cancel: async (appId, id) => {
      calls.push(`cancel:${appId}:${id}`)
      const found = store.get(id)
      if (found === undefined || found.appId !== appId) throw new Error(`no delegation ${id}`)
      const ended: AppDelegation = { ...found, status: 'ended', outcome: 'cancelled', updatedAt: at }
      store.set(id, ended)
      return ended
    },
  }
  return { port, calls, store }
}

/** One application whose operations use its delegation port. */
function delegationApp(id = 'ledger', over: Partial<AppDeclaration> = {}): AppDeclaration {
  return {
    id,
    name: id,
    description: 'delegation applicant',
    version: '1.0.0',
    capabilities: ['delegate'],
    ops: {
      prepare: {
        description: 'prepare',
        params: { title: { type: 'string', required: true }, instructions: { type: 'string', required: true } },
        result: { type: 'json' },
        exposure: { ai: 'open' },
        execute: async (args, ctx) => (await ctx.delegations.create(args as unknown as DelegationCreateInput)) as unknown as JsonValue,
      },
      list: {
        description: 'list',
        params: {},
        result: { type: 'json' },
        effect: 'read',
        execute: async (_args, ctx) => (await ctx.delegations.list()) as unknown as JsonValue,
      },
      read: {
        description: 'read',
        params: { id: { type: 'string', required: true } },
        result: { type: 'json' },
        effect: 'read',
        execute: async (args, ctx) => ((await ctx.delegations.read((args as { id: string }).id)) ?? null) as unknown as JsonValue,
      },
      cancel: {
        description: 'cancel',
        params: { id: { type: 'string', required: true } },
        result: { type: 'json' },
        execute: async (args, ctx) => (await ctx.delegations.cancel((args as { id: string }).id)) as unknown as JsonValue,
      },
    },
    ...over,
  }
}

/** Grant one application the delegate capability. */
async function approve(runtime: ApplicationRuntime, appId = 'ledger'): Promise<void> {
  await runtime.grant({ caller: { kind: 'app', appId }, capabilities: ['capability:delegate'], grantedAt: at })
}

describe('the runtime delegation port', () => {
  it('binds the application identity and checks the declared delegation capability before the port runs', async () => {
    const { port, calls } = fakePort()
    const runtime = new ApplicationRuntime({ delegations: port })
    await runtime.register(delegationApp())

    // Not approved yet: the use fails closed and the host store never hears it.
    expect(await runtime.call({ kind: 'human' }, 'ledger', 'prepare', { title: 't', instructions: 'i' }))
      .toMatchObject({ status: 'failed', error: { code: 'app.capability-not-approved' } })
    expect(calls).toEqual([])

    await approve(runtime)
    const created = await runtime.call({ kind: 'human' }, 'ledger', 'prepare', { title: 't', instructions: 'i' })
    expect(created).toMatchObject({ status: 'success', result: { appId: 'ledger', title: 't', instructions: 'i', status: 'pending' } })
    expect(await runtime.call({ kind: 'human' }, 'ledger', 'list', {})).toMatchObject({ status: 'success', result: [{ status: 'pending' }] })
    const id = created.status === 'success' ? (created.result as { id: string }).id : ''
    expect(await runtime.call({ kind: 'human' }, 'ledger', 'read', { id })).toMatchObject({ status: 'success', result: { id } })
    expect(await runtime.call({ kind: 'human' }, 'ledger', 'cancel', { id })).toMatchObject({ status: 'success', result: { status: 'ended', outcome: 'cancelled' } })
    // Every host call was made for the application the runtime recorded, never a caller-supplied id.
    expect(calls).toEqual([`create:ledger`, `list:ledger`, `read:ledger:${id}`, `cancel:ledger:${id}`])
  })

  it('refuses an application that never declared delegate, and an AI caller uses the application grant', async () => {
    const { port } = fakePort()
    const undeclared = new ApplicationRuntime({ delegations: port })
    await undeclared.register(delegationApp('plain', { capabilities: [] }))
    expect(await undeclared.call({ kind: 'human' }, 'plain', 'prepare', { title: 't', instructions: 'i' }))
      .toMatchObject({ status: 'failed', error: { code: 'app.capability-undeclared' } })

    const runtime = new ApplicationRuntime({ delegations: port })
    await runtime.register(delegationApp())
    await approve(runtime)
    expect(await runtime.call({ kind: 'ai', sessionId: 'session-1' }, 'ledger', 'prepare', { title: 't', instructions: 'i' }))
      .toMatchObject({ status: 'success', result: { appId: 'ledger' } })
  })

  it('reads and cancels only the application’s own records', async () => {
    const { port, store } = fakePort()
    const runtime = new ApplicationRuntime({ delegations: port })
    await runtime.register(delegationApp('ledger'))
    await runtime.register(delegationApp('other'))
    await approve(runtime, 'ledger')
    await approve(runtime, 'other')
    const created = await runtime.call({ kind: 'human' }, 'ledger', 'prepare', { title: 't', instructions: 'i' })
    const id = created.status === 'success' ? (created.result as { id: string }).id : ''
    expect(await runtime.call({ kind: 'human' }, 'other', 'read', { id })).toMatchObject({ status: 'success', result: null })
    expect(await runtime.call({ kind: 'human' }, 'other', 'cancel', { id })).toMatchObject({ status: 'failed' })
    expect(store.get(id)).toMatchObject({ appId: 'ledger', status: 'pending' })
  })

  it('fails closed when no store is mounted and stops using the port after a revoke', async () => {
    const { port, calls } = fakePort()
    const bare = new ApplicationRuntime()
    await bare.register(delegationApp())
    await approve(bare)
    expect(await bare.call({ kind: 'human' }, 'ledger', 'prepare', { title: 't', instructions: 'i' }))
      .toMatchObject({ status: 'failed', error: { code: 'app.delegation-unavailable' } })

    const runtime = new ApplicationRuntime({ delegations: port })
    await runtime.register(delegationApp())
    await approve(runtime)
    expect(await runtime.call({ kind: 'human' }, 'ledger', 'prepare', { title: 't', instructions: 'i' })).toMatchObject({ status: 'success' })
    const before = calls.length
    await runtime.revoke({ kind: 'app', appId: 'ledger' }, 'capability:delegate')
    expect(await runtime.call({ kind: 'human' }, 'ledger', 'prepare', { title: 't', instructions: 'i' }))
      .toMatchObject({ status: 'failed', error: { code: 'app.capability-not-approved' } })
    expect(calls.length).toBe(before)
  })

  it('binds the port into the lifecycle AppContext too', async () => {
    const { port, calls } = fakePort()
    const runtime = new ApplicationRuntime({ delegations: port })
    await approve(runtime)
    const seen: AppDelegation[] = []
    await runtime.register(delegationApp('ledger', {
      start: async (ctx) => {
        seen.push(await ctx.delegations.create({ title: 'from start', instructions: 'lifecycle' }))
      },
    }))
    expect(seen).toMatchObject([{ appId: 'ledger', title: 'from start', status: 'pending' }])
    expect(calls).toEqual(['create:ledger'])
  })

  it('does not treat a lost registration as a capability grant', async () => {
    const { port } = fakePort()
    const runtime = new ApplicationRuntime({ delegations: port })
    await runtime.register(delegationApp(), { activation: 'disabled' })
    await approve(runtime)
    const outcome = await runtime.call({ kind: 'human' }, 'ledger', 'prepare', { title: 't', instructions: 'i' })
    expect(outcome).toMatchObject({ status: 'rejected', error: { code: 'platform.unavailable' } })
  })
})
