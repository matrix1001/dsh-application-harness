import { describe, expect, it } from 'vitest'
import { ApplicationRuntime } from '../src/index.ts'
import type { AppDeclaration } from '../src/index.ts'

function devApp(): AppDeclaration {
  return {
    id: 'dev', name: 'Dev', description: 'development target', version: '1.0.0',
    ops: {
      write: { description: 'write', params: {}, result: { type: 'json' }, exposure: { ai: 'open' }, execute: () => ({ wrote: true }) },
      read: { description: 'read', params: {}, result: { type: 'json' }, exposure: { ai: 'open' }, effect: 'read', execute: () => ({ read: true }) },
    },
  }
}

describe('development sessions', () => {
  it('forces one confirmation per write even when the user policy allows it', async () => {
    let asked = 0
    const runtime = new ApplicationRuntime({ confirm: { ask: async () => { asked += 1; return 'allowed-once' } } })
    await runtime.register(devApp())
    await runtime.setPolicy('dev', 'write', 'allow')
    const caller = { kind: 'ai' as const, sessionId: 'dev-session', developmentApp: 'dev' }
    expect(await runtime.call(caller, 'dev', 'write', {})).toMatchObject({ status: 'success' })
    expect(asked).toBe(1)
    // The previous one-off answer is not a development-session bypass.
    expect(await runtime.call(caller, 'dev', 'write', {})).toMatchObject({ status: 'success' })
    expect(asked).toBe(2)
    // Reads keep the ordinary policy and do not ask.
    expect(await runtime.call(caller, 'dev', 'read', {})).toMatchObject({ status: 'success' })
    expect(asked).toBe(2)
  })

  it('fails closed when a development write has no confirmation channel', async () => {
    const runtime = new ApplicationRuntime()
    await runtime.register(devApp())
    await runtime.setPolicy('dev', 'write', 'allow')
    expect(await runtime.call({ kind: 'ai', sessionId: 'dev-session', developmentApp: 'dev' }, 'dev', 'write', {}))
      .toMatchObject({ status: 'rejected', error: { code: 'platform.confirmation-unavailable' } })
  })

  it('does not force confirmation for another application', async () => {
    let asked = 0
    const runtime = new ApplicationRuntime({ confirm: { ask: async () => { asked += 1; return 'allowed-once' } } })
    await runtime.register(devApp())
    await runtime.register({ ...devApp(), id: 'other' })
    await runtime.setPolicy('other', 'write', 'allow')
    expect(await runtime.call({ kind: 'ai', sessionId: 'dev-session', developmentApp: 'dev' }, 'other', 'write', {}))
      .toMatchObject({ status: 'success' })
    expect(asked).toBe(0)
  })
})
