import { describe, expect, it } from 'vitest'
import { ApplicationRuntime } from '../src/index.ts'
import type { AppDeclaration } from '../src/index.ts'

function app(over: Partial<AppDeclaration> = {}): AppDeclaration {
  return {
    id: 'activation', name: 'Activation', description: 'activation test', version: '1.0.0',
    ops: { echo: { description: 'echo', params: { text: { type: 'string', required: true } }, result: { type: 'string' }, execute: args => (args as { text: string }).text } },
    ...over,
  }
}

describe('activation', () => {
  it('honours the pre-read activation snapshot before any host reconciler runs', async () => {
    let starts = 0
    const runtime = new ApplicationRuntime({ activation: { disabled: ['activation'] } })
    const registration = runtime.mount(app({ start: () => { starts += 1 } }))
    await Promise.resolve()
    expect(registration.activation()).toBe('disabled')
    expect(registration.status()).toBe('stopped')
    expect(starts).toBe(0)
  })

  it('disables every application when the pre-read activation table failed', async () => {
    let starts = 0
    const runtime = new ApplicationRuntime({ activation: { disabled: [], failure: 'corrupt' } })
    const registration = runtime.mount(app({ start: () => { starts += 1 } }))
    await Promise.resolve()
    expect(registration.activation()).toBe('disabled')
    expect(starts).toBe(0)
  })

  it('still starts an application absent from a successful pre-read snapshot', async () => {
    let starts = 0
    const runtime = new ApplicationRuntime({ activation: { disabled: [] } })
    const registration = runtime.mount(app({ start: () => { starts += 1 } }))
    await Promise.resolve()
    expect(registration.activation()).toBe('enabled')
    expect(starts).toBe(1)
  })

  it('mounts disabled without starting, and refuses calls and tasks', async () => {
    let starts = 0
    const runtime = new ApplicationRuntime()
    const registration = runtime.mount(app({ start: () => { starts += 1 } }), { activation: 'disabled' })
    expect(registration.activation()).toBe('disabled')
    expect(runtime.list()[0]!.activation()).toBe('disabled')
    expect(registration.status()).toBe('stopped')
    await Promise.resolve()
    expect(starts).toBe(0)
    expect(await runtime.call({ kind: 'human' }, 'activation', 'echo', { text: 'x' }))
      .toMatchObject({ status: 'rejected', error: { code: 'platform.unavailable' } })
    await expect(runtime.setActivation('missing', 'enabled')).rejects.toThrow(/not registered/u)
  })

  it('enables and disables without touching data or permissions', async () => {
    let starts = 0
    let stops = 0
    const runtime = new ApplicationRuntime()
    const registration = runtime.register(app({
      start: () => { starts += 1 },
      stop: () => { stops += 1 },
    }), { activation: 'disabled' })
    const reg = await registration
    await runtime.setActivation('activation', 'enabled')
    expect(reg.activation()).toBe('enabled')
    expect(reg.status()).toBe('available')
    expect(starts).toBe(1)
    expect(reg.activation()).toBe('enabled')
    await runtime.setActivation('activation', 'enabled')
    expect(reg.status()).toBe('available')
    expect(await runtime.call({ kind: 'human' }, 'activation', 'echo', { text: 'x' }))
      .toMatchObject({ status: 'success', result: 'x' })
    await runtime.setActivation('activation', 'disabled')
    expect(reg.activation()).toBe('disabled')
    expect(reg.status()).toBe('stopped')
    expect(stops).toBe(1)
    expect(await runtime.call({ kind: 'human' }, 'activation', 'echo', { text: 'x' }))
      .toMatchObject({ status: 'rejected', error: { code: 'platform.unavailable' } })
    // Both directions are idempotent.
    await runtime.setActivation('activation', 'disabled')
    await runtime.setActivation('activation', 'enabled')
    expect(reg.status()).toBe('available')
  })

  it('retries a failed start after a disable/enable cycle', async () => {
    let attempts = 0
    const runtime = new ApplicationRuntime()
    await runtime.register(app({ start: () => { attempts += 1; if (attempts === 1) throw new Error('first start fails') } }))
    expect(runtime.list()[0]!.status()).toBe('failed')
    await runtime.setActivation('activation', 'disabled')
    expect(runtime.list()[0]!.status()).toBe('failed')
    await runtime.setActivation('activation', 'enabled')
    expect(runtime.list()[0]!.status()).toBe('available')
    expect(attempts).toBe(2)
  })

  it('refuses to enable an application whose stop is still incomplete', async () => {
    const runtime = new ApplicationRuntime({ stopBudgetMs: 1 })
    runtime.mount(app({
      start: () => new Promise(() => {}),
    }))
    // The start hook above never settles; stop it and hit the budget.
    const stopping = runtime.setActivation('activation', 'disabled')
    await stopping
    expect(runtime.list()[0]!.status()).toBe('stop-incomplete')
    await expect(runtime.setActivation('activation', 'enabled')).rejects.toThrow(/wait for its work/u)
  })
})
