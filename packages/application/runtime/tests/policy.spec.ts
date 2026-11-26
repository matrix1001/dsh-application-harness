import { describe, expect, it } from 'vitest'
import { ApplicationRuntime } from '../src/index.ts'
import type { AppDeclaration, OperationPolicyEntry, PolicyStorePort } from '../src/index.ts'

function app(id: string, exposure: { ai?: 'closed' | 'open' | 'confirm'; peers?: 'closed' | 'open' | 'confirm' }): AppDeclaration {
  return {
    id, name: id, description: id, version: '1.0.0',
    ops: {
      echo: {
        description: 'echo',
        params: { text: { type: 'string', required: true } },
        result: { type: 'string' },
        exposure,
        execute: (args) => (args as { text: string }).text,
      },
    },
  }
}

function memoryStore(initial: readonly OperationPolicyEntry[] = []): PolicyStorePort & { entries: OperationPolicyEntry[] } {
  const state = { entries: [...initial] }
  return {
    entries: state.entries,
    list: async () => [...state.entries],
    save: async (entries) => { state.entries = [...entries] },
  }
}

describe('operation policy', () => {
  it('never lets a user policy open an operation the author closed', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(app('closed', {}))
    await expect(runtime.setPolicy('closed', 'echo', 'allow')).rejects.toThrow(/not open/u)
    expect(await runtime.call({ kind: 'ai', sessionId: 's' }, 'closed', 'echo', { text: 'x' }))
      .toMatchObject({ status: 'rejected', error: { code: 'platform.not-open-to-caller' } })
  })

  it('overrides an author confirm for AI without asking', async () => {
    let asked = 0
    const runtime = new ApplicationRuntime({ confirm: { ask: async () => { asked += 1; return 'denied' } } })
    await runtime.register(app('guarded', { ai: 'confirm' }))
    await runtime.setPolicy('guarded', 'echo', 'allow')
    expect(await runtime.call({ kind: 'ai', sessionId: 's' }, 'guarded', 'echo', { text: 'x' }))
      .toMatchObject({ status: 'success' })
    expect(asked).toBe(0)
  })

  it('asks when the user policy requires confirmation even if the author opened the operation', async () => {
    let asked = 0
    const runtime = new ApplicationRuntime({ confirm: { ask: async () => { asked += 1; return 'allowed-once' } } })
    await runtime.register(app('open', { ai: 'open' }))
    await runtime.setPolicy('open', 'echo', 'confirm')
    expect(await runtime.call({ kind: 'ai', sessionId: 's' }, 'open', 'echo', { text: 'x' }))
      .toMatchObject({ status: 'success' })
    expect(asked).toBe(1)
  })

  it('keeps the previous table when the policy store cannot save', async () => {
    const failing: PolicyStorePort = { list: async () => [], save: async () => { throw new Error('disk full') } }
    const runtime = new ApplicationRuntime({ policies: failing })
    await runtime.register(app('open', { ai: 'open' }))
    await expect(runtime.setPolicy('open', 'echo', 'forbid')).rejects.toThrow(/disk full/u)
    expect(await runtime.policyOf('open', 'echo')).toBe('default')
  })

  it('reads the policy table through the store on each call', async () => {
    const store = memoryStore()
    const runtime = new ApplicationRuntime({ policies: store })
    await runtime.register(app('open', { ai: 'open' }))
    await runtime.setPolicy('open', 'echo', 'forbid')
    expect(await runtime.call({ kind: 'ai', sessionId: 's' }, 'open', 'echo', { text: 'x' }))
      .toMatchObject({ status: 'rejected', error: { code: 'platform.denied' } })
    expect(await store.list()).toMatchObject([{ appId: 'open', operation: 'echo', policy: 'forbid', updatedAt: expect.any(String) }])
  })
})

describe('operation policy validation and read failures', () => {
  it('refuses an unknown application or operation, and a failed policy read rejects the call', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(app('open', { ai: 'open' }))
    await expect(runtime.setPolicy('missing', 'echo', 'allow')).rejects.toThrow(/no application/u)
    await expect(runtime.setPolicy('open', 'missing', 'allow')).rejects.toThrow(/no operation/u)
    const failing: PolicyStorePort = { list: async () => { throw new Error('corrupt policy table') }, save: async () => {} }
    const strict = new ApplicationRuntime({ policies: failing })
    await strict.register(app('open', { ai: 'open' }))
    await expect(strict.call({ kind: 'ai', sessionId: 's' }, 'open', 'echo', { text: 'x' })).resolves.toMatchObject({
      status: 'failed', error: { code: 'app.authorization-unavailable' },
    })
  })
})

describe('registration health and lifecycle', () => {
  it('reports health/reason and notifies lifecycle listeners', async () => {
    const runtime = new ApplicationRuntime()
    const seen: string[] = []
    const off = runtime.onLifecycle(({ appId }) => { seen.push(appId) })
    await runtime.register({ ...app('broken', { ai: 'open' }), start: () => { throw new Error('no storage') } })
    const registration = runtime.list()[0]!
    expect(registration.health()).toBe('degraded')
    expect(registration.reason()).toBe('platform.start-failed')
    expect(registration.detail()).toBe('no storage')
    expect(seen).toContain('broken')
    off()
    const before = seen.length
    await runtime.stop('broken')
    expect(seen).toHaveLength(before)

    const mounted = runtime.mount(app('mounted', { ai: 'open' }))
    expect(mounted.health()).toBe('ok')
    expect(mounted.reason()).toBeUndefined()
    await runtime.stop('mounted')
    runtime.unregister('mounted')
  })
})

describe('policy store replacement during a save', () => {
  it('does not publish a change computed against the replaced store', async () => {
    const second: PolicyStorePort = { list: async () => [], save: async () => {} }
    let runtime: ApplicationRuntime
    const first: PolicyStorePort = {
      list: async () => [],
      save: async () => { runtime.usePolicyStore(second) },
    }
    runtime = new ApplicationRuntime({ policies: first })
    await runtime.register(app('open', { ai: 'open' }))
    await runtime.setPolicy('open', 'echo', 'forbid')
    // The new store owns later reads; the old change is not published into it.
    expect(await runtime.policyOf('open', 'echo')).toBe('default')
  })
})
